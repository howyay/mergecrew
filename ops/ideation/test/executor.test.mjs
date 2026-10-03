/**
 * Execution bookkeeping: dispatch records and outcome reconciliation.
 * These cover the state-machine edges that a stale run can otherwise corrupt.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { IdeaStore } from '../lib/store.mjs';
import { dispatchAccepted, dispatchIdea, reconcileExecutions } from '../lib/executor.mjs';

// The dispatch test asserts the executor-off record, so pin it rather than
// inheriting whatever the surrounding shell exported.
process.env.EXECUTOR = 'off';

const makeStore = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exec-store-'));
  const store = new IdeaStore(path.join(dir, 'ideas.json'));
  await store.addMany([
    {
      id: 'idea-aaaa1111',
      fingerprint: 'deploy-hook:x',
      title: 'enable the deploy hook',
      source: 'deploy-hook',
      rationale: 'r',
      evidence: ['ops/ci/deploy.sh missing'],
      effortHint: 'medium',
      features: { impact: 20, confidence: 14, effort: 13, risk: 12 },
      score: 59,
      band: 'should',
      scoreReasons: [],
      status: 'accepted',
      createdAt: '2026-01-01T00:00:00.000Z',
      decidedAt: '2026-01-01T00:00:01.000Z',
      execution: null,
    },
  ]);
  return { dir, store };
};

test('a new dispatch clears the previous attempt outcome', async () => {
  const { dir, store } = await makeStore();
  try {
    await store.setExecution('idea-aaaa1111', {
      status: 'blocked',
      reason: 'old run',
      exitCode: null,
      finishedAt: '2026-01-01T00:00:05.000Z',
      summary: null,
    });

    const dispatch = { status: 'queued', taskFile: 'ops/execution/queue/idea-aaaa1111.md', reason: 'EXECUTOR=off', exitCode: null, finishedAt: null, summary: null };
    await store.setExecution('idea-aaaa1111', dispatch);

    const idea = await store.get('idea-aaaa1111');
    assert.equal(idea.execution.status, 'queued');
    assert.equal(idea.execution.finishedAt, null, 'a queued attempt must not carry a finished timestamp');
    assert.equal(idea.execution.reason, 'EXECUTOR=off');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an outcome is applied once, and a new attempt re-applies it', async () => {
  const { dir, store } = await makeStore();
  const stateDir = path.join(dir, 'execution');
  try {
    await store.setExecution('idea-aaaa1111', {
      status: 'queued',
      taskFile: 'ops/execution/queue/idea-aaaa1111.md',
      reason: 'EXECUTOR=off',
      exitCode: null,
      finishedAt: null,
      summary: null,
    });

    await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const outcomeFile = path.join(stateDir, 'state', 'idea-aaaa1111.json');
    await writeFile(
      outcomeFile,
      JSON.stringify({
        ideaId: 'idea-aaaa1111',
        status: 'blocked',
        reason: '@ai-hero/sandcastle not installed',
        exitCode: null,
        finishedAt: '2026-01-01T00:00:05.000Z',
      }),
    );

    const first = await reconcileExecutions(store, { stateDir });
    assert.equal(first.updated, 1);
    let idea = await store.get('idea-aaaa1111');
    assert.equal(idea.execution.status, 'blocked');
    assert.equal(idea.execution.reason, '@ai-hero/sandcastle not installed');

    const second = await reconcileExecutions(store, { stateDir });
    assert.equal(second.updated, 0, 'reconciling the same outcome twice must be a no-op');

    // operator re-accepts: the previous attempt's timestamp must not mask the
    // new outcome, which is the regression this test exists for
    await store.setExecution('idea-aaaa1111', {
      status: 'queued',
      taskFile: 'ops/execution/queue/idea-aaaa1111.md',
      reason: 'EXECUTOR=off',
      exitCode: null,
      finishedAt: null,
      summary: null,
    });
    await writeFile(
      outcomeFile,
      JSON.stringify({
        ideaId: 'idea-aaaa1111',
        status: 'done',
        exitCode: 0,
        finishedAt: '2026-01-01T00:10:00.000Z',
      }),
    );
    const third = await reconcileExecutions(store, { stateDir });
    assert.equal(third.updated, 1);
    idea = await store.get('idea-aaaa1111');
    assert.equal(idea.execution.status, 'done');
    assert.equal(idea.execution.finishedAt, '2026-01-01T00:10:00.000Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing outcome directory is not an outcome', async () => {
  const { dir, store } = await makeStore();
  try {
    const result = await reconcileExecutions(store, { stateDir: path.join(dir, 'nowhere') });
    assert.deepEqual(result, { updated: 0 });
    const idea = await store.get('idea-aaaa1111');
    assert.equal(idea.execution, null, 'nothing may be invented for an idea that never ran');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispatch writes the task file even when the executor is off', async () => {
  const { dir, store } = await makeStore();
  try {
    const repo = path.join(dir, 'repo');
    await mkdir(repo, { recursive: true });
    const idea = await store.get('idea-aaaa1111');
    const result = await dispatchIdea(idea, { repo, stateDir: path.join(repo, 'ops/execution') });

    assert.equal(result.status, 'queued');
    assert.equal(result.reason, 'EXECUTOR=off');
    assert.equal(result.finishedAt, null);
    const markdown = await readFile(path.join(repo, result.taskFile), 'utf8');
    assert.match(markdown, /idea-aaaa1111/);
    assert.match(markdown, /- score: 59 \(should\)/);
    assert.match(markdown, /## Evidence/);
    assert.match(markdown, /## Definition of done/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reconcile ignores outcomes for cards nobody accepted', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'idea-exec-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new IdeaStore(path.join(root, 'ideas.json'));
  const stateDir = path.join(root, 'exec');

  await store.addMany([
    { id: 'undone', fingerprint: 'f:undone', status: 'pending', band: 'should', stale: false },
    { id: 'live', fingerprint: 'f:live', status: 'accepted', band: 'should', stale: false },
  ]);
  await mkdir(path.join(stateDir, 'state'), { recursive: true });
  for (const id of ['undone', 'live']) {
    await writeFile(
      path.join(stateDir, 'state', `${id}.json`),
      JSON.stringify({ status: 'blocked', exitCode: 3, reason: 'runner missing', finishedAt: '2026-10-02T19:55:58.180Z' }),
    );
  }

  const first = await reconcileExecutions(store, { stateDir });
  assert.equal(first.updated, 1, 'only the accepted card gets the outcome');
  assert.equal((await store.get('undone')).execution ?? null, null, 'a pending card never inherits an attempt');
  assert.equal((await store.get('live')).execution.status, 'blocked');
  assert.equal((await store.get('undone')).execution ?? null, null, 'a pending card never inherits an attempt');

  // Regression: undo the decision after the outcome landed. The stale verdict
  // must be dropped, not re-stamped on the next reconcile.
  await store.decide('live', 'pending');
  await store.setExecution('live', { status: 'none', exitCode: null, reason: 'decision undone', finishedAt: null, summary: null });
  const second = await reconcileExecutions(store, { stateDir });
  assert.equal((await store.get('live')).execution.status, 'none', 'an undone decision stays undone');
  assert.equal(second.updated, 0, 'nothing left to reconcile');

  // Regression: a card that still carries the *exact* verdict from the file
  // (same status and finishedAt) must be cleared too. Ordering the decision
  // gate after the 'already applied' shortcut left these cards stuck forever.
  await store.decide('live', 'accepted');
  await store.setExecution('live', { status: 'queued', exitCode: null, reason: null, finishedAt: null, summary: null });
  await reconcileExecutions(store, { stateDir });
  assert.equal((await store.get('live')).execution.status, 'blocked', 'accepted again, outcome applies');
  await store.decide('live', 'rejected');
  const third = await reconcileExecutions(store, { stateDir });
  assert.equal(third.updated, 1);
  assert.equal((await store.get('live')).execution.status, 'none');
  assert.match((await store.get('live')).execution.reason, /decision is rejected/);
  const fourth = await reconcileExecutions(store, { stateDir });
  assert.equal(fourth.updated, 0, 'clearing is idempotent');
});

test('the sweep dispatches decisions written by another process', async (t) => {
  const { dir, store } = await makeStore();
  const repo = path.join(dir, 'repo');
  await mkdir(repo, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  // The web app can only write the file, so simulate exactly that: a second
  // store instance over the same path marks an idea accepted.
  const second = new IdeaStore(store.file);
  await second.decide('idea-aaaa1111', 'accepted');

  const first = await dispatchAccepted(store, { repo, stateDir: path.join(repo, 'ops/execution') });
  assert.deepEqual(first.dispatched, [{ id: 'idea-aaaa1111', status: 'queued', reason: 'EXECUTOR=off' }]);

  const idea = await store.get('idea-aaaa1111');
  assert.equal(idea.execution.status, 'queued');
  assert.ok(idea.execution.taskFile.endsWith('idea-aaaa1111.md'));
  const task = await readFile(path.join(repo, idea.execution.taskFile), 'utf8');
  assert.match(task, /idea-aaaa1111/);

  // Idempotent: a queued idea is not dispatched twice.
  const again = await dispatchAccepted(store, { repo, stateDir: path.join(repo, 'ops/execution') });
  assert.deepEqual(again.dispatched, []);
  assert.equal(again.remaining, 0);
});

test('the sweep ignores undecided ideas and re-dispatches an undone one', async (t) => {
  const { dir, store } = await makeStore();
  const repo = path.join(dir, 'repo');
  await mkdir(repo, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  // The shared fixture card is already accepted; this test wants a clean slate.
  await store.decide('idea-aaaa1111', 'pending');
  const nothing = await dispatchAccepted(store, { repo, stateDir: path.join(repo, 'ops/execution') });
  assert.deepEqual(nothing.dispatched, [], 'a pending idea is not work yet');

  await store.decide('idea-aaaa1111', 'accepted');
  await dispatchAccepted(store, { repo, stateDir: path.join(repo, 'ops/execution') });
  await store.decide('idea-aaaa1111', 'pending');
  await store.setExecution('idea-aaaa1111', { status: 'none', reason: 'decision undone', finishedAt: null });

  await store.decide('idea-aaaa1111', 'accepted');
  const redispatched = await dispatchAccepted(store, { repo, stateDir: path.join(repo, 'ops/execution') });
  assert.equal(redispatched.dispatched.length, 1, 'accepting again must produce a task file again');
});

test('the sweep caps how many agents one tick can start', async (t) => {
  const { dir, store } = await makeStore();
  const repo = path.join(dir, 'repo');
  await mkdir(repo, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await store.decide('idea-aaaa1111', 'pending'); // isolate the cap from the fixture card
  await store.addMany(
    Array.from({ length: 5 }, (_, i) => ({
      id: `idea-cap${i}`,
      fingerprint: `cap:${i}`,
      title: `cap ${i}`,
      source: 'backlog',
      rationale: 'r',
      evidence: ['e'],
      effortHint: 'small',
      features: { impact: 1, confidence: 1, effort: 1, risk: 1 },
      score: 4,
      band: 'wont',
      status: 'accepted',
      createdAt: '2026-01-01T00:00:00.000Z',
      decidedAt: '2026-01-01T00:00:01.000Z',
      execution: null,
      stale: false,
    })),
  );

  const sweep = await dispatchAccepted(store, { repo, stateDir: path.join(repo, 'ops/execution'), max: 2 });
  assert.equal(sweep.dispatched.length, 2);
  assert.equal(sweep.remaining, 3, 'the rest wait for the next tick');

  const rest = await dispatchAccepted(store, { repo, stateDir: path.join(repo, 'ops/execution'), max: 10 });
  assert.equal(rest.dispatched.length, 3);
  assert.equal(rest.remaining, 0);
});
