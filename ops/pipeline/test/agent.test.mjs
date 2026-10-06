/**
 * The dev-agent stage is where "automatic" could most easily become a lie: a
 * pipeline that reports `running` when no agent binary exists, or that loses the
 * agent's output the moment the sweep exits, would look successful while doing
 * nothing. These tests pin the honest behaviours.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCommand,
  childEnv,
  classifyAgentFailure,
  readAgentLog,
  resolveAgent,
  sessionFromLog,
  spawnDevAgent,
} from '../lib/agent.mjs';

const idea = { id: 'idea-abc123', title: 'do a thing' };

test('resolveAgent reports blocked with an actionable reason when nothing is installed', async () => {
  const none = await resolveAgent({ provider: 'auto', env: { PATH: '/nonexistent' }, check: async () => false });
  assert.equal(none.available, false);
  assert.match(none.reason, /no usable dev agent on PATH/);
  assert.match(none.reason, /claude, pi/, 'names what it looked for');
});

test('resolveAgent honours DEV_AGENT, an absolute binary path, and rejects unknown providers', async () => {
  const claude = await resolveAgent({ provider: 'auto', env: { PATH: '/nonexistent' }, check: async (b) => b === 'claude' });
  assert.equal(claude.provider, 'claude');
  assert.equal(claude.available, true);

  const pi = await resolveAgent({ provider: 'pi', env: { PATH: '/nonexistent' }, check: async (b) => b === 'pi' });
  assert.equal(pi.provider, 'pi');

  // The DeepSeek Harness CLI is the provider that actually reaches a model on
  // this machine, so it must resolve both by name and through DSH_BIN.
  const dsh = await resolveAgent({ provider: 'dsh', env: { PATH: '/nonexistent' }, check: async (b) => b === 'dsh' });
  assert.equal(dsh.provider, 'dsh');
  assert.equal(dsh.available, true);
  const dshAbs = await resolveAgent({ provider: 'dsh', env: { PATH: '/x', DSH_BIN: '/home/u/.local/bin/dsh' }, check: async (b) => b === '/home/u/.local/bin/dsh' });
  assert.equal(dshAbs.binary, '/home/u/.local/bin/dsh');

  // auto still prefers claude when it exists, but dsh is the last fallback and
  // must be picked up when the earlier two are absent.
  const autoDsh = await resolveAgent({ provider: 'auto', env: { PATH: '/nonexistent' }, check: async (b) => b === 'dsh' });
  assert.equal(autoDsh.provider, 'dsh');

  const abs = await resolveAgent({ provider: 'claude', env: { PATH: '/x', CLAUDE_BIN: '/opt/claude' }, check: async (b) => b === '/opt/claude' });
  assert.equal(abs.binary, '/opt/claude');

  const bogus = await resolveAgent({ provider: 'gemini', env: { PATH: '/x' }, check: async () => true });
  assert.equal(bogus.available, false);
  assert.match(bogus.reason, /unknown DEV_AGENT "gemini"/);

  // found on PATH rather than directly executable at that relative name
  const viaPath = await resolveAgent({ provider: 'claude', env: { PATH: '/opt/bin' }, check: async (b) => b === '/opt/bin/claude' });
  assert.equal(viaPath.binary, '/opt/bin/claude');
});

test('buildCommand passes the briefing file and lets DEV_AGENT_FLAGS tighten the permissions', () => {
  const previous = process.env.DEV_AGENT_FLAGS;
  try {
    process.env.DEV_AGENT_FLAGS = '--permission-mode acceptEdits';
    const cmd = buildCommand({ provider: 'claude', bin: 'claude' });
    assert.equal(cmd.command, 'claude');
    assert.deepEqual(cmd.args, ['-p', 'Read TASK.md and do the task it describes.', '--permission-mode', 'acceptEdits']);
    assert.throws(() => buildCommand({ provider: 'nope', bin: 'x' }), /unknown agent provider/);
  } finally {
    if (previous === undefined) delete process.env.DEV_AGENT_FLAGS;
    else process.env.DEV_AGENT_FLAGS = previous;
  }

  // dsh takes the task as a positional argument to its one-shot subcommand, and
  // has no permission flag to pass through.
  const dsh = buildCommand({ provider: 'dsh', bin: 'dsh' });
  assert.equal(dsh.command, 'dsh');
  // --json is what makes the run findable in the harness web UI afterwards.
  assert.deepEqual(dsh.args, ['headless', '--json', 'Read TASK.md and do the task it describes.']);
});

function stubSpawn(captured) {
  return (command, args, options) => {
    captured.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    return child;
  };
}

test('spawnDevAgent runs detached in the worktree, logs to a file, and survives the parent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-agent-'));
  const captured = [];
  try {
    const result = await spawnDevAgent({
      worktree: dir,
      idea,
      logDir: path.join(dir, 'logs'),
      provider: 'claude',
      check: async () => true,
      spawnImpl: stubSpawn(captured),
    });

    assert.equal(result.status, 'running');
    assert.equal(result.pid, 4242);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].options.cwd, dir);
    assert.equal(captured[0].options.detached, true);
    assert.equal(captured[0].options.env.MERGECREW_IDEA_ID, idea.id);
    assert.equal(captured[0].options.stdio[0], 'ignore');
    // stdout/stderr are file descriptors, not pipes: a detached agent outlives
    // the sweep, and piped output would die with it.
    assert.equal(typeof captured[0].options.stdio[1], 'number');
    assert.equal(captured[0].options.stdio[1], captured[0].options.stdio[2]);
    assert.match(result.logFile, /idea-abc123\.agent\.log$/);
    assert.ok(result.command.startsWith('claude -p '));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawnDevAgent refuses to pretend: no agent means blocked and nothing is spawned', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-agent-'));
  const captured = [];
  try {
    const result = await spawnDevAgent({
      worktree: dir,
      idea,
      logDir: path.join(dir, 'logs'),
      provider: 'auto',
      check: async () => false,
      spawnImpl: stubSpawn(captured),
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.pid, null);
    assert.match(result.reason, /no usable dev agent/);
    assert.equal(captured.length, 0, 'nothing was executed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readAgentLog tails the end of the log and tolerates a missing file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-agent-'));
  try {
    const file = path.join(dir, 'x.log');
    assert.equal(await readAgentLog(file), null);
    await writeFile(file, `${'a'.repeat(100)}TAIL`, 'utf8');
    const tail = await readAgentLog(file, { max: 10 });
    assert.equal(tail, `…${'a'.repeat(6)}TAIL`);
    assert.equal(await readFile(file, 'utf8'), `${'a'.repeat(100)}TAIL`, 'reading does not modify the log');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The classifier separates "the agent ran and did not finish" from "the agent
 * never reached a model". The strings below are copied verbatim out of real log
 * tails produced on this machine, because the whole point is to recognise the
 * outages that actually happen — an invented error string would prove nothing.
 */
test('classifyAgentFailure recognises a provider outage instead of blaming the task', () => {
  const gateway = classifyAgentFailure(
    '[claude-code:unrecognized_model] {"model":"main","query_source":"sdk"}\n' +
      'API Error: 524 <html>...zone:"ai.yay.how"...origin_response_timeout... retry_after:120',
  );
  assert.equal(gateway.kind, 'provider-outage');
  assert.match(gateway.detail, /API Error: 524/);

  const pi = classifyAgentFailure(
    '503: {"message":"Service temporarily unavailable: all targets were skipped by pre-dispatch filters (session 100% conn:8609425d)","code":"ALL_TARGETS_SKIPPED"}',
  );
  assert.equal(pi.kind, 'provider-outage');
  assert.match(pi.detail, /ALL_TARGETS_SKIPPED|Service temporarily unavailable/);

  const unreachable = classifyAgentFailure('Error: connect ECONNREFUSED 127.0.0.1:11434');
  assert.equal(unreachable.kind, 'provider-outage');
});

test('classifyAgentFailure treats an agent that ran and stopped as a task failure', () => {
  const ran = classifyAgentFailure(
    'Read TASK.md\nEdited ops/ci/checks.conf\ntsc is not happy, giving up\n',
  );
  assert.equal(ran.kind, 'no-report');
  assert.match(ran.detail, /without leaving a report/);

  const silent = classifyAgentFailure('');
  assert.equal(silent.kind, 'no-output');

  const nothing = classifyAgentFailure(null);
  assert.equal(nothing.kind, 'no-output');
});

/**
 * The agent we spawn inherits our environment, including the knobs that decide
 * how the pipeline behaves. A dev agent that sees `PIPELINE_DEV_AGENT=on` runs
 * `ops/pipeline/test/run.test.mjs` under a different contract than the test
 * documents, so the suite fails for a reason unrelated to the agent's change —
 * exactly what a dev agent reported on 2026-10-03.
 */
test('childEnv strips the pipeline control knobs and keeps everything else', () => {
  const env = childEnv(
    {
      PATH: '/usr/bin',
      HOME: '/home/agent',
      PIPELINE_DEV_AGENT: 'on',
      PIPELINE_UAT_URL: 'http://127.0.0.1:3100/orgs/demo/ideas',
      IDEATION_PORT: '7788',
      DEV_AGENT: 'dsh',
    },
    { id: 'idea-abc123' },
  );

  assert.equal(env.PIPELINE_DEV_AGENT, undefined);
  assert.equal(env.PIPELINE_UAT_URL, undefined);
  // Not ours to strip: the agent needs its own provider settings and PATH.
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/agent');
  assert.equal(env.DEV_AGENT, 'dsh');
  assert.equal(env.IDEATION_PORT, '7788');
  assert.equal(env.MERGECREW_IDEA_ID, 'idea-abc123');
});

// `dsh headless --json` prints one JSON line per event, and the first one names
// the session. That id is the only handle on a run: it cannot be chosen up
// front, and the harness web UI has no per-session URL — so the log line is what
// turns "an agent is working" into something an operator can actually watch.
test('sessionFromLog finds the session id dsh prints when the run starts', () => {
  const log = [
    '{"type":"session","sessionId":"session-6f2a1c9e","cwd":"/repo/.worktrees/idea-abc123"}',
    '{"type":"message","text":"reading TASK.md"}',
  ].join('\n');
  assert.deepEqual(sessionFromLog(log), { sessionId: 'session-6f2a1c9e', cwd: '/repo/.worktrees/idea-abc123' });
});

test('sessionFromLog tolerates a half-written line and stays quiet without one', () => {
  // A log is read while it is being written: the interesting line may be cut in
  // half, and that must not throw inside a sweep.
  assert.equal(sessionFromLog('{"type":"session","sessionId":"session-6f2a1c'), null);
  assert.equal(sessionFromLog(''), null);
  assert.equal(sessionFromLog('agent: claude\nno json here'), null);
  // JSON without a session id (a tool event) is not a session announcement.
  assert.equal(sessionFromLog('{"type":"tool","name":"bash","cwd":"/repo"}'), null);
  // The id is only trusted when it is a non-empty string.
  assert.equal(sessionFromLog('{"type":"session","sessionId":""}'), null);
});
