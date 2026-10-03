#!/usr/bin/env node
/**
 * Sandcastle execution runner.
 *
 * Takes one accepted idea task file, hands it to a sandcastle agent, and writes
 * an outcome file the ideation service reconciles. It is the ONLY place that
 * spawns an agent, and it refuses to pretend:
 *
 *   - sandcastle not installed  -> blocked, exit 3, reason recorded
 *   - API shape unexpected      -> blocked, exit 3, reason recorded
 *   - container runtime required but missing -> blocked, exit 3
 *   - agent exit non-zero       -> failed, exit 1, output tail recorded
 *
 * It never writes `done` unless the agent actually exited 0.
 *
 * NOTE: the import below targets the documented public API of
 * `@ai-hero/sandcastle` (`run` + an agent factory + a sandbox provider). The
 * package is intentionally NOT vendored into this repo; install it with
 * `pnpm --dir ops/execution install` and re-check `SANDBOX_API` against the
 * installed version before trusting an execution result.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, 'state');
const TAIL_CHARS = 6000;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const taskPath = arg('task');
const repo = arg('repo', path.resolve(HERE, '..', '..'));
if (!taskPath) {
  console.error('usage: sandcastle-runner.mjs --task <file.md> [--repo <dir>]');
  process.exit(2);
}

const taskBody = await readFile(taskPath, 'utf8');
const ideaId = /- idea-id: (\S+)/.exec(taskBody)?.[1] ?? path.basename(taskPath, '.md');

async function finish(outcome) {
  await mkdir(STATE_DIR, { recursive: true });
  const record = { ideaId, taskFile: path.relative(repo, taskPath), ...outcome, finishedAt: new Date().toISOString() };
  await writeFile(path.join(STATE_DIR, `${ideaId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(record));
  process.exit(outcome.status === 'done' ? 0 : outcome.status === 'failed' ? 1 : 3);
}

function run(cmd, args, { timeoutMs = 45 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const cap = (b) => {
      out += b.toString();
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, out: `${out}\nspawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, out });
    });
  });
}

const sandboxMode = process.env.SANDCASTLE_SANDBOX ?? 'none'; // docker daemon is down on this host

let mod;
try {
  mod = await import('@ai-hero/sandcastle');
} catch (err) {
  await finish({
    status: 'blocked',
    reason: `@ai-hero/sandcastle not installed (${err?.code ?? err?.message}). Run: pnpm --dir ops/execution install`,
    exitCode: null,
  });
}

if (typeof mod.run !== 'function' || typeof mod.claudeCode !== 'function') {
  await finish({
    status: 'blocked',
    reason: 'installed sandcastle does not expose run()/claudeCode() — confirm the API for this version before executing',
    exitCode: null,
  });
}

if (sandboxMode === 'docker' || sandboxMode === 'podman') {
  const probe = await run(sandboxMode, ['info'], { timeoutMs: 20_000 });
  if (probe.exitCode !== 0) {
    await finish({
      status: 'blocked',
      reason: `${sandboxMode} daemon unavailable: ${probe.out.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`,
      exitCode: null,
    });
  }
}

const prompt = [
  'You are an execution agent working directly in this repository.',
  '',
  taskBody,
  '',
  'Rules:',
  '- Ship the smallest change that satisfies the definition of done.',
  '- Run the verify command(s) you recorded; paste the real output in your summary.',
  '- Do not modify ops/ci/checks.conf or any test to make a failure disappear.',
  '- If the task is impossible as written, stop and say so instead of faking completion.',
].join('\n');

let sandbox;
try {
  const sandboxMod = await import('@ai-hero/sandcastle/sandboxes/docker');
  sandbox = sandboxMode === 'none' && typeof mod.noSandbox === 'function' ? mod.noSandbox() : sandboxMod.docker();
} catch {
  sandbox = typeof mod.noSandbox === 'function' ? mod.noSandbox() : null;
}

if (!sandbox) {
  await finish({ status: 'blocked', reason: 'no usable sandbox provider exported by sandcastle', exitCode: null });
}

try {
  const result = await mod.run({ agent: mod.claudeCode(), sandbox, prompt });
  const tail = JSON.stringify(result ?? {}).slice(-TAIL_CHARS);
  const exitCode = Number(result?.exitCode ?? 0);
  await finish({
    status: exitCode === 0 ? 'done' : 'failed',
    exitCode,
    summary: tail,
  });
} catch (err) {
  await finish({ status: 'failed', reason: `sandcastle run threw: ${err?.message ?? err}`, exitCode: null });
}
