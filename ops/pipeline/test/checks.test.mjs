/**
 * The check runner is what a chore and a refactor are judged by, so its honest
 * failure modes matter more than its happy path: a check that could not run must
 * never be recorded as one that passed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { needsDependencies, parseChecks, readChecks, runChecks, summariseChecks, verdictOf } from '../lib/checks.mjs';

async function worktree(conf) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-checks-'));
  if (conf !== null) {
    await mkdir(path.join(dir, 'ops/ci'), { recursive: true });
    await writeFile(path.join(dir, 'ops/ci/checks.conf'), conf, 'utf8');
  }
  return dir;
}

test('parseChecks reads the same file the CI loop reads', () => {
  const text = [
    '# the commands CI runs, in order',
    '',
    'node --test "ops/ci/test/*.test.mjs"',
    'pnpm -w lint:no-raw-sql   # the raw-SQL guard',
    '   node --test "ops/ideation/test/*.test.mjs"   ',
    '# a commented-out check stays commented out',
    '# pnpm -w typecheck',
  ].join('\n');

  assert.deepEqual(parseChecks(text), [
    'node --test "ops/ci/test/*.test.mjs"',
    'pnpm -w lint:no-raw-sql',
    'node --test "ops/ideation/test/*.test.mjs"',
  ]);
  assert.deepEqual(parseChecks(''), []);
  assert.deepEqual(parseChecks(null), []);
});

test('a command that needs installed dependencies is recognised, not run and blamed', () => {
  assert.equal(needsDependencies('pnpm --filter @mergecrew/web exec tsc --noEmit'), true);
  assert.equal(needsDependencies('npm test'), true);
  assert.equal(needsDependencies('yarn lint'), true);
  assert.equal(needsDependencies('npx tsc --noEmit'), true);
  assert.equal(needsDependencies('node --test "ops/ci/test/*.test.mjs"'), false);
  // A path that merely contains the word is not a package manager.
  assert.equal(needsDependencies('./node_modules/.bin/eslint .'), false);
});

test('the verdict is a claim about evidence, so an empty run is not a pass', () => {
  assert.equal(verdictOf([{ status: 'passed' }, { status: 'passed' }], []), 'pass');
  assert.equal(verdictOf([{ status: 'passed' }, { status: 'failed' }], []), 'fail');
  assert.equal(verdictOf([], [{ command: 'pnpm test', reason: 'needs deps' }]), 'not-run');
  assert.equal(verdictOf([], []), 'fail', 'a worktree with no checks at all is unproven'); 
});

test('runChecks runs the dependency-free commands and names the ones it skipped', async () => {
  const dir = await worktree(
    [
      '# in the order CI runs them',
      'node -e "process.exit(0)"',
      'node -e "console.log(\'evidence line\')"',
      'pnpm --filter @mergecrew/web exec tsc --noEmit',
    ].join('\n'),
  );
  try {
    const lines = [];
    const qa = await runChecks({ dir, log: (line) => lines.push(line) });

    assert.equal(qa.mode, 'checks');
    assert.equal(qa.status, 'done');
    assert.equal(qa.verdict, 'pass');
    assert.equal(qa.results.length, 2);
    assert.equal(qa.results.every((r) => r.status === 'passed'), true);
    assert.equal(qa.results[1].evidence, 'evidence line', 'the output is kept as the evidence');
    assert.equal(typeof qa.results[0].durationMs, 'number');

    assert.equal(qa.skipped.length, 1);
    assert.match(qa.skipped[0].command, /tsc --noEmit/);
    assert.match(qa.skipped[0].reason, /needs installed dependencies/);
    assert.equal(typeof qa.ranAt, 'string');

    // The operator watching the job sees what happened, in the log the sweep reads.
    assert.equal(lines.some((l) => /passed node -e/.test(l)), true);
    assert.equal(lines.some((l) => /skip pnpm/.test(l)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing check fails the run and keeps the output that says why', async () => {
  const dir = await worktree(['node -e "process.exit(0)"', 'node -e "console.error(\'boom\'); process.exit(3)"'].join('\n'));
  try {
    const qa = await runChecks({ dir });
    assert.equal(qa.verdict, 'fail');
    assert.equal(qa.results[0].status, 'passed');
    assert.equal(qa.results[1].status, 'failed');
    assert.equal(qa.results[1].exitCode, 3);
    assert.match(qa.results[1].evidence, /boom/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a worktree with only dependency-installing checks is unverified, not verified', async () => {
  const dir = await worktree('pnpm -w lint:no-raw-sql\n');
  try {
    const qa = await runChecks({ dir });
    assert.equal(qa.verdict, 'not-run');
    assert.equal(qa.results.length, 0);
    assert.match(qa.reason, /unverified, not verified/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a worktree with no checks.conf says so instead of inventing a pass', async () => {
  const dir = await worktree(null);
  try {
    assert.deepEqual(await readChecks(dir), []);
    const qa = await runChecks({ dir });
    assert.equal(qa.verdict, 'not-run');
    assert.deepEqual(qa.results, []);
    assert.deepEqual(qa.skipped, []);
    assert.match(qa.reason, /no ops\/ci\/checks\.conf/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summariseChecks is one line a human reads at the gate', () => {
  assert.equal(summariseChecks({ results: [{ status: 'passed' }, { status: 'passed' }], skipped: [] }), '2 passed');
  assert.equal(
    summariseChecks({ results: [{ status: 'passed' }, { status: 'failed' }], skipped: [{}, {}] }),
    '1 passed, 1 failed, 2 skipped',
  );
  assert.equal(summariseChecks({}), '0 passed');
});
