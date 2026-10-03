/**
 * The runner's work list is the contract between the human gate and the
 * automation: an idea the human accepted is picked up; an idea still awaiting
 * review, already reviewed, or blocked is left alone. Getting this wrong either
 * strands accepted work or re-runs an agent on something already finished.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { IdeaStore } from '../../ideation/lib/store.mjs';
import { advanceIdea, MAX_STAGE_ATTEMPTS, ownsQaStage, pipelineStatusFor, STAGES, sweep, workList } from '../run.mjs';

const run = promisify(execFile);

async function storeWith(ideas) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-run-'));
  const store = new IdeaStore(path.join(dir, 'ideas.json'));
  await store.addMany(
    ideas.map((i) => ({
      source: 'disabled-check',
      rationale: 'r',
      evidence: ['ops/ci/checks.conf:12 x'],
      effortHint: 'small',
      title: i.title ?? 'idea',
      ...i,
    })),
  );
  return { dir, store };
}

test('the stage list is the documented order', () => {
  assert.deepEqual(STAGES, ['prd', 'issue', 'worktree', 'dev', 'qa', 'deliver', 'review']);
});

test('workList takes accepted ideas and leaves everything else where it is', async () => {
  const { dir, store } = await storeWith([
    { title: 'pending one' },
    { title: 'accepted fresh' },
    { title: 'accepted awaiting review' },
    { title: 'accepted blocked' },
    { title: 'accepted done' },
    { title: 'rejected one' },
  ]);
  try {
    const all = await store.list();
    const byTitle = Object.fromEntries(all.map((i) => [i.title, i.id]));
    await store.decide(byTitle['accepted fresh'], 'accepted');
    await store.decide(byTitle['accepted awaiting review'], 'accepted');
    await store.decide(byTitle['accepted blocked'], 'accepted');
    await store.decide(byTitle['accepted done'], 'accepted');
    await store.decide(byTitle['rejected one'], 'rejected');
    await store.setPipeline(byTitle['accepted awaiting review'], { status: 'awaiting-review' });
    await store.setPipeline(byTitle['accepted blocked'], { status: 'blocked' });
    await store.setPipeline(byTitle['accepted done'], { status: 'done' });

    const queue = await workList(store);
    assert.deepEqual(
      queue.map((i) => i.title),
      ['accepted fresh'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a card parked at the gate without the artifact the gate opens on still owes a stage', async () => {
  const { dir, store } = await storeWith([
    { title: 'parked by the old pipeline' },
    { title: 'parked with a deliverable' },
  ]);
  try {
    const all = await store.list();
    const byTitle = Object.fromEntries(all.map((i) => [i.title, i.id]));
    for (const id of Object.values(byTitle)) await store.decide(id, 'accepted');
    // Both reached the gate straight from UAT, the way records written before the
    // deliver stage existed did.
    await store.setPipeline(byTitle['parked by the old pipeline'], {
      status: 'awaiting-review',
      qa: { status: 'pass', report: 'ops/pipeline/uat/x/uat.md' },
    });
    await store.setPipeline(byTitle['parked with a deliverable'], {
      status: 'awaiting-review',
      qa: { status: 'pass', report: 'ops/pipeline/uat/x/uat.md' },
      deliver: { status: 'done', file: 'ops/pipeline/deliver/x.md' },
    });

    const queue = await workList(store);
    assert.deepEqual(
      queue.map((i) => i.title),
      ['parked by the old pipeline'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses to guess: an unknown idea and an empty invocation both exit non-zero', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-run-'));
  const stateFile = path.join(dir, 'ideas.json');
  try {
    const repo = path.resolve(new URL('../../..', import.meta.url).pathname);
    const missing = await run('node', ['ops/pipeline/run.mjs', '--idea', 'idea-does-not-exist'], {
      cwd: repo,
      env: { ...process.env, IDEATION_STATE_FILE: stateFile },
    }).catch((err) => err);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /unknown idea idea-does-not-exist/);

    const nothing = await run('node', ['ops/pipeline/run.mjs'], { cwd: repo, env: { ...process.env, IDEATION_STATE_FILE: stateFile } }).catch((err) => err);
    assert.equal(nothing.code, 2);
    assert.match(nothing.stderr, /nothing to do/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The pipeline reaches its stage modules through load(), so a name that lives in
// the wrong file fails only when a real idea reaches that stage. That is how
// `detectForge is not a function` reached production: it was destructured from
// issue.mjs but defined in prd.mjs. This asserts every stage's contract instead.
test('every stage module exports what run.mjs destructures from it', async () => {
  const contract = {
    './lib/prd.mjs': ['buildPrd', 'writePrd', 'acceptanceFor', 'detectForge'],
    './lib/issue.mjs': ['createIssue', 'issueTitle'],
    './lib/worktree.mjs': ['createWorktree', 'seedWorktree', 'agentReport', 'removeWorktree'],
    './lib/agent.mjs': ['resolveAgent', 'spawnDevAgent', 'readAgentLog'],
    './lib/uat.mjs': ['runUat', 'uatMarkdown'],
    './lib/recorder.mjs': ['recordDemo', 'captureSession', 'assembleApng'],
  };
  for (const [mod, names] of Object.entries(contract)) {
    const loaded = await import(new URL(`../${mod.slice(2)}`, import.meta.url));
    for (const name of names) {
      assert.equal(typeof loaded[name], 'function', `${mod} must export ${name}()`);
    }
  }
});

test('a failed stage is retried, then parked for a human', async () => {
  const { dir, store } = await storeWith([
    { id: 'fresh', title: 'fresh' },
    { id: 'one-failure', title: 'one-failure' },
    { id: 'exhausted', title: 'exhausted' },
    { id: 'blocked', title: 'blocked' },
    { id: 'awaiting', title: 'awaiting' },
    { id: 'done', title: 'done' },
    { id: 'not-accepted', title: 'not-accepted' },
  ]);
  for (const id of ['fresh', 'one-failure', 'exhausted', 'blocked', 'awaiting', 'done']) {
    await store.decide(id, 'accepted');
  }
  await store.setPipeline('one-failure', { status: 'failed', attempts: 1 });
  await store.setPipeline('exhausted', { status: 'failed', attempts: MAX_STAGE_ATTEMPTS });
  await store.setPipeline('blocked', { status: 'blocked', attempts: 1 });
  await store.setPipeline('awaiting', { status: 'awaiting-review' });
  await store.setPipeline('done', { status: 'done' });

  const ids = (await workList(store)).map((i) => i.id).sort();
  assert.deepEqual(ids, ['fresh', 'one-failure']);
  await rm(dir, { recursive: true, force: true });
});

/**
 * The provider outage of 2026-10-03 parked every accepted idea at `blocked`,
 * and nothing in the runner could move it again: a recorded failure is never
 * retried on purpose, so recovery has to be something a human can do without
 * hand-editing state. `--retry dev` is that something, and this is what it must
 * leave behind: the dev stage gone (so the next sweep re-runs it), the earlier
 * stages untouched (their evidence is the PRD and the filed issue), the stale
 * agent report deleted (it would otherwise read as "done"), and the top-level
 * status derived back into the work list.
 */
test('--retry dev clears only the dev stage, deletes a stale report, and un-blocks the card', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-retry-'));
  const { dir, store } = await storeWith([{ id: 'stuck', title: 'stuck' }]);
  const worktree = '.worktrees/stuck';
  try {
    await store.decide('stuck', 'accepted');
    await store.setPipeline('stuck', { status: 'blocked', reason: 'provider outage' });
    await mkdir(path.join(repo, 'ops/pipeline/state'), { recursive: true });
    await mkdir(path.join(repo, worktree), { recursive: true });
    await writeFile(path.join(repo, worktree, 'AGENT_REPORT.md'), '# stale\n', 'utf8');
    await writeFile(
      path.join(repo, 'ops/pipeline/state/stuck.json'),
      JSON.stringify({
        id: 'stuck',
        status: 'blocked',
        stages: {
          prd: { file: 'ops/pipeline/prd/stuck.md', acceptance: ['a'] },
          issue: { status: 'local', file: 'ops/pipeline/issues/stuck.md' },
          worktree: { status: 'created', dir: worktree },
          dev: { status: 'failed', attempts: 1, provider: 'claude', reason: 'provider outage' },
          qa: { verdict: 'pass', report: 'ops/pipeline/uat/stuck/uat.md' },
          review: { status: 'pending' },
        },
      }),
      'utf8',
    );

    // PIPELINE_DEV_AGENT is off in this test process, so the spawned stage
    // stops at "skipped" — the point here is the state it leaves, not a spawn.
    const out = await advanceIdea(await store.get('stuck'), { store, repo, retryStage: 'dev' });
    assert.equal(out.did, 'dev');
    assert.equal(out.status, 'dev-skipped');

    const record = JSON.parse(await readFile(path.join(repo, 'ops/pipeline/state/stuck.json'), 'utf8'));
    assert.equal('dev' in record.stages, false, 'the dev stage is cleared so the next advance re-runs it');
    assert.equal(
      'qa' in record.stages || 'review' in record.stages,
      false,
      'a UAT verdict on the replaced worktree is stale evidence and must not survive the retry',
    );
    assert.equal(record.stages.prd.file, 'ops/pipeline/prd/stuck.md', 'earlier stages are evidence and stay');
    assert.equal(record.stages.issue.status, 'local');
    assert.equal(record.stages.worktree.dir, worktree);
    assert.equal(record.status, 'running', 'the card is back in the sweep work list');
    await assert.rejects(readFile(path.join(repo, worktree, 'AGENT_REPORT.md'), 'utf8'), /ENOENT/);

    await assert.rejects(
      advanceIdea(await store.get('stuck'), { store, repo, retryStage: 'nope' }),
      /unknown stage "nope"/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The dev→done transition is the moment the pipeline takes ownership of the
 * agent's work. Two things have to survive it: *which* agent did the work (the
 * record used to be replaced by `{status, report}`, so a finished card said
 * "agent · done" and nobody could tell dsh from claude), and the work itself —
 * a dev agent runs inside a file sandbox that cannot write
 * `.git/worktrees/<id>/index.lock`, so "commit your work" is an instruction it
 * cannot follow. The pipeline commits instead, and the review gate then has a
 * diff to read rather than a pile of untracked files.
 */
test('dev done keeps the provider and commits the agent\'s work on its branch', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-devdone-'));
  const { dir, store } = await storeWith([{ id: 'shipped', title: 'shipped' }]);
  const worktree = '.worktrees/shipped';
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await store.decide('shipped', 'accepted');
    await store.setPipeline('shipped', { status: 'running' });
    await mkdir(path.join(repo, 'ops/pipeline/state'), { recursive: true });
    await mkdir(path.join(repo, worktree, 'ops/ci'), { recursive: true });
    await writeFile(path.join(repo, worktree, 'AGENT_REPORT.md'), '# did it\n', 'utf8');
    await writeFile(path.join(repo, worktree, 'ops/ci/checks.conf'), 'pnpm --filter @mergecrew/domain test\n', 'utf8');
    await writeFile(
      path.join(repo, 'ops/pipeline/state/shipped.json'),
      JSON.stringify({
        id: 'shipped',
        status: 'running',
        stages: {
          prd: { file: 'ops/pipeline/prd/shipped.md', acceptance: ['a'] },
          issue: { status: 'created', url: 'https://example.test/issues/2' },
          worktree: { status: 'created', dir: worktree },
          dev: {
            status: 'running',
            provider: 'dsh',
            command: 'dsh headless Read TASK.md and do the task it describes.',
            pid: 999999,
            logFile: 'ops/pipeline/state/agent-logs/shipped.agent.log',
            startedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      }),
      'utf8',
    );

    const out = await advanceIdea(await store.get('shipped'), { store, repo, onlyStage: 'dev' });
    assert.equal(out.status, 'dev-done');

    const record = JSON.parse(await readFile(path.join(repo, 'ops/pipeline/state/shipped.json'), 'utf8'));
    const dev = record.stages.dev;
    assert.equal(dev.status, 'done');
    assert.equal(dev.provider, 'dsh', 'the deck must be able to name the agent that ran');
    assert.equal(dev.command.includes('dsh headless'), true);
    assert.equal(dev.commitStatus, 'committed');
    assert.match(dev.commit, /^[0-9a-f]{40}$/);
    assert.equal(dev.commitFiles >= 2, true);
    assert.equal(typeof dev.durationMs, 'number');
    assert.equal((await run('git', ['log', '-1', '--format=%s'], { cwd: path.join(repo, worktree) })).stdout.trim(), 'shipped: shipped');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * Stage 5 starts from a card that already went through prd → issue → worktree →
 * dev → qa. The deliverable is a pure function of those records, so if it
 * invents anything it invents it from this fixture.
 */
function recordedStages() {
  return {
    prd: { file: 'ops/pipeline/prd/shipped.md', acceptance: ['invoices older than 30 days are listed'] },
    issue: { status: 'created', url: 'https://example.test/issues/7' },
    worktree: { status: 'created', dir: '.worktrees/shipped', branch: 'idea/shipped' },
    dev: { status: 'done', provider: 'dsh', commit: 'a'.repeat(40), commitFiles: 3, report: 'ops/pipeline/state/agent-reports/shipped.md' },
    qa: { status: 'done', verdict: 'pass', demo: 'ops/pipeline/uat/shipped/demo.png', report: 'ops/pipeline/uat/shipped/uat.md' },
  };
}

const AGENT_REPORT = ['idea: shipped', 'agent: dsh', '', '## Summary', '', 'Ageing window now follows the project policy.', '', '## Evidence', '', '164 tests pass'].join('\n');

async function cardAwaitingDeliverable({ title = 'Late invoices', kind = 'feature' } = {}) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-deliver-'));
  const { dir, store } = await storeWith([{ id: 'shipped', title, kind }]);
  const stages = recordedStages();
  await store.decide('shipped', 'accepted');
  await store.setPipeline('shipped', { status: 'running', stages });
  await mkdir(path.join(repo, 'ops/pipeline/state/agent-reports'), { recursive: true });
  await writeFile(path.join(repo, 'ops/pipeline/state/agent-reports/shipped.md'), AGENT_REPORT, 'utf8');
  await writeFile(path.join(repo, 'ops/pipeline/state/shipped.json'), JSON.stringify({ id: 'shipped', status: 'running', stages }, null, 2), 'utf8');
  return { repo, dir, store };
}

test('the deliver stage writes the artifact the review gate opens on', async () => {
  const { repo, dir, store } = await cardAwaitingDeliverable();
  try {
    const out = await advanceIdea(await store.get('shipped'), { store, repo, onlyStage: 'deliver' });
    assert.equal(out.did, 'deliver');
    assert.equal(out.kind, 'feature');
    assert.equal(out.file, 'ops/pipeline/deliver/shipped.md');

    const markdown = await readFile(path.join(repo, 'ops/pipeline/deliver/shipped.md'), 'utf8');
    assert.match(markdown, /^# Demo: Late invoices$/m);
    assert.match(markdown, /!\[demo\]\(demo\.png\)/);
    assert.match(markdown, /- \[ \] invoices older than 30 days are listed/);

    // The record is what the deck reads. A file nobody recorded is a deliverable
    // nobody can find.
    const record = JSON.parse(await readFile(path.join(repo, 'ops/pipeline/state/shipped.json'), 'utf8'));
    assert.equal(record.stages.deliver.status, 'done');
    assert.equal(record.stages.deliver.kind, 'feature');
    assert.equal(record.stages.deliver.file, 'ops/pipeline/deliver/shipped.md');
    assert.equal((await store.get('shipped')).pipeline.deliver.file, 'ops/pipeline/deliver/shipped.md');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('a technical card gets a changelog, not a demo it never made', async () => {
  const { repo, dir, store } = await cardAwaitingDeliverable({ title: 'Split the session store', kind: 'technical' });
  try {
    const out = await advanceIdea(await store.get('shipped'), { store, repo, onlyStage: 'deliver' });
    assert.equal(out.kind, 'technical');

    const markdown = await readFile(path.join(repo, 'ops/pipeline/deliver/shipped.md'), 'utf8');
    assert.match(markdown, /^# Changelog: Split the session store$/m);
    assert.match(markdown, /Ageing window now follows the project policy\./);
    assert.doesNotMatch(markdown, /!\[demo\]/);
    assert.equal((await store.get('shipped')).pipeline.deliver.changelog, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('the review gate does not open until a deliverable exists', () => {
  const passesUat = { dev: { status: 'done' }, qa: { status: 'done', verdict: 'pass' } };
  assert.deepEqual(pipelineStatusFor(passesUat), { status: 'running', reason: 'UAT passed; the deliverable is next' });
  assert.deepEqual(pipelineStatusFor({ ...passesUat, deliver: { status: 'done' } }), {
    status: 'awaiting-review',
    reason: 'the deliverable is ready; waiting for a human verdict',
  });
  // A UAT job that is still driving the browser has no verdict yet. Reading that
  // as "no verdict" used to park the card for a human with nothing to read.
  assert.deepEqual(pipelineStatusFor({ dev: { status: 'done' }, qa: { status: 'running' } }), {
    status: 'running',
    reason: 'the UAT job is still running',
  });
});

test('a full dev budget defers the cards that need an agent, not the one whose deliverable is ready', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-slots-'));
  const { dir, store } = await storeWith([
    { id: 'needs-agent', title: 'needs an agent' },
    { id: 'ready', title: 'late invoices' },
  ]);
  const stages = recordedStages();
  try {
    await store.decide('needs-agent', 'accepted');
    await store.decide('ready', 'accepted');
    await store.setPipeline('ready', { status: 'running', stages });
    await mkdir(path.join(repo, 'ops/pipeline/state/agent-reports'), { recursive: true });
    await writeFile(path.join(repo, 'ops/pipeline/state/agent-reports/ready.md'), AGENT_REPORT, 'utf8');
    await writeFile(path.join(repo, 'ops/pipeline/state/ready.json'), JSON.stringify({ id: 'ready', status: 'running', stages }, null, 2), 'utf8');

    const out = await sweep({ store, repo, maxDev: 0, maxQa: 2, log: () => {} });
    assert.deepEqual(out.deferred, [{ id: 'needs-agent', reason: 'dev slots busy (0/0)' }]);
    assert.equal(out.devRunning, 0);
    assert.equal(out.advanced.length, 1);
    assert.equal(out.advanced[0].did, 'deliver');
    assert.equal(existsSync(path.join(repo, 'ops/pipeline/deliver/ready.md')), true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The QA job is spawned, and the sweep writes `qa: {status:'running', pid}` for
 * it. The child boots seconds later, reads that record, and used to conclude
 * "somebody else owns this stage" — so it did nothing, exited 0, wrote an empty
 * log, and the sweep reported the UAT as a crash. The pid is what separates the
 * two readings.
 */
test('the QA job recognises the record the sweep wrote for it, and only that one', () => {
  assert.equal(ownsQaStage({}, { inline: true, pid: 42 }), true, 'no record yet: the job is first');
  assert.equal(ownsQaStage({ qa: { status: 'running', pid: 42 } }, { inline: true, pid: 42 }), true, 'my own pid');
  assert.equal(ownsQaStage({ qa: { status: 'running', pid: 7 } }, { inline: true, pid: 42 }), false, 'another job owns it');
  assert.equal(ownsQaStage({ qa: { status: 'failed', pid: 42 } }, { inline: true, pid: 42 }), true, 'a retry of my own run');
  assert.equal(ownsQaStage({ qa: { status: 'running', pid: 42 } }, { inline: false, pid: 42 }), false, 'a sweep never runs the browser');
});

test('an idea run that does nothing says why, instead of logging an empty file', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-quiet-'));
  const { dir, store } = await storeWith([{ id: 'held', title: 'held' }]);
  const stateFile = path.join(dir, 'ideas.json');
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await store.decide('held', 'accepted');
    // A live UAT owned by somebody else: this run must not drive the browser.
    await store.setPipeline('held', { status: 'running', stages: { dev: { status: 'done' }, qa: { status: 'running', pid: 1 } } });
    await mkdir(path.join(repo, 'ops/pipeline/state'), { recursive: true });
    await writeFile(
      path.join(repo, 'ops/pipeline/state/held.json'),
      JSON.stringify({ id: 'held', status: 'running', stages: { dev: { status: 'done' }, qa: { status: 'running', pid: 1 } } }, null, 2),
      'utf8',
    );

    const out = await run('node', ['ops/pipeline/run.mjs', '--idea', 'held', '--stage', 'qa'], {
      // The script lives in this checkout; MERGECREW_REPO is what redirects the
      // artefacts, so the fixture repo never needs an ops/ tree of its own.
      cwd: path.resolve(new URL('../../..', import.meta.url).pathname),
      env: { ...process.env, IDEATION_STATE_FILE: stateFile, MERGECREW_REPO: repo, PIPELINE_DEV_AGENT: 'off' },
    });
    assert.match(out.stdout, /nothing to do for held/);
    assert.equal(existsSync(path.join(repo, 'ops/pipeline/uat/held')), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
