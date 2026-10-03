/**
 * QA for a change that has no screen: run the repository's own checks.
 *
 * A chore is maintenance work — a red build, an untested area, a TODO cluster —
 * and a refactor keeps behaviour while moving code. Neither has a user-visible
 * surface, so driving a browser and recording a demo would cost a headless
 * Chromium, a port and a video to prove nothing: the acceptance oracle is
 * `ops/ci/checks.conf`, the same list CI runs, executed in the worktree.
 *
 * Two rules keep the verdict honest, because this record is what the human at
 * the review gate reads:
 *
 *   - a check that cannot run is reported as `skipped` with its reason. It is
 *     never a pass (the record would claim coverage it does not have) and never
 *     a failure (a worktree is a fresh checkout with no `node_modules`, so the
 *     dependency-installing checks cannot run there — blaming the change for
 *     that would fail every chore for the same non-reason);
 *   - `verdict` is `pass` only when at least one check actually ran and nothing
 *     failed. A run where everything was skipped is `not-run`, and the pipeline
 *     treats that as blocked rather than as a green light.
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Relative to the repository root, and also relative to the worktree. */
export const CHECKS_FILE = 'ops/ci/checks.conf';
export const CHECK_TIMEOUT_MS = Math.max(1_000, Number(process.env.PIPELINE_CHECK_TIMEOUT_MS ?? 15 * 60_000));
/** How much of a failing check's output is kept as evidence. */
const MAX_EVIDENCE_CHARS = 600;
/** Commands that need installed dependencies to mean anything. */
const NEEDS_DEPS = /^(pnpm|npm|yarn|npx|bun)\b/;

/**
 * checks.conf: one shell command per line, `#` comments and blanks skipped.
 * Same parse as `ops/ci/ci-loop.mjs`, so the chore is judged by the list CI
 * judges the branch by — a second parser that drifted would be worse than none.
 */
export function parseChecks(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/\s+#\s.*$/, '').trim())
    .filter(Boolean);
}

export function needsDependencies(command) {
  return NEEDS_DEPS.test(String(command ?? '').trim());
}

/** The check list as it exists in this tree (the worktree, not the checkout). */
export async function readChecks(dir) {
  try {
    return parseChecks(await readFile(path.join(dir, CHECKS_FILE), 'utf8'));
  } catch {
    return [];
  }
}

/** Run one shell command in `cwd`, capturing combined output. Never throws. */
export function runCheck(command, { cwd, timeoutMs = CHECK_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...env, CI: '1' },
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
      resolve({ command, exitCode, out, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      out += `\n[pipeline] spawn error: ${err.message}`;
      done(127);
    });
    child.on('close', (code, signal) => done(code ?? (signal ? 124 : 1)));
  });
}

/** `pass` only if something ran and nothing failed; `not-run` if nothing ran. */
export function verdictOf(results = [], skipped = []) {
  if (results.some((r) => r.status === 'failed')) return 'fail';
  if (results.length === 0) return skipped.length ? 'not-run' : 'fail';
  return 'pass';
}

function tail(text, max = MAX_EVIDENCE_CHARS) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= max) return trimmed;
  return `…${trimmed.slice(-max)}`;
}

/**
 * Run every check that can run here, and account for the ones that cannot.
 *
 * Returns the record the pipeline stores at `pipeline.qa` for a checks-mode
 * card. There is deliberately no `demo`, `port` or `frames`: a chore produces a
 * changelog, and a field that is always empty invites the UI to render a link
 * to nothing.
 */
export async function runChecks({ dir, log = () => {}, timeoutMs = CHECK_TIMEOUT_MS, at = new Date().toISOString() } = {}) {
  const declared = await readChecks(dir);
  const skipped = [];
  if (declared.length === 0) {
    return {
      mode: 'checks',
      status: 'done',
      verdict: 'not-run',
      results: [],
      skipped: [],
      ranAt: at,
      reason: `no ${CHECKS_FILE} in the worktree: there is nothing to run, so nothing is claimed`,
    };
  }

  // `pnpm --filter … test` in a worktree fails on a missing node_modules, which
  // says nothing about the change. The dependency-free checks (the `node --test`
  // lines) are the ones that actually judge a chore's branch here.
  const hasDeps = await stat(path.join(dir, 'node_modules')).then((s) => s.isDirectory()).catch(() => false);
  const commands = declared.filter((command) => {
    if (needsDependencies(command) && !hasDeps) {
      skipped.push({
        command,
        reason: 'needs installed dependencies, and a worktree is a fresh checkout without node_modules',
      });
      log(`  skip ${command} (no node_modules in the worktree)`);
      return false;
    }
    return true;
  });

  const results = [];
  for (const command of commands) {
    const r = await runCheck(command, { cwd: dir, timeoutMs });
    const status = r.exitCode === 0 && !r.timedOut ? 'passed' : 'failed';
    results.push({
      command,
      status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      evidence: tail(r.out),
    });
    log(`  ${status} ${command} (${r.durationMs}ms, exit ${r.exitCode}${r.timedOut ? ', timeout' : ''})`);
  }
  const verdict = verdictOf(results, skipped);
  return {
    mode: 'checks',
    status: 'done',
    verdict,
    results,
    skipped,
    ranAt: at,
    ...(verdict === 'not-run'
      ? {
          reason: `no check could run here (${skipped.length} need installed dependencies): the branch is unverified, not verified`,
        }
      : {}),
  };
}

/** One line for the changelog and the deck: `3 checks passed, 3 skipped`. */
export function summariseChecks(qa = {}) {
  const passed = (qa.results ?? []).filter((r) => r.status === 'passed').length;
  const failed = (qa.results ?? []).filter((r) => r.status === 'failed').length;
  const skipped = (qa.skipped ?? []).length;
  const parts = [`${passed} passed`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(', ');
}

