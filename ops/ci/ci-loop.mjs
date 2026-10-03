/**
 * Primitive CI/CD loop.
 *
 * Runs forever under systemd (`Type=simple`, `Restart=always`). Every
 * CI_POLL_SECONDS it compares `git rev-parse HEAD` against the SHA of the
 * last run; when the SHA changed it runs every command in `checks.conf` in
 * order, writes `state/last-run.json`, appends a line to `state/ci.log`, and
 * — when every check passed and `deploy.sh` exists — runs the deploy hook.
 * That hook is the entire "CD" story: primitive on purpose.
 *
 * Non-goals: queues, artifacts, parallel jobs, per-branch pipelines, retries.
 * One repo, one SHA at a time. A failing check never stops the loop; the loop
 * reports and systemd keeps it alive. If the loop dies, that is a bug.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.MERGECREW_REPO ?? path.resolve(HERE, '..', '..');
const STATE_DIR = process.env.CI_STATE_DIR ?? path.join(HERE, 'state');
const CHECKS_FILE = process.env.CI_CHECKS_FILE ?? path.join(HERE, 'checks.conf');
const DEPLOY_HOOK = process.env.CI_DEPLOY_HOOK ?? path.join(HERE, 'deploy.sh');
const POLL_MS = Math.max(5, Number(process.env.CI_POLL_SECONDS ?? 30)) * 1000;
const TIMEOUT_MS = Math.max(10, Number(process.env.CI_CHECK_TIMEOUT_SECONDS ?? 1800)) * 1000;
const HEARTBEAT_EVERY = Math.max(1, Number(process.env.CI_HEARTBEAT_EVERY ?? 20));
const TAIL_CHARS = 4000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fingerprint of the check configuration, so a changed pipeline re-runs. */
export async function checksFingerprint(file = CHECKS_FILE) {
  try {
    const raw = await readFile(file);
    return createHash('sha256').update(raw).digest('hex').slice(0, 12);
  } catch {
    return 'missing';
  }
}

/**
 * Decide whether a pipeline run is needed.
 *
 * A run is needed when the commit changed *or* when the checks themselves
 * changed — a "pass" recorded against a previous `checks.conf` says nothing
 * about the checks that are configured now, and silently keeping it would hide
 * a newly added failing check behind a stale green.
 */
export function shouldRun(recorded, head, checksHash) {
  if (!head?.sha) return false;
  if (!recorded?.status) return true;
  if (recorded.head !== head.sha) return true;
  return recorded.checksHash !== checksHash;
}

/** Run one shell command, capturing combined output. Never throws. */
function sh(cmd, { cwd = REPO, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const cap = (buf) => {
      out += buf.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const done = (exitCode) => {
      clearTimeout(timer);
      resolve({ cmd, exitCode, out, durationMs: Date.now() - started, timedOut });
    };
    child.on('error', (err) => {
      out += `\n[ci] spawn error: ${err.message}`;
      done(127);
    });
    child.on('close', (code, signal) => done(code ?? (signal ? 124 : 1)));
  });
}

async function gitHead() {
  const r = await sh('git rev-parse HEAD', { timeoutMs: 20_000 });
  if (r.exitCode !== 0) return { sha: null, branch: null, subject: null };
  const branch = (await sh('git rev-parse --abbrev-ref HEAD', { timeoutMs: 20_000 })).out.trim();
  const subject = (await sh('git log -1 --pretty=%s', { timeoutMs: 20_000 })).out.trim();
  return { sha: r.out.trim(), branch, subject };
}

/** checks.conf: one shell command per line; `#` comments and blanks skipped. */
async function readChecks() {
  let body;
  try {
    body = await readFile(CHECKS_FILE, 'utf8');
  } catch {
    return [];
  }
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/\s+#\s.*$/, '').trim())
    .filter(Boolean);
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

async function readState() {
  try {
    return JSON.parse(await readFile(path.join(STATE_DIR, 'last-run.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Liveness record. A loop that only writes something when a commit lands is
 * indistinguishable from a dead one, so every poll refreshes this file and
 * every HEARTBEAT_EVERY polls prints one line. Silence then means "nothing to
 * do", not "the service is gone".
 */
export async function readHeartbeat() {
  try {
    return JSON.parse(await readFile(path.join(STATE_DIR, 'heartbeat.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function beat(fields) {
  const next = {
    pid: process.pid,
    at: new Date().toISOString(),
    pollMs: POLL_MS,
    nextPollAt: new Date(Date.now() + POLL_MS).toISOString(),
    ...fields,
  };
  try {
    await writeJsonAtomic(path.join(STATE_DIR, 'heartbeat.json'), next);
  } catch (err) {
    log(`heartbeat write failed: ${err?.message ?? err}`);
  }
  return next;
}

async function fileExecutable(p) {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run every check, then the deploy hook only when everything passed. */
export async function runPipeline(head) {
  const startedAt = new Date().toISOString();
  const checks = await readChecks();
  const checksHash = await checksFingerprint();
  const results = [];
  let status = 'pass';

  log(`pipeline start ${head.sha?.slice(0, 8) ?? 'unknown'} (${checks.length} checks)`);

  for (const cmd of checks) {
    const r = await sh(cmd);
    const checkStatus = r.exitCode === 0 && !r.timedOut ? 'pass' : 'fail';
    if (checkStatus === 'fail') status = 'fail';
    results.push({
      cmd,
      status: checkStatus,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      tail: r.out.slice(-TAIL_CHARS),
    });
    log(`  ${checkStatus} ${cmd} (${r.durationMs}ms, exit ${r.exitCode}${r.timedOut ? ', timeout' : ''})`);
    if (checkStatus === 'fail') break; // fail fast: later checks would only add noise
  }

  let deploy = null;
  if (status === 'pass' && (await fileExecutable(DEPLOY_HOOK))) {
    const r = await sh(DEPLOY_HOOK, { timeoutMs: 600_000 });
    deploy = {
      cmd: DEPLOY_HOOK,
      status: r.exitCode === 0 ? 'pass' : 'fail',
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      tail: r.out.slice(-TAIL_CHARS),
    };
    if (deploy.status === 'fail') status = 'fail';
    log(`  deploy ${deploy.status} (exit ${r.exitCode})`);
  }

  const record = {
    head: head.sha,
    branch: head.branch,
    subject: head.subject,
    checksHash,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    checks: results,
    deploy,
  };
  await writeJsonAtomic(path.join(STATE_DIR, 'last-run.json'), record);
  await appendFile(
    path.join(STATE_DIR, 'ci.log'),
    `${record.finishedAt} ${status} ${head.sha ?? '?'} ${results.filter((c) => c.status === 'fail').map((c) => c.cmd).join(',') || 'all checks passed'}\n`,
    'utf8',
  );
  log(`pipeline ${status}`);
  return record;
}

async function main() {
  const once = process.argv.includes('--once');
  await mkdir(STATE_DIR, { recursive: true });
  log(`ci-loop repo=${REPO} poll=${POLL_MS / 1000}s checks=${CHECKS_FILE} mode=${once ? 'once' : 'watch'}`);

  if (once) {
    const head = await gitHead();
    await runPipeline(head);
    return;
  }

  let stop = false;
  let wake = null;
  const onSignal = (sig) => {
    log(`${sig} received — stopping`);
    stop = true;
    wake?.(); // do not sit out the rest of the poll interval on shutdown
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  const sleepOrStop = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const recorded = await readState();

  // A freshly started loop must be able to say something about the current
  // commit. Without this, a restart after a reboot leaves the last CI result
  // frozen at whatever the state file holds — or empty on a first boot.
  const boot = await gitHead();
  if (shouldRun(recorded, boot, await checksFingerprint())) {
    if (boot.sha) {
      log(`startup: running pipeline for ${boot.sha.slice(0, 8)} (${recorded?.status ? 'check configuration changed' : 'nothing recorded'})`);
    }
    await runPipeline(boot);
  } else if (boot.sha) {
    log(`startup: head ${boot.sha.slice(0, 8)} already reported (${recorded.status}) — watching for changes`);
  }

  let lastSha = boot.sha ?? recorded?.head ?? null;
  let polls = 0;
  await beat({ head: lastSha, polls, lastStatus: (await readState())?.status ?? null, phase: 'watching' });
  while (!stop) {
    await sleepOrStop(POLL_MS);
    if (stop) break;
    polls++;
    const head = await gitHead();
    if (!head.sha) {
      log('git head unavailable — retrying');
      await beat({ head: lastSha, polls, lastStatus: (await readState())?.status ?? null, phase: 'no-head' });
      continue;
    }
    const state = await readState();
    const run = shouldRun(state, head, await checksFingerprint());
    const hb = await beat({ head: head.sha, polls, lastStatus: state?.status ?? null, phase: run ? 'running' : 'watching' });
    if (polls % HEARTBEAT_EVERY === 0) {
      log(`alive: ${polls} polls, head ${head.sha.slice(0, 8)}, last result ${state?.status ?? 'none'}, next poll ${hb.nextPollAt}`);
    }
    if (!run) continue;
    lastSha = head.sha;
    await runPipeline(head);
    await beat({ head: head.sha, polls, lastStatus: 'running', phase: 'watching' });
  }
  await beat({ head: lastSha, polls, lastStatus: (await readState())?.status ?? null, phase: 'stopped' });
  log(`ci-loop stopped (last head ${lastSha?.slice(0, 8) ?? 'unknown'})`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
