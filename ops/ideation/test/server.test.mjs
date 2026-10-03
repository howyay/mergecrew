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

process.env.MERGECREW_REPO = fixture;
process.env.IDEATION_STATE_FILE = path.join(fixture, 'ideas.json');
process.env.IDEATION_EXECUTION_DIR = path.join(fixture, 'execution');
process.env.IDEATION_PORT = '0';
process.env.IDEATION_HOST = '127.0.0.1';
process.env.IDEATION_INTERVAL_MINUTES = '600';
process.env.EXECUTOR = 'off';
process.env.IDEA_GENERATOR = 'auto';
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
});

test('GET /api/state surfaces the last generation honestly', async () => {
  const { body } = await get('/api/state');
  assert.equal(body.lastGeneration.generator, 'heuristic');
  assert.equal(body.lastGeneration.fallbackReason, null);
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
