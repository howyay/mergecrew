/**
 * Executor handoff — from an accepted idea to a spawned sandcastle agent.
 *
 * Accepting an idea always writes a durable task file under
 * `ops/execution/queue/`. Spawning the agent is a second, explicit step:
 * only when EXECUTOR=on. When sandcastle (or a container runtime) is missing
 * the runner reports `blocked` with the real reason — the idea is never marked
 * done by this module, and a skipped spawn is never reported as a run.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const executorEnabled = () => (process.env.EXECUTOR ?? 'off') === 'on';

/**
 * How many ideas one sweep may dispatch. The mergecrew web app writes decisions
 * straight into the shared state file (it runs in a container and cannot run
 * this dispatcher), so a swarm of accepts would otherwise spawn a swarm of
 * agents in one tick.
 */
const MAX_PER_SWEEP = Math.max(1, Number(process.env.IDEATION_DISPATCH_MAX_PER_SWEEP ?? 3));

/** Accepted, but nothing has turned it into a task file yet. */
const needsDispatch = (idea) =>
  idea.status === 'accepted' && (!idea.execution || idea.execution.status === 'none');

function taskMarkdown(idea) {
  return `# ${idea.title}

- idea-id: ${idea.id}
- source: ${idea.source}
- score: ${idea.score} (${idea.band})
- features: ${JSON.stringify(idea.features)}
- accepted-at: ${idea.decidedAt ?? new Date().toISOString()}

## Rationale

${idea.rationale}

## Evidence

${(idea.evidence ?? []).map((e) => `- ${e}`).join('\n') || '- (none)'}

## Definition of done

- The change is implemented in this repository.
- A command that fails before the change and passes after it is recorded here:

\`\`\`
# verify command(s) — replace with real ones
\`\`\`

- The primitive CI pipeline (\`ops/ci/checks.conf\`) is green on the resulting commit.
`;
}

/**
 * Write the task file, then optionally spawn the runner.
 * Returns the execution patch that was persisted onto the idea.
 */
export async function dispatchIdea(idea, { repo, stateDir, spawnImpl = spawn, log = () => {} } = {}) {
  const queueDir = path.join(stateDir, 'queue');
  const runStateDir = path.join(stateDir, 'state');
  await mkdir(queueDir, { recursive: true });
  await mkdir(runStateDir, { recursive: true });

  const taskFile = path.join(queueDir, `${idea.id}.md`);
  await writeFile(taskFile, taskMarkdown(idea), 'utf8');

  const runner = path.join(stateDir, 'sandcastle-runner.mjs');
  const relTask = path.relative(repo, taskFile);

  if (!executorEnabled()) {
    log(`dispatch ${idea.id}: task written, executor disabled`);
    return { status: 'queued', taskFile: relTask, reason: 'EXECUTOR=off', exitCode: null, finishedAt: null, summary: null };
  }

  try {
    await readFile(runner, 'utf8');
  } catch {
    return { status: 'blocked', taskFile: relTask, reason: `runner missing: ${runner}`, exitCode: null, finishedAt: null, summary: null };
  }

  const logFile = path.join(runStateDir, `${idea.id}.log`);
  const child = spawnImpl(process.execPath, [runner, '--task', taskFile, '--repo', repo], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const chunks = [];
  child.stdout?.on('data', (b) => chunks.push(b.toString()));
  child.stderr?.on('data', (b) => chunks.push(b.toString()));
  child.on('close', async (code) => {
    await writeFile(logFile, chunks.join(''), 'utf8').catch(() => {});
    log(`runner ${idea.id} exited ${code}`);
  });
  child.unref?.();

  log(`dispatch ${idea.id}: runner spawned pid=${child.pid}`);
  return { status: 'running', taskFile: relTask, pid: child.pid ?? null, reason: null, exitCode: null, finishedAt: null, summary: null };
}

/**
 * Turn decisions into work, whoever made them.
 *
 * The mergecrew web app (sd.yay.how) renders the same deck and writes the same
 * state file, but it runs in a container with no repo access, so it cannot
 * write task files or spawn runners. This sweep closes that gap: the file is
 * the queue, and this process is the only writer of `execution`. Called on
 * every API read, on the generation tick, and on a short timer so an accept in
 * the UI becomes a task file within seconds rather than hours.
 */
export async function dispatchAccepted(store, { repo, stateDir, log = () => {}, max = MAX_PER_SWEEP, spawnImpl = spawn } = {}) {
  const candidates = (await store.list()).filter(needsDispatch).slice(0, max);
  const dispatched = [];
  for (const idea of candidates) {
    const patch = await dispatchIdea(idea, { repo, stateDir, log, spawnImpl });
    await store.setExecution(idea.id, patch);
    dispatched.push({ id: idea.id, status: patch.status, reason: patch.reason ?? null });
    log(`dispatch sweep ${idea.id} -> ${patch.status}`);
  }
  return { dispatched, remaining: Math.max(0, (await store.list()).filter(needsDispatch).length) };
}

/**
 * Pick up runner outcome files and reflect them onto ideas.
 * A missing outcome file is not an outcome — nothing is invented here.
 *
 * A new attempt resets `finishedAt` to null, so comparing the timestamp alone
 * identifies "this exact outcome is already applied" without letting a previous
 * attempt's timestamp mask the new one.
 */
export async function reconcileExecutions(store, { stateDir, log = () => {} } = {}) {
  const runStateDir = path.join(stateDir, 'state');
  let files = [];
  try {
    files = (await readdir(runStateDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return { updated: 0 };
  }

  const ideas = await store.list();
  let updated = 0;
  for (const file of files) {
    const ideaId = file.replace(/\.json$/, '');
    const idea = ideas.find((i) => i.id === ideaId);
    if (!idea) continue;
    let outcome;
    try {
      outcome = JSON.parse(await readFile(path.join(runStateDir, file), 'utf8'));
    } catch {
      continue;
    }
    // An outcome file describes one attempt. Once the decision is undone (or
    // flipped to rejected) that attempt is void: re-applying its result would
    // stamp a stale verdict back onto a card nobody accepted. This check runs
    // before the "already applied" test on purpose — a card whose stored
    // verdict already matches the file would otherwise keep it forever.
    if (idea.status !== 'accepted') {
      if (idea.execution && idea.execution.status !== 'none') {
        await store.setExecution(ideaId, {
          status: 'none',
          exitCode: null,
          reason: `decision is ${idea.status}`,
          finishedAt: null,
          summary: null,
        });
        updated++;
        log(`execution cleared ${ideaId} (decision is ${idea.status}, stale outcome ignored)`);
      }
      continue;
    }

    const alreadyApplied = idea.execution?.status === outcome.status && idea.execution?.finishedAt === outcome.finishedAt;
    if (alreadyApplied) continue;

    await store.setExecution(ideaId, {
      status: outcome.status,
      exitCode: outcome.exitCode ?? null,
      reason: outcome.reason ?? null,
      finishedAt: outcome.finishedAt ?? null,
      summary: outcome.summary ?? null,
    });
    updated++;
    log(`execution reconciled ${ideaId} -> ${outcome.status}`);
  }
  return { updated };
}
