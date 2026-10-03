/**
 * Pipeline state, kept in two places on purpose:
 *
 *   ops/pipeline/state/<idea-id>.json  — the full record for one idea: every
 *     stage, its evidence, log tails, artefact paths. Read by the runner when
 *     it resumes, and by a human debugging a stuck feature.
 *   the idea record itself (`pipeline` field, written through the ideation
 *     store) — the small, JSON-serialisable summary the mergecrew web app
 *     renders. The app must never need to read this directory.
 *
 * Plus a heartbeat and a log, for the same reason the CI loop has them: a
 * watcher that is silent between events is indistinguishable from a dead one.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATE_DIR = 'ops/pipeline/state';

export function stateDir(repo) {
  return path.join(repo, STATE_DIR);
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function readIdeaPipeline(repo, id) {
  try {
    return JSON.parse(await readFile(path.join(stateDir(repo), `${id}.json`), 'utf8'));
  } catch {
    return { id, stages: {}, startedAt: null, finishedAt: null, status: 'new' };
  }
}

export async function writeIdeaPipeline(repo, id, patch) {
  await mkdir(stateDir(repo), { recursive: true });
  const current = await readIdeaPipeline(repo, id);
  const next = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(path.join(stateDir(repo), `${id}.json`), next);
  return next;
}

/** Merge one stage's result into the per-idea record and return the whole thing. */
export async function recordStage(repo, id, stage, value) {
  const current = await readIdeaPipeline(repo, id);
  const stages = { ...(current.stages ?? {}), [stage]: { ...(current.stages?.[stage] ?? {}), ...value, at: new Date().toISOString() } };
  return writeIdeaPipeline(repo, id, { stages });
}

/**
 * Drop one stage's record so the next advance re-runs it from scratch.
 *
 * A stage that recorded `failed` is deliberately never retried on its own: a
 * provider outage fails identically every time, and looping on it only burns
 * tokens. Recovering after the outage is therefore an explicit operator act —
 * `node ops/pipeline/run.mjs --idea <id> --retry dev` — which is what this
 * enables. `attempts` is not carried over: the new run gets the same budget as
 * the first one did.
 */
export async function clearStage(repo, id, stage) {
  const current = await readIdeaPipeline(repo, id);
  const stages = { ...(current.stages ?? {}) };
  delete stages[stage];
  return writeIdeaPipeline(repo, id, { stages });
}

export async function logLine(repo, message) {
  const dir = stateDir(repo);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, 'pipeline.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
}

export async function beat(repo, fields) {
  await mkdir(stateDir(repo), { recursive: true });
  await writeJsonAtomic(path.join(stateDir(repo), 'heartbeat.json'), {
    pid: process.pid,
    at: new Date().toISOString(),
    ...fields,
  });
}

export async function readHeartbeat(repo) {
  try {
    return JSON.parse(await readFile(path.join(stateDir(repo), 'heartbeat.json'), 'utf8'));
  } catch {
    return null;
  }
}
