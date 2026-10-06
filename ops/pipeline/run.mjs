#!/usr/bin/env node
/**
 * The pipeline: from an idea a human accepted to a review package a human can
 * approve in a minute.
 *
 *   accepted ──▶ PRD ──▶ forge issue ──▶ isolated worktree ──▶ dev agent
 *            ──▶ autonomous UAT + demo recording ──▶ awaiting review
 *
 * Everything is resumable and idempotent: each stage checks whether its artefact
 * already exists before doing work, so a crash, a restart or a repeated sweep
 * cannot double-spend an agent run or file the same issue twice.
 *
 * Usage
 *   node ops/pipeline/run.mjs --idea <id> [--stage <name>] [--json]
 *   node ops/pipeline/run.mjs --idea <id> --retry dev      # after a provider outage
 *   node ops/pipeline/run.mjs --sweep
 *   node ops/pipeline/run.mjs --watch [--interval 20]
 *
 * Env
 *   PIPELINE_DEV_AGENT=on      allow the dev-agent stage (default: off — the
 *                              pipeline still produces PRD/issue/worktree/UAT)
 *   PIPELINE_MAX_PER_SWEEP=2   ideas advanced per sweep
 *   PIPELINE_UAT_URL           what UAT points at (default the sd.yay.how origin)
 *   DEV_AGENT / DEV_AGENT_FLAGS / DEV_AGENT_MODEL   see lib/agent.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { agentReport, commitWorktree, createWorktree, seedWorktree, worktreePath } from './lib/worktree.mjs';
import { classifyAgentFailure, readAgentLog, sessionFromLog, spawnDevAgent } from './lib/agent.mjs';
import { needsDependencies, readChecks, runChecks } from './lib/checks.mjs';
import { deliverPath, deliverable, readAgentReport } from './lib/deliver.mjs';
import { beat, clearStage, logLine, readHeartbeat, readIdeaPipeline, recordStage, writeIdeaPipeline } from './lib/state.mjs';
import { IdeaStore } from '../ideation/lib/store.mjs';
import { needsPrd, normalizeKind, qaModeFor, workflowFor } from '../ideation/lib/kinds.mjs';
import { queueOrder } from '../ideation/lib/triage.mjs';

const REPO = process.env.MERGECREW_REPO ?? path.resolve(new URL('../..', import.meta.url).pathname);
const STATE_FILE = process.env.IDEATION_STATE_FILE ?? path.join(REPO, 'ops/ideation/state/ideas.json');
const UAT_URL = process.env.PIPELINE_UAT_URL ?? 'http://127.0.0.1:3100/orgs/demo/ideas';
const MAX_PER_SWEEP = Math.max(1, Number(process.env.PIPELINE_MAX_PER_SWEEP ?? 4));
// How many dev agents and QA browsers may be in flight at once. The two are
// separate budgets on purpose: an agent run takes tens of minutes and a UAT
// takes about one, so one number for both would either stall the queue or open
// a dozen browsers.
const MAX_DEV_RUNNING = Math.max(1, Number(process.env.PIPELINE_MAX_DEV ?? 2));
const MAX_QA_RUNNING = Math.max(1, Number(process.env.PIPELINE_MAX_QA ?? 2));
// The harness web UI the dev agent's session shows up in (dsh --json prints the
// id). There is no per-session deep link — see ops/README.md.
const DSH_WEB_URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:53087/';
const DEV_AGENT_ENABLED = (process.env.PIPELINE_DEV_AGENT ?? 'off') === 'on';
// A stage that throws is retried this many times before the idea is parked in
// `blocked` for a human. Retrying once costs one sweep; not retrying costs a
// silently stuck idea.
const MAX_STAGE_ATTEMPTS = Math.max(1, Number(process.env.PIPELINE_STAGE_ATTEMPTS ?? 2));
const STAGES = ['prd', 'issue', 'worktree', 'dev', 'qa', 'deliver', 'review'];

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

/**
 * The one place that decides what an idea's *top-level* status is, derived from
 * its stage records. Before this, each stage wrote its own top-level status (or
 * none at all), so a card could claim "blocked" while every stage record said
 * something else — exactly the drift the Ideas page exists to make impossible.
 */
export function pipelineStatusFor(stages = {}, { maxAttempts = MAX_STAGE_ATTEMPTS } = {}) {
  const { prd, issue, worktree, dev, qa, review } = stages;
  if (review?.status === 'approved') return { status: 'done', reason: null };
  if (review?.status === 'rejected') {
    return { status: 'blocked', reason: `human rejected the delivered work${review.note ? `: ${review.note}` : ''}` };
  }
  if (qa) {
    // A chore or a refactor is judged by the repository's own checks, a feature
    // by a recorded browser run. Both are QA; the wording is what tells the
    // human at the review gate which oracle actually ran.
    const checks = qa.mode === 'checks';
    // A QA job that is still driving the browser has no verdict yet; without
    // this branch it would read as "no verdict" and park the card for review.
    if (qa.status === 'running') {
      return { status: 'running', reason: checks ? 'the checks are still running' : 'the UAT job is still running' };
    }
    if (qa.verdict === 'fail') {
      return { status: 'blocked', reason: `${checks ? 'checks' : 'UAT'} failed: ${qa.reason ?? 'see the report'}` };
    }
    if (qa.verdict === 'not-run') {
      return { status: 'blocked', reason: `nothing verified this branch: ${qa.reason ?? 'no check could run'}` };
    }
    if (qa.verdict === 'blocked') return { status: 'blocked', reason: `UAT could not run: ${qa.reason ?? 'unknown'}` };
    if (!stages.deliver) {
      return { status: 'running', reason: checks ? 'the checks passed; the deliverable is next' : 'UAT passed; the deliverable is next' };
    }
    return { status: 'awaiting-review', reason: 'the deliverable is ready; waiting for a human verdict' };
  }
  if (dev) {
    if (dev.status === 'done') return { status: 'running', reason: 'agent reported done; UAT is next' };
    if (dev.status === 'running') return { status: 'running', reason: null };
    if (dev.status === 'blocked') return { status: 'blocked', reason: dev.reason ?? 'agent could not start' };
    return dev.attempts >= maxAttempts
      ? { status: 'blocked', reason: `agent failed ${dev.attempts} time(s): ${dev.reason ?? 'no report'}` }
      : { status: 'failed', reason: dev.reason ?? 'agent failed' };
  }
  if (worktree) return { status: 'running', reason: null };
  if (issue) return { status: 'running', reason: null };
  if (prd) return { status: 'running', reason: null };
  return { status: 'queued', reason: null };
}

/** Write the derived status back to the idea record. Never throws. */
async function syncStatus(store, repo, id, stages) {
  const derived = pipelineStatusFor(stages);
  await writeIdeaPipeline(repo, id, derived);
  await store.setPipeline(id, { ...derived, updatedAt: new Date().toISOString() });
  return derived;
}

async function load(name) {
  try {
    return await import(name);
  } catch (err) {
    throw new Error(`pipeline module ${name} unavailable: ${err?.message ?? err}`);
  }
}

/**
 * A stable CDP port per idea.
 *
 * One browser per run, but the recorder's default 9333 is a single global
 * socket: two concurrent UAT jobs would fight over it and one would fail with
 * "cannot connect to the browser" — which reads like a product failure and is
 * not one.
 */
export function qaPort(ideaId) {
  let h = 0;
  for (const ch of String(ideaId)) h = (h * 31 + ch.charCodeAt(0)) % 500;
  return 9333 + h;
}

/**
 * Attach the harness session id to a dev record once the log has one.
 *
 * The id only exists because dsh runs with --json; the value is that a human can
 * then open that session in the harness web UI instead of guessing which run is
 * which. No deep link exists (measured, see ops/README.md), so the record
 * carries the id and the UI's address, nothing more.
 */
export async function attachSession(repo, dev) {
  if (!dev?.logFile || dev.sessionId) return dev;
  const text = (await readAgentLog(path.join(repo, dev.logFile), { max: 4000 })) ?? '';
  const session = sessionFromLog(text);
  if (!session) return dev;
  return { ...dev, ...session, watchUrl: DSH_WEB_URL };
}

/**
 * Start the UAT as its own process so one idea's browser run does not block the
 * sweep that is advancing every other idea.
 */
/**
 * Is this process the QA run the pipeline is waiting for?
 *
 * The sweep records `qa: {status:'running', pid}` for the job it just spawned,
 * and the child finishes booting seconds later. Both orders are therefore
 * normal, and on disk they look identical to "somebody else owns this stage":
 * the child would read a record it wrote nothing about and exit without running
 * anything, which the sweep then reported as a crashed job. The pid is the one
 * field that tells the two apart.
 */
export function ownsQaStage(stages = {}, { inline = false, pid = process.pid } = {}) {
  if (!inline) return false;
  const qa = stages?.qa;
  if (!qa) return true;
  return qa.pid === pid;
}

export async function spawnQaJob({ repo, idea, url, port, log: emit = log } = {}) {
  const logDir = path.join(repo, 'ops/pipeline/state/qa-logs');
  await mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${idea.id}.qa.log`);
  const fd = await open(logFile, 'a');
  const child = spawn(process.execPath, [path.join(repo, 'ops/pipeline/run.mjs'), '--idea', idea.id, '--stage', 'qa'], {
    cwd: repo,
    detached: true,
    env: {
      ...process.env,
      MERGECREW_REPO: repo,
      IDEATION_STATE_FILE: STATE_FILE,
      PIPELINE_UAT_URL: url,
      PIPELINE_QA_PORT: String(port),
      // The job runs one stage; it must never start agents of its own.
      PIPELINE_DEV_AGENT: 'off',
    },
    stdio: ['ignore', fd.fd, fd.fd],
  });
  await fd.close().catch(() => {});
  child.on('error', (err) => emit(`UAT job for ${idea.id} failed to start: ${err?.message ?? err}`));
  child.unref?.();
  return { pid: child.pid, logFile };
}

const isAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * What the dev agent is told to run before it reports done.
 *
 * A checks-mode card (a chore, a refactor) is judged by `ops/ci/checks.conf`, so
 * the task file names those commands instead of the repo-wide test glob — and
 * only the dependency-free ones, because a worktree is a fresh checkout without
 * `node_modules`: a command that cannot run there is noise in a document the
 * agent is meant to follow literally.
 *
 * `undefined` keeps the seeded default for a feature, whose oracle is its own
 * suite plus the repo-wide glob.
 */
async function verifyCommandsFor(idea) {
  if (qaModeFor(idea.kind) !== 'checks') return undefined;
  const commands = await readChecks(REPO);
  const runnable = commands.filter((command) => !needsDependencies(command));
  return runnable.length ? runnable : undefined;
}

/**
 * Advance one idea as far as its artefacts allow. Returns the stage it stopped
 * at plus a one-line reason, which is what the sweep logs and the review page
 * shows.
 */
export async function advanceIdea(
  idea,
  { store, repo = REPO, url = UAT_URL, onlyStage = null, forceQa = false, retryStage = null, log: emit = log } = {},
) {
  const pipeline = idea.pipeline ?? {};
  const record = await readIdeaPipeline(repo, idea.id);
  const stages = record.stages ?? {};
  const out = { id: idea.id, title: idea.title, did: null, stage: null, status: pipeline.status ?? 'new' };

  // An operator retry (`--retry dev`): drop that stage's record so the checks
  // below run it again. The stages *after* it go too — they are evidence about
  // the artefact this retry is about to replace, and a UAT verdict on code that
  // no longer exists is worse than no verdict at all. The stages before it stay:
  // the PRD, the issue and the worktree are the record of earlier work, and
  // redoing them would file a second issue for the same idea.
  if (retryStage) {
    if (!STAGES.includes(retryStage)) throw new Error(`unknown stage "${retryStage}" (expected ${STAGES.join('|')})`);
    const cleared = STAGES.slice(STAGES.indexOf(retryStage));
    for (const stage of cleared) {
      await clearStage(repo, idea.id, stage);
      delete stages[stage];
    }
    if (cleared.includes('dev')) {
      // A report left behind by the failed attempt would make the very next
      // sweep read "done" before the new agent has written a single line.
      const dir = stages.worktree?.dir ?? pipeline.worktree?.dir;
      if (dir) await rm(path.join(repo, dir, 'AGENT_REPORT.md'), { force: true });
    }
    // syncStatus below derives the top-level status from the stages, which is
    // what puts a previously `blocked` card back into the sweep's work list.
    emit(`retry ${retryStage} for ${idea.id}: cleared ${cleared.join(', ')}`);
  }

  // Repair drift left by an earlier run (a hand-written status, or one written
  // by a version of this file that never derived it) before doing anything else.
  await syncStatus(store, repo, idea.id, stages);

  // 1. PRD -------------------------------------------------------------------
  if (!stages.prd && (!onlyStage || onlyStage === 'prd')) {
    if (!needsPrd(idea.kind)) {
      // A chore gets no PRD, on purpose: a document restating "the build is red"
      // costs a model call and gives the human a second thing to read. The stage
      // record stays (every later stage looks for it, and the deck reads it), so
      // it says *why* it is empty and carries the acceptance list instead.
      const { choreAcceptance } = await load('./lib/prd.mjs');
      const acceptance = choreAcceptance(idea);
      const prd = {
        skipped: true,
        reason: `a ${normalizeKind(idea.kind)} needs no PRD — the signal that produced it is the specification`,
        acceptance,
        at: new Date().toISOString(),
      };
      await recordStage(repo, idea.id, 'prd', prd);
      await writeIdeaPipeline(repo, idea.id, {
        status: 'running',
        startedAt: record.startedAt ?? new Date().toISOString(),
        stages: { ...stages, prd },
      });
      await store.setPipeline(idea.id, { status: 'running', prd, updatedAt: new Date().toISOString() });
      emit(`no prd for ${idea.id}: ${normalizeKind(idea.kind)} (${acceptance.length} acceptance line(s), no document)`);
      return { ...out, did: 'prd', stage: 'prd', prdFile: null, prdSkipped: true };
    }
    const { buildPrd, writePrd, acceptanceFor } = await load('./lib/prd.mjs');
    const signals = await readGenerationSignals(repo);
    const prd = buildPrd(idea, { repo, signals });
    const { file, bytes } = await writePrd({ repo, idea, prd });
    const acceptance = acceptanceFor(idea);
    await recordStage(repo, idea.id, 'prd', { file, bytes, acceptance });
    await writeIdeaPipeline(repo, idea.id, {
      status: 'running',
      startedAt: record.startedAt ?? new Date().toISOString(),
      stages: { ...stages, prd: { file, bytes, acceptance, at: new Date().toISOString() } },
    });
    await store.setPipeline(idea.id, {
      status: 'running',
      prd: { file, bytes, at: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });
    emit(`prd written for ${idea.id}: ${file} (${bytes} bytes)`);
    return { ...out, did: 'prd', stage: 'prd', prdFile: file };
  }

  const prdFile = stages.prd?.file ?? pipeline.prd?.file;
  const prdBody = prdFile ? await readFile(path.join(repo, prdFile), 'utf8').catch(() => null) : null;

  // 2. Forge issue -----------------------------------------------------------
  if (!stages.issue && (!onlyStage || onlyStage === 'issue')) {
    const { createIssue, resolveForge } = await load('./lib/issue.mjs');
    // resolveForge, not detectForge: the git remote says where the code lives,
    // which is not always where tickets belong (mirrors and repositories with
    // issues disabled are both normal). ISSUE_TRACKER decides, and it defaults
    // to exactly the old remote-derived behaviour.
    const forge = resolveForge({ repo });
    const issue = await createIssue({ idea, prd: prdBody ?? idea.rationale, forge, repo });
    await recordStage(repo, idea.id, 'issue', issue);
    await writeIdeaPipeline(repo, idea.id, { stages: { ...(await readIdeaPipeline(repo, idea.id)).stages, issue } });
    await store.setPipeline(idea.id, { issue, updatedAt: new Date().toISOString() });
    emit(`issue for ${idea.id}: ${issue.status}${issue.url ? ` ${issue.url}` : ` (${issue.reason})`}`);
    return { ...out, did: 'issue', stage: 'issue', issue: issue.status };
  }

  // 3. Isolated worktree -----------------------------------------------------
  if (!stages.worktree && (!onlyStage || onlyStage === 'worktree')) {
    const acceptance = stages.prd?.acceptance ?? [];
    const created = await createWorktree({ repo, idea, log: emit });
    if (created.status === 'failed') {
      await recordStage(repo, idea.id, 'worktree', created);
      await store.setPipeline(idea.id, { status: 'blocked', worktree: created, updatedAt: new Date().toISOString() });
      return { ...out, did: 'worktree', stage: 'worktree', status: 'blocked', reason: created.reason };
    }
    const seeded = await seedWorktree({ dir: created.dir, idea, prd: prdBody, acceptance, verifyCommands: await verifyCommandsFor(idea) });
    const worktree = { ...created, dir: path.relative(repo, created.dir), taskFile: path.relative(repo, seeded.taskFile) };
    await recordStage(repo, idea.id, 'worktree', worktree);
    await writeIdeaPipeline(repo, idea.id, { stages: { ...(await readIdeaPipeline(repo, idea.id)).stages, worktree } });
    await store.setPipeline(idea.id, { worktree, updatedAt: new Date().toISOString() });
    emit(`worktree ready for ${idea.id}: ${worktree.dir} (${worktree.status})`);
    return { ...out, did: 'worktree', stage: 'worktree', worktree: worktree.dir };
  }

  // 4. Dev agent -------------------------------------------------------------
  const worktreeRel = stages.worktree?.dir ?? pipeline.worktree?.dir;
  const worktreeAbs = worktreeRel ? path.join(repo, worktreeRel) : worktreePath(repo, idea.id);

  if (stages.dev?.status === 'running') {
    const report = await agentReport({ dir: worktreeAbs });
    if (report) {
      // The agent cannot commit (see commitWorktree): the pipeline does it, so
      // the review gate reads a diff and the branch holds the actual change.
      const committed = await commitWorktree({ dir: worktreeAbs, idea, log: emit });
      if (committed.status === 'failed') emit(`could not commit ${idea.id}: ${committed.reason}`);
      const endedAt = new Date().toISOString();
      // Keep what the run record already knows — provider, command, pid, log —
      // so the deck can say *which* agent did the work, not just "agent".
      const dev = {
        ...(await attachSession(repo, stages.dev)),
        status: 'done',
        report: path.relative(repo, report.file),
        endedAt,
        durationMs: stages.dev.startedAt ? Date.parse(endedAt) - Date.parse(stages.dev.startedAt) : null,
        commit: committed.sha ?? null,
        commitStatus: committed.status,
        commitFiles: committed.files ?? 0,
        reason: null,
      };
      await recordStage(repo, idea.id, 'dev', dev);
      const merged = (await readIdeaPipeline(repo, idea.id)).stages;
      await writeIdeaPipeline(repo, idea.id, { stages: merged });
      await store.setPipeline(idea.id, { dev, updatedAt: new Date().toISOString() });
      emit(`dev agent for ${idea.id} reported (${dev.report})`);
      return { ...out, did: 'dev', stage: 'dev', status: 'dev-done' };
    }
    // Still running: publish the session id as soon as the CLI has printed it,
    // so a human can watch the run instead of waiting for it.
    const withSession = await attachSession(repo, stages.dev);
    if (withSession.sessionId && withSession.sessionId !== stages.dev.sessionId) {
      await recordStage(repo, idea.id, 'dev', withSession);
      await store.setPipeline(idea.id, { dev: withSession, updatedAt: new Date().toISOString() });
      emit(`dev agent for ${idea.id} is watchable: ${withSession.sessionId} (${DSH_WEB_URL})`);
    }

    if (!isAlive(stages.dev.pid)) {
      const tail = (await readAgentLog(path.join(repo, stages.dev.logFile ?? ''))) ?? '';
      // "Ran and did not finish" and "never reached a model" are different
      // problems: retrying the second one just burns tokens on an outage.
      const failure = classifyAgentFailure(tail);
      const outage = failure.kind === 'provider-outage';
      const reason = outage
        ? `dev agent could not reach its model provider: ${failure.detail}`
        : 'agent exited without writing AGENT_REPORT.md';
      const dev = {
        ...stages.dev,
        status: 'failed',
        endedAt: new Date().toISOString(),
        reason,
        failureKind: failure.kind,
        logTail: tail.slice(-1500),
      };
      await recordStage(repo, idea.id, 'dev', dev);
      // The top-level status is recomputed from the stages by syncStatus(); this
      // write is what keeps the deck honest in the meantime, with the reason
      // spelled out so the card says *why* it stopped moving.
      await store.setPipeline(idea.id, {
        dev,
        status: 'blocked',
        reason,
        updatedAt: new Date().toISOString(),
      });
      emit(`dev agent for ${idea.id} died — ${reason} (see ${stages.dev.logFile})`);
      return { ...out, did: 'dev', stage: 'dev', status: 'blocked', reason };
    }
    return { ...out, did: null, stage: 'dev', status: 'dev-running' };
  }

  if (!stages.dev && (!onlyStage || onlyStage === 'dev')) {
    if (!DEV_AGENT_ENABLED) {
      emit(`dev stage skipped for ${idea.id}: PIPELINE_DEV_AGENT is off (set it to on to spawn agents)`);
      return { ...out, did: 'dev', stage: 'dev', status: 'dev-skipped', reason: 'PIPELINE_DEV_AGENT=off' };
    }
    const started = await spawnDevAgent({
      worktree: worktreeAbs,
      idea,
      logDir: path.join(repo, 'ops/pipeline/state/agent-logs'),
      log: emit,
    });
    const dev = { ...started, logFile: started.logFile ? path.relative(repo, started.logFile) : null };
    await recordStage(repo, idea.id, 'dev', dev);
    await store.setPipeline(idea.id, { dev, updatedAt: new Date().toISOString() });
    return { ...out, did: 'dev', stage: 'dev', status: started.status };
  }

  // 5. QA: what judges this change depends on what the change is -------------
  //   feature   → a recorded browser run against the real product
  //   chore     → the repository's own checks (no screen to drive, no demo to
  //               record: a chore *is* the finding, not a product surface)
  //   refactor  → the checks as well: behaviour is meant to be unchanged, so the
  //                only honest evidence is the suite that pins it
  // The gate is normally "the agent reported done". --force-qa is the operator
  // asking for QA right now (to see a demo of the current state, or to re-record
  // after a UI change); it does not change what the checks assert, and the
  // record says who ran it.
  const workflow = workflowFor(idea.kind);
  const checksMode = workflow.qa === 'checks';
  const qaReady = stages.dev?.status === 'done' || (forceQa && Boolean(stages.dev));
  // `--stage qa` is what the job below runs: it is the one caller that must run
  // the browser in-process, because it *is* the process. A sweep only starts
  // jobs, so a UAT never blocks the queue behind it.
  const qaInline = onlyStage === 'qa';
  // The job this sweep spawned is this process. See ownsQaStage(): the record
  // naming my pid is the difference between "somebody else is running the UAT"
  // and "I am the UAT run the pipeline is waiting for".
  const qaOwnedByMe = ownsQaStage(stages, { inline: qaInline });

  if (stages.qa?.status === 'running' && !qaInline) {
    // The job is alive → nothing to do; it owns the stage (and its writer lock).
    if (isAlive(stages.qa.pid)) return { ...out, did: null, stage: 'qa', status: 'qa-running' };
    // It exited. Either it wrote a verdict (normal) or it died (a real failure).
    const fresh = (await readIdeaPipeline(repo, idea.id)).stages?.qa;
    if (fresh && fresh.status !== 'running') {
      await store.setPipeline(idea.id, { qa: fresh, updatedAt: new Date().toISOString() });
      emit(`UAT job for ${idea.id} finished: ${fresh.verdict ?? fresh.status}`);
      return { ...out, did: 'qa', stage: 'qa', status: fresh.verdict ?? fresh.status, report: fresh.report ?? null, demo: fresh.demo ?? null };
    }
    const tail = (await readAgentLog(path.join(repo, stages.qa.logFile ?? ''), { max: 1200 })) ?? '';
    const qa = {
      ...stages.qa,
      status: 'failed',
      endedAt: new Date().toISOString(),
      reason: `the ${checksMode ? 'checks job' : 'UAT job'} exited without writing a verdict`,
      logTail: tail.slice(-1200),
    };
    await recordStage(repo, idea.id, 'qa', qa);
    await store.setPipeline(idea.id, { qa, status: 'blocked', reason: qa.reason, updatedAt: new Date().toISOString() });
    emit(`QA job for ${idea.id} died — ${qa.reason} (see ${stages.qa.logFile})`);
    return { ...out, did: 'qa', stage: 'qa', status: 'blocked', reason: qa.reason };
  }

  if ((!stages.qa || qaOwnedByMe) && qaReady && (!onlyStage || onlyStage === 'qa')) {
    // A port is only meaningful for a browser run; a checks job must not hold one
    // (it would look like a recording that never happened).
    const port = checksMode ? null : Number(process.env.PIPELINE_QA_PORT) || qaPort(idea.id);
    const source = forceQa && stages.dev?.status !== 'done' ? 'manual' : 'pipeline';
    if (!qaInline) {
      const job = await spawnQaJob({ repo, idea, url, port, log: emit });
      const qa = {
        mode: checksMode ? 'checks' : 'uat',
        status: 'running',
        pid: job.pid,
        logFile: path.relative(repo, job.logFile),
        startedAt: new Date().toISOString(),
        port,
        source,
        devStatus: stages.dev?.status ?? null,
      };
      await recordStage(repo, idea.id, 'qa', qa);
      await store.setPipeline(idea.id, { qa, updatedAt: new Date().toISOString() });
      emit(
        checksMode
          ? `checks job for ${idea.id} started (pid ${job.pid}, log ${qa.logFile})`
          : `UAT job for ${idea.id} started (pid ${job.pid}, cdp ${port}, log ${qa.logFile})`,
      );
      return { ...out, did: 'qa', stage: 'qa', status: 'qa-started', port };
    }

    const acceptance = stages.prd?.acceptance ?? [];

    if (checksMode) {
      // The worktree is where the branch lives, so it is what the checks judge:
      // running them against the operator's checkout would grade main.
      const dir = path.join(repo, worktreeRel ?? worktreePath(repo, idea.id));
      const result = await runChecks({ dir, log: emit });
      const qa = { ...result, source, devStatus: stages.dev?.status ?? null, acceptance, acceptanceChecked: false };
      await recordStage(repo, idea.id, 'qa', qa);
      await store.setPipeline(idea.id, { qa, updatedAt: new Date().toISOString() });
      emit(`checks for ${idea.id}: ${qa.verdict} (${qa.results.length} ran, ${qa.skipped.length} skipped)`);
      return { ...out, did: 'qa', stage: 'qa', status: qa.verdict, checks: qa.results, skipped: qa.skipped };
    }

    const { runUat, uatMarkdown } = await load('./lib/uat.mjs');
    const outDir = path.join(repo, 'ops/pipeline/uat', idea.id);
    await mkdir(outDir, { recursive: true });
    // Every step here is a real requirement, so none of them are optional: the
    // recorder has no `optional` semantics on purpose (a step that may fail
    // silently is a step that verifies nothing), and a QA gate that waves a
    // missing card through would be the exact theatre this pipeline replaces.
    const steps = [
      { name: 'ideas page loads', action: 'expect', selector: 'main', text: 'Ideas' },
      { name: `the accepted card for ${idea.id} is on the page`, action: 'expect', selector: 'body', text: idea.id },
    ];
    // The port is unique per idea so two concurrent UAT jobs cannot fight over
    // one CDP socket and report the collision as a product failure.
    const result = await runUat({ idea, url, outDir, steps, acceptance, port, log: emit });
    const reportFile = path.join(outDir, 'uat.md');
    const uat = {
      // Which oracle ran. The record has to say it itself: a reader (and the
      // deck) must not have to infer "checks or browser" from the idea's kind,
      // which can be re-classified after the fact.
      mode: 'uat',
      // The stage is over; the verdict says how it went. Without this the record
      // keeps the `running` the sweep wrote when it spawned the job, and a
      // finished UAT then reads as "still driving the browser" forever.
      status: 'done',
      verdict: result.verdict,
      ok: result.ok,
      report: path.relative(repo, reportFile),
      // runUat returns objects for the animation and strings for the files it
      // wrote; path.relative on the object threw the first time this stage ever
      // ran for real, which is exactly what the QA gate is for.
      demo: result.apng?.file ? path.relative(repo, result.apng.file) : null,
      frames: result.apng?.frames ?? 0,
      player: result.demo ? path.relative(repo, result.demo) : null,
      durationMs: result.durationMs,
      consoleErrors: result.consoleErrors?.length ?? 0,
      port,
      // Who asked for this run, and what the gate was standing on. A manual run
      // is still a real run, but the record must not imply the agent finished.
      source,
      devStatus: stages.dev?.status ?? null,
      // The PRD's acceptance criteria are prose for a human to judge at the
      // review gate below; UAT asserts the product surface, not that list. Say
      // so here rather than letting a green UAT read as "every criterion passed".
      acceptance,
      acceptanceChecked: false,
      ranAt: new Date().toISOString(),
    };
    await recordStage(repo, idea.id, 'qa', uat);
    await store.setPipeline(idea.id, { qa: uat, updatedAt: new Date().toISOString() });
    emit(`UAT for ${idea.id}: ${uat.verdict} (report ${uat.report}${uat.demo ? `, demo ${uat.demo}` : ''})`);
    void uatMarkdown;
    return { ...out, did: 'qa', stage: 'qa', status: uat.verdict, report: uat.report, demo: uat.demo };
  }

  // 6. Deliver: the artifact a human opens at the review gate ----------------
  // A feature ships with a recording to watch; a technical change ships with a
  // changelog entry to read. Either way the gate gets something to look at,
  // built only from what the earlier stages actually wrote.
  const qaDone = stages.qa && stages.qa.status !== 'running';
  if (qaDone && !stages.deliver && (!onlyStage || onlyStage === 'deliver')) {
    const artifact = deliverable({ idea, stages, reportText: await readAgentReport(repo, stages) });
    const file = deliverPath(repo, idea.id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, artifact.markdown);
    const deliver = {
      status: 'done',
      kind: artifact.kind,
      file: path.relative(repo, file),
      title: artifact.title,
      demo: artifact.demo,
      changelog: artifact.changelog,
      bullets: artifact.bullets,
      summary: artifact.summary ? artifact.summary.split('\n')[0].slice(0, 240) : null,
      wroteAt: new Date().toISOString(),
    };
    await recordStage(repo, idea.id, 'deliver', deliver);
    const merged = (await readIdeaPipeline(repo, idea.id)).stages;
    await writeIdeaPipeline(repo, idea.id, { stages: { ...merged, deliver } });
    await store.setPipeline(idea.id, { deliver, updatedAt: new Date().toISOString() });
    emit(`deliverable for ${idea.id}: ${deliver.kind} → ${deliver.file}`);
    return { ...out, did: 'deliver', stage: 'deliver', kind: deliver.kind, file: deliver.file };
  }

  // 6. Review gate: the second human gate ------------------------------------
  if (qaDone && (!onlyStage || onlyStage === 'review') && (onlyStage === 'review' || stages.deliver?.status === 'done')) {
    const human = idea.review ?? null;
    const decided = human?.decision === 'approved' || human?.decision === 'rejected';
    if (!decided && stages.review?.status === 'awaiting-review') {
      // Already parked for a human; do not re-log it on every sweep.
      return out;
    }

    const summary = {
      status: decided
        ? human.decision === 'approved'
          ? 'approved'
          : 'rejected'
        : 'awaiting-review',
      finishedAt: new Date().toISOString(),
      prd: stages.prd?.file ?? null,
      issue: stages.issue?.url ?? stages.issue?.file ?? null,
      worktree: stages.worktree?.dir ?? null,
      dev: stages.dev?.status ?? null,
      provider: stages.dev?.provider ?? null,
      commit: stages.dev?.commit ?? null,
      qa: stages.qa?.verdict ?? null,
      // Which oracle produced that verdict — "pass" alone does not say whether a
      // browser drove the product or the check list ran in the worktree.
      qaMode: stages.qa?.mode === 'checks' ? 'checks' : 'uat',
      demo: stages.qa?.demo ?? null,
      deliverable: stages.deliver?.file ?? null,
      deliverKind: stages.deliver?.kind ?? null,
    };
    if (decided) {
      // The pipeline never merges or deploys: approval records the verdict and
      // frees the branch for a human to take. That boundary is deliberate.
      summary.decision = human.decision;
      summary.by = human.by ?? null;
      summary.note = human.note ?? null;
      summary.reviewedAt = new Date().toISOString();
    }
    await recordStage(repo, idea.id, 'review', summary);
    await store.setPipeline(idea.id, {
      review: summary,
      status: decided ? (human.decision === 'approved' ? 'done' : 'blocked') : 'awaiting-review',
      reason:
        decided && human.decision === 'rejected'
          ? `human rejected the delivered work${human.note ? `: ${human.note}` : ''}`
          : null,
      finishedAt: decided ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    });
    emit(
      decided
        ? `${idea.id} review ${human.decision} by ${human.by ?? 'human'} (${summary.qa} ${summary.qaMode}, branch ${summary.worktree ?? 'none'})`
        : `${idea.id} is awaiting human review (${summary.qa} ${summary.qaMode}${summary.demo ? `, demo ${summary.demo}` : ''})`,
    );
    return { ...out, did: 'review', stage: 'review', status: summary.status };
  }

  return out;
}

async function readGenerationSignals(repo) {
  try {
    const state = JSON.parse(await readFile(path.join(repo, 'ops/ci/state/last-run.json'), 'utf8'));
    return { ci: { status: state.status, head: state.head, failedChecks: (state.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.cmd) } };
  } catch {
    return { ci: null };
  }
}

/**
 * Ideas that are accepted and not yet approved/done — the pipeline's work list.
 *
 * `blocked` means a stage decided it cannot proceed without a human (no forge
 * token, no agent binary). `failed` means a stage threw: usually a bug or a
 * transient error, so it is retried — but only so many times, because a stage
 * that throws every sweep would burn an agent run every sweep.
 */
export async function workList(store, { maxAttempts = MAX_STAGE_ATTEMPTS } = {}) {
  const ideas = await store.list();
  const ready = ideas.filter((i) => {
    if (i.status !== 'accepted') return false;
    const p = i.pipeline ?? {};
    // Parked for a human: back to work only once that human has answered.
    if (p.status === 'awaiting-review') {
      if (i.review?.decision) return true;
      // …but a card parked before the deliver stage existed has nothing for
      // that human to open, so it still owes a stage. Records written by the
      // older pipeline reach `awaiting-review` straight from UAT.
      return Boolean(p.qa && p.qa.status !== 'running' && !p.deliver);
    }
    if (['done', 'blocked'].includes(p.status)) return false;
    if (p.status === 'failed' && (p.attempts ?? 0) >= maxAttempts) return false;
    return true;
  });
  // Triage order, not accept order: the operator's P0 runs before an older P2
  // (queueOrder falls back to score for cards that were never triaged).
  return queueOrder(ready);
}

export async function sweep({
  store,
  repo = REPO,
  url = UAT_URL,
  max = MAX_PER_SWEEP,
  maxDev = MAX_DEV_RUNNING,
  maxQa = MAX_QA_RUNNING,
  log: emit = log,
} = {}) {
  const queue = await workList(store);
  const stagesOf = (idea) => idea.pipeline?.stages ?? {};
  // Slots, not a global pause: a full dev budget must not stop another card's
  // QA or deliverable from advancing in the same sweep.
  let devRunning = queue.filter((i) => stagesOf(i).dev?.status === 'running').length;
  let qaRunning = queue.filter((i) => stagesOf(i).qa?.status === 'running').length;
  const deferred = [];
  const work = [];
  for (const idea of queue) {
    if (work.length >= max) break;
    const stages = stagesOf(idea);
    const startsDev = !stages.dev;
    const startsQa = !stages.qa && stages.dev?.status === 'done';
    if (startsDev && devRunning >= maxDev) {
      deferred.push({ id: idea.id, reason: `dev slots busy (${devRunning}/${maxDev})` });
      continue;
    }
    if (startsQa && qaRunning >= maxQa) {
      deferred.push({ id: idea.id, reason: `qa slots busy (${qaRunning}/${maxQa})` });
      continue;
    }
    if (startsDev) devRunning += 1;
    if (startsQa) qaRunning += 1;
    work.push(idea);
  }
  const done = [];
  for (const idea of work) {
    try {
      done.push(await advanceIdea(idea, { store, repo, url, log: emit }));
    } catch (err) {
      const reason = err?.message ?? String(err);
      const attempts = (idea.pipeline?.attempts ?? 0) + 1;
      const status = attempts >= MAX_STAGE_ATTEMPTS ? 'blocked' : 'failed';
      const patch = { status, reason, error: reason, attempts, updatedAt: new Date().toISOString() };
      await writeIdeaPipeline(repo, idea.id, { status, error: reason, attempts });
      await store.setPipeline(idea.id, patch);
      emit(
        `pipeline error for ${idea.id} (attempt ${attempts}/${MAX_STAGE_ATTEMPTS}, ${status}): ${reason}`,
      );
      done.push({ id: idea.id, status: 'error', reason, attempts, nextStatus: status });
    }
  }
  await beat(repo, {
    mode: 'sweep',
    queue: queue.length,
    advanced: done.length,
    devRunning,
    qaRunning,
    devAgent: DEV_AGENT_ENABLED,
  });
  return { queue: queue.length, advanced: done, deferred, devRunning, qaRunning };
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const value = (flag, fallback = null) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const asJson = has('--json');
  const store = new IdeaStore(STATE_FILE);

  if (has('--help')) {
    console.log(
      'usage: run.mjs --idea <id> [--stage <s>] [--force-qa] [--retry <s>] [--json] | --sweep | --watch [--interval N]',
    );
    return;
  }

  if (has('--idea')) {
    const id = value('--idea');
    const idea = await store.get(id);
    if (!idea) {
      console.error(`unknown idea ${id}`);
      process.exit(2);
    }
    const result = await advanceIdea(idea, {
      store,
      onlyStage: value('--stage'),
      forceQa: has('--force-qa'),
      retryStage: value('--retry'),
      log: asJson ? () => {} : log,
    });
    if (asJson) console.log(JSON.stringify(result, null, 2));
    // A job that decides there is nothing to do must say so. Silence here once
    // read as a crashed job: the log was empty, so the sweep could only report
    // "exited without writing a verdict" while the real reason was a gate.
    else if (!result.did) {
      log(
        `nothing to do for ${id}: ${result.status ?? 'idle'}${result.stage ? ` (stage ${result.stage})` : ''}${result.reason ? ` — ${result.reason}` : ''}`,
      );
    }
    return;
  }

  if (has('--sweep')) {
    const result = await sweep({ store, log: asJson ? () => {} : log });
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else log(`sweep: queue ${result.queue}, advanced ${result.advanced.length}`);
    return;
  }

  if (has('--watch')) {
    const intervalMs = Math.max(5, Number(value('--interval', process.env.PIPELINE_INTERVAL_SECONDS ?? 20))) * 1000;
    log(`pipeline watch repo=${REPO} state=${STATE_FILE} interval=${intervalMs / 1000}s devAgent=${DEV_AGENT_ENABLED ? 'on' : 'off'}`);
    let stop = false;
    let wake = null;
    const sleep = (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        log(`${sig} received — stopping`);
        stop = true;
        wake?.();
      });
    }
    let ticks = 0;
    while (!stop) {
      try {
        const result = await sweep({ store });
        ticks += 1;
        if (ticks % 10 === 0) {
          const hb = await readHeartbeat(REPO);
          log(`alive: ${ticks} sweeps, queue ${result.queue}, last beat ${hb?.at ?? 'n/a'}`);
        }
      } catch (err) {
        log(`sweep failed: ${err?.message ?? err}`);
      }
      await sleep(intervalMs);
    }
    log('pipeline watch stopped');
    return;
  }

  console.error('nothing to do — pass --idea <id>, --sweep or --watch (see --help)');
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) await main();

export { STAGES, DEV_AGENT_ENABLED, MAX_STAGE_ATTEMPTS };
void logLine;
