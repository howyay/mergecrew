/**
 * Worktree isolation is the safety property the whole pipeline rests on: a dev
 * agent must never be able to disturb the checkout the operator is working in.
 * These tests use a real (temporary) git repository, because the thing being
 * tested *is* git's behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { agentReport, branchName, createWorktree, listWorktrees, removeWorktree, seedOps, seedWorktree, worktreePath } from '../lib/worktree.mjs';

const run = promisify(execFile);

/**
 * `-c commit.gpgsign=false` on every git call: this machine has SSH commit
 * signing configured with a key it cannot read, so a plain `git commit` fails
 * and every test would pass for the wrong reason.
 */
async function git(cwd, ...args) {
  const { stdout } = await run('git', ['-c', 'commit.gpgsign=false', ...args], { cwd });
  return stdout.trim();
}

async function tempRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mergecrew-wt-'));
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const idea = { id: 'idea-abc123', title: '启用被注释掉的 CI 检查' };

test('createWorktree makes an isolated branch checkout without touching the main HEAD', async () => {
  const repo = await tempRepo();
  try {
    const before = await git(repo, 'rev-parse', 'HEAD');
    const created = await createWorktree({ repo, idea });

    assert.equal(created.status, 'created');
    assert.equal(created.dir, worktreePath(repo, idea.id));
    assert.ok(existsSync(path.join(created.dir, 'README.md')), 'worktree has the repo contents');
    assert.equal(existsSync(path.join(repo, '.worktrees')), true);
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), before, 'main checkout HEAD is untouched');
    assert.equal(await git(created.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), created.branch);

    // the worktree is a real independent checkout: writing there does not leak
    await writeFile(path.join(created.dir, 'agent.txt'), 'work\n', 'utf8');
    assert.equal(existsSync(path.join(repo, 'agent.txt')), false, 'agent work stays inside the worktree');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createWorktree is idempotent (a retried sweep reuses instead of failing)', async () => {
  const repo = await tempRepo();
  try {
    const first = await createWorktree({ repo, idea });
    const second = await createWorktree({ repo, idea });
    assert.equal(first.status, 'created');
    assert.equal(second.status, 'reused');
    assert.equal(second.branch, first.branch);
    assert.equal((await listWorktrees({ repo })).length, 2, 'main checkout + one worktree');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createWorktree reuses an existing branch and reports failure instead of throwing', async () => {
  const repo = await tempRepo();
  try {
    await git(repo, 'branch', branchName(idea));
    const created = await createWorktree({ repo, idea });
    assert.equal(created.status, 'created');
    assert.equal(created.branch, branchName(idea));

    const bad = await createWorktree({ repo, idea: { id: 'idea-nope', title: 'x' }, base: 'does-not-exist' });
    assert.equal(bad.status, 'failed');
    assert.match(bad.reason, /git worktree add failed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('branchName is a legal git ref derived from the idea title', () => {
  assert.equal(branchName({ id: 'idea-abc123', title: 'Hello World!' }), 'idea/abc123-hello-world');
  assert.match(branchName({ id: 'idea-abc123', title: '!!' }), /^idea\/abc123/);
  assert.ok(!branchName({ id: 'idea-abc123', title: 'a'.repeat(200) }).includes(' '));
});

test('seedWorktree briefs the agent, and its report is the completion signal', async () => {
  const repo = await tempRepo();
  try {
    const { dir } = await createWorktree({ repo, idea });
    const seeded = await seedWorktree({
      dir,
      idea: { ...idea, source: 'disabled-check', score: 68, band: 'should' },
      prd: '# PRD body\n',
      acceptance: ['checks.conf line 12 is enabled or removed'],
      verifyCommands: ['node ops/ci/ci-loop.mjs --once'],
    });

    const task = await readFile(seeded.taskFile, 'utf8');
    assert.match(task, /idea-abc123/);
    assert.match(task, /checks\.conf line 12 is enabled or removed/);
    assert.match(task, /node ops\/ci\/ci-loop\.mjs --once/);
    assert.match(task, /AGENT_REPORT\.md/, 'the agent is told how completion is detected');
    assert.equal(await readFile(seeded.prdFile, 'utf8'), '# PRD body\n');

    assert.equal(await agentReport({ dir }), null, 'no report yet');
    await writeFile(path.join(dir, 'AGENT_REPORT.md'), 'did the thing\n', 'utf8');
    const report = await agentReport({ dir });
    assert.equal(report.body, 'did the thing\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('removeWorktree unregisters it from git', async () => {
  const repo = await tempRepo();
  try {
    const { dir } = await createWorktree({ repo, idea });
    const removed = await removeWorktree({ repo, dir });
    assert.equal(removed.status, 'removed');
    assert.equal(existsSync(dir), false);
    assert.equal((await listWorktrees({ repo })).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * `ops/` was untracked when this was written, so `git worktree add` produced a
 * tree without it — while TASK.md points the agent at `ops/ci/checks.conf` as
 * the acceptance oracle. The dev agent then hunted for a file that does not
 * exist. These tests pin the copy that fixes it, and pin what must NOT be
 * copied along with it: runtime state and secrets.
 */
test('seedOps copies the untracked oracle into the worktree, never state or secrets', async () => {
  const repo = await tempRepo();
  try {
    await mkdir(path.join(repo, 'ops', 'ci', 'state'), { recursive: true });
    await mkdir(path.join(repo, 'ops', 'pipeline', 'state'), { recursive: true });
    await mkdir(path.join(repo, 'ops', 'execution', 'node_modules'), { recursive: true });
    await writeFile(path.join(repo, 'ops', 'ci', 'checks.conf'), 'node --test "ops/**/test/*.test.mjs"\n', 'utf8');
    await writeFile(path.join(repo, 'ops', 'ci', 'state', 'last-run.json'), '{"status":"pass"}\n', 'utf8');
    await writeFile(path.join(repo, 'ops', 'pipeline', 'state', 'heartbeat.json'), '{}\n', 'utf8');
    await writeFile(path.join(repo, 'ops', 'execution', 'node_modules', 'junk.js'), 'x\n', 'utf8');
    await writeFile(path.join(repo, 'ops', 'pipeline', 'forgejo.env'), 'FORGEJO_TOKEN=secret\n', 'utf8');
    await writeFile(path.join(repo, 'ops', 'ci', 'deploy.sh'), '#!/bin/sh\ncurl -H "token: secret"\n', 'utf8');

    const { dir } = await createWorktree({ repo, idea });
    const seeded = await seedOps({ repo, dir });

    assert.equal(seeded.status, 'seeded');
    assert.equal(existsSync(path.join(dir, 'ops', 'ci', 'checks.conf')), true);
    // The oracle is readable, and reading it does not hand over the operator's
    // runtime state or the token the deploy hook uses.
    assert.equal(existsSync(path.join(dir, 'ops', 'ci', 'state')), false);
    assert.equal(existsSync(path.join(dir, 'ops', 'pipeline', 'state')), false);
    assert.equal(existsSync(path.join(dir, 'ops', 'execution', 'node_modules')), false);
    assert.equal(existsSync(path.join(dir, 'ops', 'pipeline', 'forgejo.env')), false);
    assert.equal(existsSync(path.join(dir, 'ops', 'ci', 'deploy.sh')), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('seedOps reports skipped when the checkout has no ops/ at all', async () => {
  const repo = await tempRepo();
  try {
    const { dir } = await createWorktree({ repo, idea });
    const seeded = await seedOps({ repo, dir });
    assert.equal(seeded.status, 'skipped');
    assert.equal(seeded.files, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
