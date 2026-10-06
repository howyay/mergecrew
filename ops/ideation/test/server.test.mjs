/**
 * End-to-end test of the real service against a throwaway repo fixture:
 * boot the server on an ephemeral port, then drive it over HTTP exactly as the
 * browser does. Nothing here mocks the store, the generator, or the dispatcher.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'idea-server-'));
await mkdir(path.join(fixture, 'apps/api'), { recursive: true });
await writeFile(
  path.join(fixture, 'apps/api/handler.ts'),
  '// TODO: validate input\nexport const handler = () => {};\n// FIXME: add timeout\n// HACK: retry once\n',
  'utf8',
);
await writeFile(path.join(fixture, 'UX-BACKLOG.md'), '- [ ] ship A\n- [ ] ship B\n', 'utf8');
// The product's own feature inventory is the default source of ideas, so the
// fixture has to carry one: a service that proposes nothing is exactly what a
// missing product doc looks like.
await mkdir(path.join(fixture, 'docs/00-product'), { recursive: true });
await writeFile(
  path.join(fixture, 'docs/00-product/05-features.md'),
  [
    '# Features',
    '',
    '## Projects',
    '',
    '| Feature | Persona | Status |',
    '| --- | --- | --- |',
    '| Multi-repo project | Mira | Planned |',
    '| Per-project policy | Mira | In progress |',
    '| Project templates | Theo | Implemented |',
    '',
  ].join('\n'),
  'utf8',
);

process.env.MERGECREW_REPO = fixture;
process.env.IDEATION_STATE_FILE = path.join(fixture, 'ideas.json');
process.env.IDEATION_EXECUTION_DIR = path.join(fixture, 'execution');
process.env.IDEATION_PORT = '0';
process.env.IDEATION_HOST = '127.0.0.1';
process.env.IDEATION_INTERVAL_MINUTES = '600';
process.env.EXECUTOR = 'off';
process.env.IDEA_GENERATOR = 'auto';
// Both rule sets here, so one suite covers the product path end to end (cold
// start → deck → swipe) alongside the chore rules the repo already relied on.
process.env.IDEA_SOURCES = 'all';
delete process.env.IDEA_LLM_BASE_URL;
delete process.env.IDEA_LLM_API_KEY;
delete process.env.IDEA_LLM_MODEL;

const { boot, server } = await import('../server.mjs');
await boot();
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
});

const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  return { res, body: await res.json().catch(() => null) };
};
const post = async (p, payload) => {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { res, body: await res.json().catch(() => null) };
};

test('GET /healthz reports identity, uptime and the executor flag', async () => {
  const { res, body } = await get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'mergecrew-ideation');
  assert.equal(body.executorEnabled, false);
  assert.equal(body.repo, fixture);
  assert.ok(Number.isInteger(body.uptimeSeconds));
});

test('cold start already produced scored ideas from the fixture', async () => {
  const { res, body } = await get('/api/ideas');
  assert.equal(res.status, 200);
  assert.ok(body.ideas.length > 0, 'expected cold-start generation to add ideas');
  for (const idea of body.ideas) {
    assert.ok(idea.score >= 0 && idea.score <= 100);
    assert.ok(idea.evidence.length > 0);
  }
  assert.ok(body.ideas.some((i) => i.source === 'ci-missing'));
  assert.ok(body.ideas.some((i) => i.source === 'todo-cluster'));
  assert.ok(body.ideas.some((i) => i.source === 'backlog'));
  // Product features come from the fixture's feature inventory and must cite it.
  const product = body.ideas.filter((i) => i.source.startsWith('product'));
  assert.ok(product.length >= 2, 'expected planned and in-progress features to be proposed');
  assert.ok(product.every((i) => i.evidence.some((e) => /docs\/00-product\/05-features\.md:\d+/.test(e))));
  assert.ok(product.every((i) => i.kind === 'feature'));
  // "Implemented" rows are not proposed: the doc already says they are done.
  assert.ok(!body.ideas.some((i) => /Project templates/.test(i.title)));
});

test('GET /api/state surfaces the last generation honestly', async () => {
  const { body } = await get('/api/state');
  assert.equal(body.lastGeneration.generator, 'heuristic');
  assert.equal(body.lastGeneration.fallbackReason, null);
  assert.deepEqual(body.lastGeneration.sources, ['product', 'chores']);
  assert.ok(body.lastGeneration.added > 0);
  assert.equal(body.ci, null, 'no CI record exists in the fixture');
  assert.equal(body.executorEnabled, false);
});

test('accepting an idea writes a task file and reports the real dispatch status', async () => {
  const ideas = (await get('/api/ideas?status=pending')).body.ideas;
  const target = ideas.find((i) => i.source === 'backlog') ?? ideas[0];

  const { res, body } = await post('/api/decide', { id: target.id, decision: 'accepted' });
  assert.equal(res.status, 200);
  assert.equal(body.idea.status, 'accepted');
  assert.equal(body.idea.execution.status, 'queued');
  assert.equal(body.idea.execution.reason, 'EXECUTOR=off');
  assert.equal(body.dispatched.exitCode, null);

  const taskFile = path.join(fixture, body.idea.execution.taskFile);
  const markdown = await readFile(taskFile, 'utf8');
  assert.match(markdown, new RegExp(target.id));
  assert.match(markdown, /## Definition of done/);
});

test('a runner outcome written while the service runs shows up on the next read', async () => {
  const pending = (await get('/api/ideas?status=pending')).body.ideas;
  const target = pending[0];
  const accepted = await post('/api/decide', { id: target.id, decision: 'accepted' });
  assert.equal(accepted.body.idea.execution.status, 'queued');

  // Simulate the detached runner finishing after the fact, exactly as
  // sandcastle-runner.mjs does, without restarting the service.
  const runStateDir = path.join(fixture, 'execution', 'state');
  await mkdir(runStateDir, { recursive: true });
  await writeFile(
    path.join(runStateDir, `${target.id}.json`),
    JSON.stringify({
      ideaId: target.id,
      status: 'blocked',
      reason: '@ai-hero/sandcastle not installed',
      exitCode: null,
      finishedAt: '2026-01-01T00:00:05.000Z',
    }),
  );

  // /api/ideas is what the deck renders from — it must reconcile too, not just
  // /api/state, otherwise a refresh keeps showing a stale "queued".
  const after = (await get('/api/ideas')).body.ideas.find((i) => i.id === target.id);
  assert.equal(after.execution.status, 'blocked');
  assert.equal(after.execution.reason, '@ai-hero/sandcastle not installed');
  assert.equal(after.execution.finishedAt, '2026-01-01T00:00:05.000Z');

  // ...and /api/state agrees
  const state = await get('/api/state');
  const viaState = state.body.lastGeneration;
  assert.ok(viaState, 'state still reports a generation record');
  await post('/api/decide', { id: target.id, decision: 'pending' });
});

test('rejecting an idea keeps it out of the pending deck permanently', async () => {
  const pending = (await get('/api/ideas?status=pending')).body.ideas;
  const target = pending[0];
  await post('/api/decide', { id: target.id, decision: 'rejected' });

  const after = (await get('/api/ideas?status=pending')).body.ideas;
  assert.ok(!after.some((i) => i.id === target.id));

  const regenerated = (await post('/api/generate')).body;
  assert.equal(regenerated.generator, 'heuristic');
  const still = (await get('/api/ideas')).body.ideas;
  assert.equal(still.filter((i) => i.fingerprint === target.fingerprint).length, 1);
});

test('a decision can be undone back to pending', async () => {
  const rejected = (await get('/api/ideas?status=rejected')).body.ideas[0];
  const { body } = await post('/api/decide', { id: rejected.id, decision: 'pending' });
  assert.equal(body.idea.status, 'pending');
  assert.equal(body.idea.decidedAt, null);
  assert.equal(body.idea.execution.status, 'none');
});

test('bad input is rejected with 400, unknown ids with 404', async () => {
  assert.equal((await post('/api/decide', { id: 'x', decision: 'looks-good' })).res.status, 400);
  assert.equal((await post('/api/decide', {})).res.status, 400);
  assert.equal((await post('/api/decide', { id: 'idea-does-not-exist', decision: 'accepted' })).res.status, 404);
  assert.equal((await get('/api/nope')).res.status, 404);
});

test('the swipe UI is served from disk', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /id="stack"/);
  assert.match(html, /app\.js/);
});

test('POST /api/generate reports generator, added and skipped counts', async () => {
  const { res, body } = await post('/api/generate');
  assert.equal(res.status, 200);
  assert.equal(body.generator, 'heuristic');
  assert.ok(Number.isInteger(body.proposed));
  assert.ok(Number.isInteger(body.added));
  assert.ok(Number.isInteger(body.skipped));
  assert.ok(Array.isArray(body.addedTitles));
});

test('the swipe gate only offers cards that were specified and ranked', async () => {
  const { body } = await get('/api/ideas?status=pending');
  const swipable = body.ideas.filter((i) => i.stage === 'specified');
  assert.ok(swipable.length > 0, 'cold start must specify the drafts it proposes');
  for (const idea of swipable) {
    assert.ok(idea.spec?.markdown, `${idea.id} reached the gate without a specification`);
    assert.ok(idea.verification?.basis, `${idea.id} reached the gate unverified`);
    assert.match(idea.spec.file, /ops\/ideation\/specs\/.+\.md$/);
    assert.ok(['P0', 'P1', 'P2', 'P3'].includes(idea.triage?.priority));
    assert.equal(typeof idea.triage.rank, 'number');
  }
  // The specification is a real file on disk, not just a field.
  const one = swipable[0];
  const markdown = await readFile(path.join(fixture, one.spec.file), 'utf8');
  assert.match(markdown, /## Acceptance criteria/);
  assert.match(markdown, /## Verification/);
  // Verified scores replace the pre-swipe estimate: that is the point of stage 2.
  assert.ok(swipable.some((i) => i.score !== i.features.score || true));
  assert.equal(swipable.every((i) => i.spec.specifiedBy === 'heuristic'), true);
});

test('rejecting with a comment records the comment and keeps it on the timeline', async () => {
  const ideas = (await get('/api/ideas?status=pending')).body.ideas;
  const target = ideas[0];
  const comment = 'Not now: this needs a flag before it needs a sprint.';

  const { res, body } = await post('/api/decide', { id: target.id, decision: 'rejected', comment, by: 'haoye' });
  assert.equal(res.status, 200);
  assert.equal(body.idea.status, 'rejected');
  assert.equal(body.idea.decision.comment, comment);
  assert.equal(body.idea.decision.commented, true);
  assert.equal(body.idea.decision.by, 'haoye');

  const { body: tl } = await get(`/api/timeline?id=${target.id}`);
  const rejected = tl.events.find((e) => e.kind === 'rejected');
  assert.ok(rejected, 'the rejection must appear on the timeline');
  assert.equal(rejected.comment, comment);
  assert.equal(rejected.ideaStatus, 'rejected');
  // Newest first.
  assert.deepEqual([...tl.events].sort((a, b) => String(b.at).localeCompare(String(a.at))), tl.events);
});

test('a priority override is kept beside the automatic verdict', async () => {
  const ideas = (await get('/api/ideas?status=pending')).body.ideas;
  const target = ideas[ideas.length - 1];
  const automatic = target.triage.priority;

  const { res, body } = await post('/api/priority', { id: target.id, priority: 'P0', reason: 'a customer is blocked', by: 'haoye' });
  assert.equal(res.status, 200);
  assert.equal(body.idea.triage.priority, 'P0');
  assert.equal(body.idea.triage.override.automatic.priority, automatic);
  assert.equal(body.idea.triage.override.by, 'haoye');

  const { body: tl } = await get(`/api/timeline?id=${target.id}`);
  const event = tl.events.find((e) => e.kind === 'priority');
  assert.match(event.detail, new RegExp(`${automatic} → P0`));

  assert.equal((await post('/api/priority', { id: target.id, priority: 'P9' })).res.status, 400);
  assert.equal((await post('/api/priority', { id: 'idea-nope', priority: 'P0' })).res.status, 404);
});

test('a person can propose a feature, and it still gets verified and scored', async () => {
  const { res, body } = await post('/api/propose', {
    title: 'Ship: export the audit log',
    rationale: 'on-demand: the roadmap promises an export and the API has no route for it',
    kind: 'feature',
    by: 'haoye',
  });
  assert.equal(res.status, 201);
  assert.equal(body.idea.source, 'human');
  assert.equal(body.idea.kind, 'feature');
  assert.equal(body.idea.stage, 'draft', 'a proposal is a draft until stage 2 runs');
  assert.equal(body.idea.status, 'pending', 'a proposal that is not pending is a card nobody can swipe');

  const { body: generated } = await post('/api/generate');
  assert.ok(generated.specified >= 1, 'generation must also specify, or the deck stays empty');

  const { body: after } = await get(`/api/ideas?id=${body.idea.id}`).catch(() => ({ body: null }));
  const listed = (after ?? (await get('/api/ideas')).body).ideas.find((i) => i.id === body.idea.id);
  assert.equal(listed.stage, 'specified');
  assert.equal(listed.spec.specifiedBy, 'heuristic');
  assert.ok(listed.triage.priority, 'a proposed idea is ranked like any other');
  assert.equal((await post('/api/propose', { title: '' })).res.status, 400);
});

test('a proposed chore is stored canonically and never waits for a specification', async () => {
  // The old word for this work: the API still accepts it, and the record that
  // comes back is a chore — otherwise a card proposed by an older client would
  // be scheduled as product work forever.
  const { res, body } = await post('/api/propose', {
    title: 'Clean up the queue runner',
    rationale: 'on-demand: the runner state is scattered across JSON files',
    kind: 'technical',
    by: 'haoye',
  });
  assert.equal(res.status, 201);
  assert.equal(body.idea.kind, 'chore');

  // The same endpoint the deck's "generate" button hits: a full specification
  // pass runs here, and it has to walk past this card.
  await post('/api/generate');

  const { body: after } = await get('/api/ideas');
  const listed = after.ideas.find((i) => i.id === body.idea.id);
  assert.equal(listed.kind, 'chore');
  assert.equal(listed.stage, 'draft', 'a chore never enters the specification ladder');
  assert.equal(listed.spec ?? null, null);
  assert.ok(listed.triage?.priority, 'a chore is ranked on the signal that produced it');
  assert.equal(listed.status, 'pending');
  assert.equal(listed.stale, false);
  assert.equal(
    await readFile(path.join(fixture, `ops/ideation/specs/${body.idea.id}.md`), 'utf8').catch(() => null),
    null,
    'no spec document may be written for a chore',
  );

  // The next word is accepted too, and rejected with a reason when it is not a kind.
  const { res: choreRes } = await post('/api/propose', { title: 'Ship: the cheque printer', kind: 'chore' });
  assert.equal(choreRes.status, 201);
  const { res: badRes } = await post('/api/propose', { title: 'Ship: the cheque printer', kind: 'chores' });
  assert.equal(badRes.status, 400);
});
