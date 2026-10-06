/**
 * Tests for the primitive CI loop itself.
 *
 * The loop is driven as a real child process against a throwaway git repo, so
 * these exercise the thing that actually runs under systemd: fail-fast, the
 * state file, and the deploy hook gate. `CI_STATE_DIR` keeps the real
 * `ops/ci/state/` untouched.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { shouldRun } from '../ci-loop.mjs';

const LOOP = fileURLToPath(new URL('../ci-loop.mjs', import.meta.url));

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

const git = (repo, ...args) =>
  run('git', ['-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });

/**
 * Build a throwaway repo with one commit and return its paths plus a runner for
 * the CI loop that points every knob at the fixture.
 */
async function fixture(t, { checks, deploy } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = path.join(root, 'repo');
  const ciDir = path.join(root, 'ci');
  await mkdir(repo, { recursive: true });
  await mkdir(ciDir, { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# fixture\n');

  await git(repo, 'init', '-q');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'chore: fixture');

  const head = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/, 'fixture repo must have a real HEAD');

  const checksFile = path.join(ciDir, 'checks.conf');
  await writeFile(checksFile, `${checks.join('\n')}\n`);

  // Always explicit: the hook lives next to ci-loop.mjs in production, so a
  // fixture that leaves it unset would silently test the real repository.
  const deployPath = path.join(ciDir, 'deploy.sh');
  if (deploy !== undefined) {
    await writeFile(deployPath, deploy);
    await execFile('chmod', ['+x', deployPath]);
  }

  const stateDir = path.join(ciDir, 'state');
  return {
    root,
    repo,
    head,
    stateDir,
    stateFile: path.join(stateDir, 'last-run.json'),
    logFile: path.join(stateDir, 'ci.log'),
    runLoop: (extraArgs = ['--once']) =>
      run(process.execPath, [LOOP, ...extraArgs], {
        cwd: repo,
        env: {
          ...process.env,
          MERGECREW_REPO: repo,
          CI_CHECKS_FILE: checksFile,
          CI_STATE_DIR: stateDir,
          CI_DEPLOY_HOOK: deployPath,
          CI_CHECK_TIMEOUT_SECONDS: '30',
          CI_POLL_SECONDS: '5',
        },
      }),
  };
}

test('a green pipeline records pass with per-check evidence', async (t) => {
  const fx = await fixture(t, { checks: ['echo first', 'echo second'] });
  const { code, stdout } = await fx.runLoop();
  assert.equal(code, 0, stdout);
  assert.match(stdout, /pass echo first \(/);
  assert.match(stdout, /pass echo second \(/);

  const state = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.equal(state.status, 'pass');
  assert.equal(state.head, fx.head);
  assert.equal(state.checks.length, 2);
  assert.deepEqual(state.checks.map((c) => c.status), ['pass', 'pass']);
  assert.equal(state.deploy, null, 'no deploy hook installed means no deploy step');
  assert.ok(state.branch.length > 0);

  const logBody = await readFile(fx.logFile, 'utf8');
  assert.match(logBody, new RegExp(`pass ${fx.head} all checks passed`));
});

test('the first failing check stops the pipeline and is recorded with its output', async (t) => {
  const fx = await fixture(t, {
    checks: ['echo ok', 'echo exploding >&2; exit 7', 'touch must-not-run'],
  });
  const { stdout } = await fx.runLoop();
  assert.match(stdout, /fail/);

  const state = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.equal(state.status, 'fail');
  assert.equal(state.checks.length, 2, 'the third check must never run after a failure');
  assert.equal(state.checks[1].status, 'fail');
  assert.equal(state.checks[1].exitCode, 7);
  assert.match(state.checks[1].tail, /exploding/);
  assert.equal(await exists(path.join(fx.repo, 'must-not-run')), false, 'fail-fast violated');
});

test('the deploy hook runs only after every check passed', async (t) => {
  const fx = await fixture(t, {
    checks: ['echo ok'],
    deploy: '#!/bin/sh\necho "deployed $CI_HEAD" > deployed.txt\n',
  });
  await fx.runLoop();

  const state = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.equal(state.status, 'pass');
  assert.equal(state.deploy.status, 'pass');
  assert.equal(state.deploy.exitCode, 0);
  const marker = await readFile(path.join(fx.repo, 'deployed.txt'), 'utf8');
  assert.match(marker, /deployed/);
});

test('a failing check blocks the deploy hook', async (t) => {
  const fx = await fixture(t, {
    checks: ['exit 1'],
    deploy: '#!/bin/sh\ntouch deployed.txt\n',
  });
  await fx.runLoop();

  const state = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.equal(state.status, 'fail');
  assert.equal(state.deploy, null, 'a red pipeline must not deploy');
  assert.equal(await exists(path.join(fx.repo, 'deployed.txt')), false);
});

test('checks.conf comments and blank lines are ignored, inline comments stripped', async (t) => {
  const fx = await fixture(t, {
    checks: ['# a header comment', '', 'echo real-check  # trailing note', '# echo disabled'],
  });
  await fx.runLoop();

  const state = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.equal(state.checks.length, 1);
  assert.equal(state.checks[0].cmd, 'echo real-check');
  assert.equal(state.status, 'pass');
});

test('shouldRun re-runs on a new commit or a changed check configuration', () => {
  const head = { sha: 'a'.repeat(40), branch: 'main', subject: 'x' };
  assert.equal(shouldRun(null, head, 'hash1'), true, 'nothing recorded yet');
  assert.equal(shouldRun({ status: 'pass', head: head.sha, checksHash: 'hash1' }, head, 'hash1'), false, 'same commit, same checks');
  assert.equal(shouldRun({ status: 'pass', head: 'b'.repeat(40), checksHash: 'hash1' }, head, 'hash1'), true, 'new commit');
  assert.equal(shouldRun({ status: 'pass', head: head.sha, checksHash: 'hash2' }, head, 'hash1'), true, 'checks.conf changed');
  assert.equal(shouldRun({ status: 'pass', head: head.sha }, head, 'hash1'), true, 'legacy state without a fingerprint re-runs once');
  assert.equal(shouldRun({ status: 'pass', head: head.sha, checksHash: 'hash1' }, { sha: null }, 'hash1'), false, 'no head, nothing to do');
  assert.equal(shouldRun({}, head, 'hash1'), true, 'state without a status is not a result');
});

test('watch mode runs at startup and stops promptly on SIGTERM', async (t) => {
  const fx = await fixture(t, { checks: ['echo watching'] });
  const child = spawn(process.execPath, [LOOP], {
    cwd: fx.repo,
    env: {
      ...process.env,
      MERGECREW_REPO: fx.repo,
      CI_CHECKS_FILE: path.join(fx.root, 'ci', 'checks.conf'),
      CI_STATE_DIR: fx.stateDir,
      CI_DEPLOY_HOOK: path.join(fx.root, 'ci', 'deploy.sh'),
      CI_POLL_SECONDS: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (b) => {
    out += b.toString();
  });
  child.stderr.on('data', (b) => {
    out += b.toString();
  });

  // A loaded box (this file's siblings run in parallel, and the systemd loop
  // may be running the real pipeline) can stretch a spawn + git call well past
  // a second, so the deadline is generous on purpose: a slow box must not look
  // like a broken loop.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !/pipeline pass/.test(out)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(out, /mode=watch/);
  assert.match(out, /startup: running pipeline for/, `no startup run: ${out}`);
  assert.match(out, /pipeline pass/);

  const state = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.equal(state.status, 'pass');
  assert.ok(state.checksHash, 'the record keeps the checks fingerprint');

  const sentAt = Date.now();
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.on('close', resolve));
  const stopMs = Date.now() - sentAt;
  assert.equal(code, 0);
  assert.ok(stopMs < 3000, `SIGTERM must not wait out the 5s poll interval (took ${stopMs}ms)`);
});

test('watch mode publishes a heartbeat you can inspect without the journal', async (t) => {
  const fx = await fixture(t, { checks: ['echo beat'] });
  const child = spawn(process.execPath, [LOOP], {
    cwd: fx.repo,
    env: {
      ...process.env,
      MERGECREW_REPO: fx.repo,
      CI_CHECKS_FILE: path.join(fx.root, 'ci', 'checks.conf'),
      CI_STATE_DIR: fx.stateDir,
      CI_DEPLOY_HOOK: path.join(fx.root, 'ci', 'deploy.sh'),
      CI_POLL_SECONDS: '5',
      CI_HEARTBEAT_EVERY: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => {
    out += b.toString();
  });
  child.stderr.on('data', (b) => {
    out += b.toString();
  });

  // Two polls cost two intervals, and ci-loop clamps the interval to a 5s floor
  // (so a typo cannot hot-loop). ~10s is therefore the floor for this test, and
  // the deadline has to leave room for a busy box on top of that.
  const beatFile = path.join(fx.stateDir, 'heartbeat.json');
  const deadline = Date.now() + 45_000;
  let beat = null;
  while (Date.now() < deadline) {
    try {
      beat = JSON.parse(await readFile(beatFile, 'utf8'));
      if (beat.polls >= 2) break;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));

  assert.ok(beat, `heartbeat.json was never written: ${out}`);
  assert.equal(beat.pid, child.pid);
  assert.equal(beat.phase, 'watching');
  assert.equal(beat.pollMs, 5000);
  assert.equal(beat.lastStatus, 'pass', 'the heartbeat reports the last pipeline result');
  assert.ok(Date.parse(beat.nextPollAt) > Date.parse(beat.at), 'next poll is in the future');
  assert.match(out, /alive: \d+ polls/, 'the periodic alive line is logged');

  // A stopped loop must say so rather than leaving a heartbeat that looks live.
  const stopped = JSON.parse(await readFile(beatFile, 'utf8'));
  assert.equal(stopped.phase, 'stopped');
});
