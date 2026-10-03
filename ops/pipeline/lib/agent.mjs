/**
 * Spawning the dev agent that implements one idea, inside its own worktree.
 *
 * Why a CLI agent and not an API call: the operator's machine already has
 * authenticated agent CLIs (`claude`, `pi`, and the DeepSeek Harness `dsh`) and
 * the repository already treats `@ai-hero/sandcastle` as an optional
 * orchestrator. This module therefore *detects* what is available, records
 * exactly which command it ran, and reports `blocked` with the real reason when
 * nothing is — it never pretends an agent ran.
 *
 * Autonomy note: the child runs with permission checks bypassed. That is only
 * defensible because it is confined to a throwaway git worktree that the main
 * checkout does not read, and because the alternative (a denied Bash tool) makes
 * the agent unable to run the very tests it is asked to run. The flag is still
 * overridable through DEV_AGENT_FLAGS so an operator can tighten it.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const DEFAULT_PROMPT_FILE = 'TASK.md';

const AGENTS = {
  claude: {
    binary: (env = process.env) => env.CLAUDE_BIN ?? 'claude',
    args: (promptFile, { model } = {}) => {
      const flags = (process.env.DEV_AGENT_FLAGS ?? '--dangerously-skip-permissions').split(' ').filter(Boolean);
      return ['-p', `Read ${promptFile} and do the task it describes.`, ...flags, ...(model ? ['--model', model] : [])];
    },
  },
  pi: {
    binary: (env = process.env) => env.PI_BIN ?? 'pi',
    args: (promptFile) => [`Read ${promptFile} and do the task it describes.`],
  },
  // The DeepSeek Harness CLI, present on this operator's machine at
  // ~/.local/bin/dsh. It was added after both other providers turned out to be
  // reachable-but-dead here: `claude` and `pi` share the ai.yay.how gateway,
  // which answered every request with `[claude-code:unrecognized_model]` /
  // `ALL_TARGETS_SKIPPED` while `dsh headless` ran the same task end to end
  // (probe: it read a TASK.md, wrote the file it asked for, verified it with
  // wc -c, exited 0). "Available" here still means the binary exists — callers
  // classify a provider outage from the log tail, see classifyAgentFailure.
  dsh: {
    binary: (env = process.env) => env.DSH_BIN ?? 'dsh',
    args: (promptFile) => ['headless', `Read ${promptFile} and do the task it describes.`],
  },
  sandcastle: {
    binary: (env = process.env) => env.SANDCASTLE_BIN ?? 'npx',
    args: () => null, // handled by ops/execution/sandcastle-runner.mjs, not here
  },
};

async function isExecutable(p) {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which agent will run, and the exact command line. `available: false` carries
 * a reason a human can act on.
 */
export async function resolveAgent({ provider = process.env.DEV_AGENT ?? 'auto', env = process.env, check = isExecutable } = {}) {
  const order = provider === 'auto' ? ['claude', 'pi', 'dsh'] : [provider];
  for (const name of order) {
    const spec = AGENTS[name];
    if (!spec) return { provider: name, available: false, reason: `unknown DEV_AGENT "${name}" (expected auto|claude|pi|dsh)` };
    const binary = spec.binary(env);
    if (await check(binary)) {
      return { provider: name, available: true, binary, reason: null };
    }
    const found = await which(binary, env.PATH ?? '', check);
    if (found) return { provider: name, available: true, binary: found, reason: null };
  }
  return {
    provider: order[0] ?? provider,
    available: false,
    reason: `no usable dev agent on PATH (tried: ${order.join(', ')}) — install one or set DEV_AGENT`,
  };
}

async function which(binary, pathEnv, check = isExecutable) {
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    const candidate = path.join(dir, binary);
    if (await check(candidate)) return candidate;
  }
  return null;
}

export function buildCommand({ provider, bin, promptFile = DEFAULT_PROMPT_FILE, model } = {}) {
  const spec = AGENTS[provider];
  if (!spec) throw new Error(`unknown agent provider ${provider}`);
  return { command: bin, args: spec.args(promptFile, { model }) };
}

/**
 * The environment the agent gets. The pipeline's own control knobs are stripped:
 * a dev agent that inherits `PIPELINE_DEV_AGENT=on` runs the pipeline's own test
 * suite under a different contract — `ops/pipeline/test/run.test.mjs` documents
 * its assumption that the variable is off, so the agent sees a real spawn where
 * the test expects `dev-skipped` and the suite fails for a reason that has
 * nothing to do with its change (observed 2026-10-03, from inside a dev agent).
 */
export function childEnv(env = process.env, idea = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('PIPELINE_')) continue;
    out[key] = value;
  }
  if (idea.id) out.MERGECREW_IDEA_ID = idea.id;
  return out;
}

/**
 * Start the agent and return immediately (the caller is a long-running sweep,
 * it must not block for the whole feature). Output goes to the idea's log file
 * so the pipeline — and the human reviewing it — can see what happened.
 */
export async function spawnDevAgent({
  worktree,
  idea,
  logDir,
  provider = process.env.DEV_AGENT ?? 'auto',
  model = process.env.DEV_AGENT_MODEL,
  spawnImpl = nodeSpawn,
  check = isExecutable,
  promptFile = DEFAULT_PROMPT_FILE,
  env = process.env,
  log = () => {},
} = {}) {
  await mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${idea.id}.agent.log`);
  const agent = await resolveAgent({ provider, check, env });
  if (!agent.available) {
    log(`no dev agent available: ${agent.reason}`);
    return { status: 'blocked', reason: agent.reason, provider: agent.provider, logFile: null, pid: null, command: null };
  }

  const { command, args } = buildCommand({ provider: agent.provider, bin: agent.binary, promptFile, model });

  // Point the child's stdout/stderr straight at the log file instead of piping.
  // A detached child outlives this process, so anything buffered in the parent
  // would be lost the moment the sweep exits — which is exactly when the log
  // matters most.
  const fd = await open(logFile, 'a');
  const child = spawnImpl(command, args, {
    cwd: worktree,
    detached: true,
    env: childEnv(env, idea),
    stdio: ['ignore', fd.fd, fd.fd],
  });
  await fd.close().catch(() => {});
  child.on('error', (err) => log(`dev agent for ${idea.id} failed to start: ${err?.message ?? err}`));
  child.unref?.();

  log(`dev agent spawned for ${idea.id}: ${command} ${args.join(' ')} (pid ${child.pid})`);
  return {
    status: 'running',
    provider: agent.provider,
    command: [command, ...args].join(' '),
    pid: child.pid ?? null,
    logFile,
    cwd: worktree,
    startedAt: new Date().toISOString(),
    reason: null,
  };
}

/** Tail of the agent log, for the review page and the failure report. */
export async function readAgentLog(logFile, { max = 4000 } = {}) {
  try {
    const body = await readFile(logFile, 'utf8');
    return body.length > max ? `…${body.slice(-max)}` : body;
  } catch {
    return null;
  }
}

/**
 * Signatures of "the agent never reached a model", as opposed to "the agent ran
 * and did not finish the job". The distinction decides whether retrying is
 * worthwhile: a provider outage will fail exactly the same way every time, and
 * calling that a plain failure sends people looking for a bug in the task.
 *
 * Every pattern here was observed in a real log tail from this repository, not
 * invented: `API Error: 524 ... origin_response_timeout` from the
 * ai.yay.how gateway, `[claude-code:unrecognized_model]`, and pi's
 * `ALL_TARGETS_SKIPPED` 503.
 */
const UPSTREAM_PATTERNS = [
  /API Error: 5\d\d\b[^\n]*/i,
  /unrecognized_model/i,
  /ALL_TARGETS_SKIPPED/,
  /Service temporarily unavailable/i,
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i,
];

/** Classify an agent's log tail: `provider-outage` means "retrying is pointless". */
export function classifyAgentFailure(logTail) {
  if (!logTail) return { kind: 'no-output', detail: 'the agent wrote nothing to its log' };
  for (const pattern of UPSTREAM_PATTERNS) {
    const match = logTail.match(pattern);
    if (match) {
      const line = match[0].trim().split('\n')[0].slice(0, 200);
      return { kind: 'provider-outage', detail: line };
    }
  }
  return { kind: 'no-report', detail: 'the agent exited without leaving a report' };
}
