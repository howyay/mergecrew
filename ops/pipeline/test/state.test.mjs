/**
 * Pipeline state has to survive the runner dying: a sweep that restarts must be
 * able to tell "stage 3 never ran" from "stage 3 ran and its result is on disk".
 * It also has to be honest about liveness — hence the heartbeat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beat, logLine, readHeartbeat, readIdeaPipeline, recordStage, stateDir, writeIdeaPipeline } from '../lib/state.mjs';

async function tempRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-state-'));
  return dir;
}

test('an unwritten idea reads as a fresh record instead of throwing', async () => {
  const repo = await tempRepo();
  try {
    const record = await readIdeaPipeline(repo, 'idea-nope');
    assert.deepEqual(record.stages, {});
    assert.equal(record.status, 'new');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('recordStage accumulates stages without losing earlier ones', async () => {
  const repo = await tempRepo();
  try {
    await recordStage(repo, 'idea-a', 'prd', { file: 'ops/pipeline/prd/idea-a.md', bytes: 10 });
    await recordStage(repo, 'idea-a', 'issue', { status: 'local', reason: 'no token' });
    await writeIdeaPipeline(repo, 'idea-a', { status: 'running' });
    const record = await readIdeaPipeline(repo, 'idea-a');

    assert.equal(record.status, 'running', 'a later patch does not drop the stages');
    assert.equal(record.stages.prd.bytes, 10);
    assert.equal(record.stages.issue.status, 'local');
    assert.ok(record.stages.prd.at, 'each stage is timestamped');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('recordStage merges a repeated stage instead of replacing it wholesale', async () => {
  const repo = await tempRepo();
  try {
    await recordStage(repo, 'idea-a', 'dev', { status: 'running', pid: 1 });
    await recordStage(repo, 'idea-a', 'dev', { status: 'done', report: 'AGENT_REPORT.md' });
    const { stages } = await readIdeaPipeline(repo, 'idea-a');
    assert.equal(stages.dev.status, 'done');
    assert.equal(stages.dev.pid, 1, 'the earlier field survives');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('heartbeat is readable, addressable and absent-safe', async () => {
  const repo = await tempRepo();
  try {
    assert.equal(await readHeartbeat(repo), null);
    await beat(repo, { mode: 'watch', queue: 3 });
    const hb = await readHeartbeat(repo);
    assert.equal(hb.pid, process.pid);
    assert.equal(hb.mode, 'watch');
    assert.equal(hb.queue, 3);
    assert.ok(Date.parse(hb.at) > 0);
    assert.equal(path.basename(stateDir(repo)), 'state');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the log is append-only and timestamped', async () => {
  const repo = await tempRepo();
  try {
    await logLine(repo, 'first');
    await logLine(repo, 'second');
    const body = await readFile(path.join(stateDir(repo), 'pipeline.log'), 'utf8');
    const lines = body.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.* first$/);
    assert.match(lines[1], /second$/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a corrupt state file degrades to a fresh record rather than bricking the runner', async () => {
  const repo = await tempRepo();
  try {
    await writeIdeaPipeline(repo, 'idea-a', { status: 'running' });
    await writeFile(path.join(stateDir(repo), 'idea-a.json'), '{not json', 'utf8');
    const record = await readIdeaPipeline(repo, 'idea-a');
    assert.equal(record.status, 'new');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
