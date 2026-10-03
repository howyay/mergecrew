import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IdeaStore, kindForSource, STATE_VERSION } from '../lib/store.mjs';

const tmpStore = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'idea-store-'));
  return { dir, store: new IdeaStore(path.join(dir, 'ideas.json')) };
};

const idea = (over = {}) => ({
  id: 'idea-1',
  fingerprint: 'backlog:do-the-thing',
  title: 'Do the thing',
  source: 'backlog',
  status: 'pending',
  score: 60,
  band: 'should',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

test('read() on a missing file returns an empty, well-formed store', async () => {
  const { dir, store } = await tmpStore();
  const data = await store.read();
  assert.equal(data.version, STATE_VERSION);
  assert.deepEqual(data.ideas, []);
  assert.equal(data.lastGeneration, null);
  await rm(dir, { recursive: true, force: true });
});

test('addMany writes valid JSON and reports real added/skipped counts', async () => {
  const { dir, store } = await tmpStore();
  const first = await store.addMany([idea(), idea({ id: 'idea-2', fingerprint: 'backlog:other', title: 'Other' })]);
  assert.equal(first.added.length, 2);
  assert.equal(first.skipped.length, 0);
  assert.equal(first.total, 2);

  const second = await store.addMany([idea(), idea({ id: 'idea-3', fingerprint: 'backlog:third', title: 'Third' })]);
  assert.equal(second.added.length, 1);
  assert.equal(second.skipped.length, 1);

  const raw = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(raw.ideas.length, 3);
  assert.ok(raw.updatedAt);
  await rm(dir, { recursive: true, force: true });
});

test('a rejected fingerprint is never re-proposed', async () => {
  const { dir, store } = await tmpStore();
  const first = await store.addMany([idea()]);
  assert.equal(first.added.length, 1, 'the first insert must not be treated as already known');
  await store.decide('idea-1', 'rejected');
  const again = await store.addMany([idea({ id: 'idea-9' })]);
  assert.equal(again.added.length, 0);
  assert.equal(again.skipped.length, 1);
  assert.equal((await store.stats()).total, 1);
  await rm(dir, { recursive: true, force: true });
});

test('two stores never share state (regression: shared empty-state singleton)', async () => {
  const a = await tmpStore();
  const b = await tmpStore();
  await a.store.addMany([idea({ id: 'idea-a', fingerprint: 'f:a', title: 'A' })]);
  const bIdea = await b.store.addMany([idea({ id: 'idea-b', fingerprint: 'f:b', title: 'B' })]);
  assert.equal(bIdea.added.length, 1, 'store B saw store A fingerprints');
  assert.equal((await a.store.stats()).total, 1);
  assert.equal((await b.store.stats()).total, 1);
  await rm(a.dir, { recursive: true, force: true });
  await rm(b.dir, { recursive: true, force: true });
});

test('decide() transitions status and stamps decidedAt, pending clears it', async () => {
  const { dir, store } = await tmpStore();
  await store.addMany([idea()]);

  const accepted = await store.decide('idea-1', 'accepted');
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.decidedAt);

  const undone = await store.decide('idea-1', 'pending');
  assert.equal(undone.status, 'pending');
  assert.equal(undone.decidedAt, null);

  assert.equal(await store.decide('nope', 'accepted'), null);
  await assert.rejects(() => store.decide('idea-1', 'maybe'), /bad decision/);
  await rm(dir, { recursive: true, force: true });
});

test('setExecution merges patches instead of replacing them', async () => {
  const { dir, store } = await tmpStore();
  await store.addMany([idea()]);
  assert.equal((await store.stats()).total, 1, 'fixture must start with exactly one idea');
  await store.setExecution('idea-1', { status: 'queued', taskFile: 'ops/execution/queue/idea-1.md' });
  const updated = await store.setExecution('idea-1', { status: 'running', pid: 4242 });
  assert.equal(updated.execution.status, 'running');
  assert.equal(updated.execution.taskFile, 'ops/execution/queue/idea-1.md');
  assert.equal(updated.execution.pid, 4242);
  assert.ok(updated.execution.updatedAt);
  await rm(dir, { recursive: true, force: true });
});

test('concurrent mutations are serialized and lose no ideas', async () => {
  const { dir, store } = await tmpStore();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      store.addMany([idea({ id: `idea-${i}`, fingerprint: `backlog:item-${i}`, title: `Item ${i}` })]),
    ),
  );
  const stats = await store.stats();
  assert.equal(stats.total, 12);
  assert.equal(stats.byStatus.pending, 12);
  await rm(dir, { recursive: true, force: true });
});

test('stats() counts by status and band', async () => {
  const { dir, store } = await tmpStore();
  await store.addMany([
    idea({ id: 'a', fingerprint: 'f:a', band: 'must' }),
    idea({ id: 'b', fingerprint: 'f:b', band: 'could' }),
    idea({ id: 'c', fingerprint: 'f:c', band: 'must' }),
  ]);
  await store.decide('b', 'accepted');
  await store.decide('c', 'rejected');
  const stats = await store.stats();
  assert.deepEqual(stats.byStatus, { pending: 1, accepted: 1, rejected: 1 });
  assert.deepEqual(stats.byBand, { must: 2, could: 1 });
  await rm(dir, { recursive: true, force: true });
});

test('markStaleness flags pending cards the current signals no longer support', async (t) => {
  const { dir, store } = await tmpStore();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await store.addMany([
    { id: 'a', fingerprint: 'todo:one', status: 'pending', band: 'should' },
    { id: 'b', fingerprint: 'todo:two', status: 'pending', band: 'should' },
    { id: 'c', fingerprint: 'todo:three', status: 'rejected', band: 'could' },
  ]);

  // First cycle supports a and b, not c (c is decided, so it is left alone).
  let res = await store.markStaleness(['todo:one', 'todo:two']);
  assert.deepEqual(res, { marked: 0, cleared: 0 }, 'a fresh idea already carries stale:false');
  assert.equal((await store.get('c')).stale, false, 'decided cards are not re-evaluated by markStaleness');

  // Second cycle: b lost its evidence (the area gained tests, the TODO went away).
  res = await store.markStaleness(['todo:one']);
  assert.deepEqual(res, { marked: 1, cleared: 0 });
  assert.equal((await store.get('b')).stale, true);
  assert.equal((await store.get('a')).stale, false);

  // Third cycle: b is supported again -> the flag must clear, not stick forever.
  res = await store.markStaleness(new Set(['todo:one', 'todo:two']));
  assert.deepEqual(res, { marked: 0, cleared: 1 });
  assert.equal((await store.get('b')).stale, false);

  // A decided card keeps the staleness it was carrying when it was decided.
  await store.markStaleness([]); // b goes stale
  await store.decide('b', 'rejected');
  res = await store.markStaleness(['todo:one', 'todo:two']); // everything supported again
  assert.deepEqual(res, { marked: 0, cleared: 1 }, 'only the still-pending card is re-evaluated');
  assert.equal((await store.get('b')).stale, true, 'the flag it was decided under is preserved');

  // Fourth cycle: everything else falls out of support at once.
  res = await store.markStaleness([]);
  assert.deepEqual(res, { marked: 1, cleared: 0 }, 'only a is still pending');
  const stats = await store.stats();
  assert.equal(stats.stale, 2, 'a plus the frozen rejected card');
});

test('addMany marks new cards as supported', async (t) => {
  const { dir, store } = await tmpStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { added } = await store.addMany([{ id: 'x', fingerprint: 'f:x', status: 'pending', band: 'could' }]);
  assert.equal(added.length, 1);
  assert.equal((await store.get('x')).stale, false, 'a card born from this cycle is supported by definition');
});

/**
 * A store constructed with the wrong argument used to read an empty deck and
 * silently persist nothing, so a caller could "save" state that never existed.
 * The constructor is the only place that can catch it.
 */
test('IdeaStore refuses a state file that is not a path', () => {
  assert.throws(() => new IdeaStore({ file: '/tmp/ideas.json' }), /needs a state file path/);
  assert.throws(() => new IdeaStore(), /needs a state file path/);
  assert.throws(() => new IdeaStore(''), /needs a state file path/);
});

// The live deck was recording {source, score, status} before it grew kinds, a
// stage machine and a timeline. Reading such a file must produce a usable deck,
// not six cards stuck at `stage: undefined` that the specifier will never pick
// up — the file is fine, the reader has to be.
test('an older state file is read as a v2 deck, not as an empty one', async () => {
  const { dir, store } = await tmpStore();
  const legacy = {
    version: 1,
    updatedAt: '2026-10-02T20:00:00.000Z',
    lastGeneration: null,
    ideas: [
      {
        id: 'idea-legacy1',
        fingerprint: 'disabled-check:x',
        title: 'Enable the parked check',
        source: 'disabled-check',
        status: 'pending',
        score: 68,
        band: 'should',
        createdAt: '2026-10-02T19:00:00.000Z',
      },
    ],
  };
  await writeFile(path.join(dir, 'ideas.json'), JSON.stringify(legacy, null, 2), 'utf8');

  const [read] = await store.list();
  assert.equal(read.kind, 'technical', 'a chore is not a user-facing feature');
  assert.equal(read.stage, 'draft', 'a card that was never specified is still a draft');
  assert.equal(read.stale, false);
  assert.equal(read.events.length, 1);
  assert.equal(read.events[0].kind, 'proposed');
  assert.equal(read.events[0].at, read.createdAt, 'the timeline starts where the record does');

  // Reading is not writing: the file keeps its old shape until something changes.
  const untouched = JSON.parse(await readFile(path.join(dir, 'ideas.json'), 'utf8'));
  assert.equal(untouched.version, 1);
  assert.equal(untouched.ideas[0].kind, undefined);

  // The next real mutation persists the normalized record.
  await store.decide('idea-legacy1', 'rejected', { comment: 'not now' });
  const migrated = JSON.parse(await readFile(path.join(dir, 'ideas.json'), 'utf8'));
  assert.equal(migrated.version, STATE_VERSION);
  assert.equal(migrated.ideas[0].kind, 'technical');
  assert.equal(migrated.ideas[0].stage, 'draft');
  assert.equal(migrated.ideas[0].decision.comment, 'not now');
});

test('kindForSource splits product work from engineering chores', () => {
  assert.equal(kindForSource('product-feature'), 'feature');
  assert.equal(kindForSource('product-in-progress'), 'feature');
  assert.equal(kindForSource('human'), 'feature');
  assert.equal(kindForSource('todo-cluster'), 'technical');
  assert.equal(kindForSource('fix-churn'), 'technical');
  assert.equal(kindForSource(undefined), 'feature');
});
