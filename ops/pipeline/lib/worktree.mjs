/**
 * Isolated worktrees: one directory per feature, so a dev agent can never
 * disturb the checkout the operator is working in.
 *
 * `git worktree add` gives a real, independent working directory on its own
 * branch while sharing one object store — no clone, no copying `node_modules`
 * out of the repo, and the main checkout keeps its HEAD (so the primitive CI
 * loop keeps watching the commit the operator is on).
 *
 * Worktrees live under `<repo>/.worktrees/`. The leading dot matters: git
 * ignores it, and both the ideation signal walker and the CI loop skip
 * dot-directories, so an agent's half-finished work never becomes a "signal"
 * about the repository.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_EXEC = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

export const WORKTREE_DIR = '.worktrees';

export function worktreePath(repo, ideaId) {
  return path.join(repo, WORKTREE_DIR, ideaId);
}

export function branchName(idea, { ascii = true } = {}) {
  // Git accepts UTF-8 refs; the operator does not. A branch with CJK in it is
  // unreadable in `git log --oneline --decorate`, breaks tab-completion, and
  // cannot be typed on another keyboard layout. The idea id is the stable part,
  // so the slug is ASCII or it is dropped entirely.
  const raw = String(idea.title ?? 'idea').toLowerCase();
  const cleaned = ascii ? raw.replace(/[^a-z0-9]+/g, '-') : raw.replace(/[^a-z0-9一-龥]+/g, '-');
  const slug = cleaned.replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const id = String(idea.id ?? 'idea').replace(/^idea-/, '');
  return (slug ? `idea/${id}-${slug}` : `idea/${id}`).replace(/-+$/, '');
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function listWorktrees({ repo, exec = DEFAULT_EXEC } = {}) {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], repo);
  return stdout
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const dir = lines[0]?.replace(/^worktree\s+/, '') ?? '';
      const branch = lines.find((l) => l.startsWith('branch '))?.replace(/^branch\s+refs\/heads\//, '') ?? null;
      return { dir, branch, detached: lines.includes('detached') };
    });
}

/**
 * Create (or reuse) the worktree for one idea. Idempotent on purpose: the sweep
 * may retry after a crash, and a second `git worktree add` on an existing path
 * fails with "already exists".
 */
export async function createWorktree({ repo, idea, base = 'HEAD', exec = DEFAULT_EXEC, log = () => {} } = {}) {
  const dir = worktreePath(repo, idea.id);
  const branch = branchName(idea);
  await mkdir(path.join(repo, WORKTREE_DIR), { recursive: true });

  const known = await listWorktrees({ repo, exec });
  const existing = known.find((w) => path.resolve(w.dir) === path.resolve(dir));
  if (existing) {
    log(`worktree for ${idea.id} already exists on ${existing.branch ?? 'detached HEAD'}`);
    // Reused worktrees are seeded too: one that was created before seedOps
    // existed is exactly the run this repairs.
    const ops = await seedOps({ repo, dir, log });
    return { status: 'reused', dir, branch: existing.branch, reason: null, opsFiles: ops.files ?? 0 };
  }

  // The branch may already exist (a retried run); attach to it instead of
  // failing, which would look like an infrastructure error to the operator.
  const branchExists = await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo);
  const args = branchExists.code === 0
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, base];

  const add = await exec('git', args, repo);
  if (add.code !== 0) {
    return {
      status: 'failed',
      dir,
      branch,
      reason: `git worktree add failed (${add.code}): ${(add.stderr || add.stdout).trim().slice(0, 400)}`,
    };
  }
  log(`worktree created ${path.relative(repo, dir)} on ${branch}`);
  const ops = await seedOps({ repo, dir, log });
  return { status: 'created', dir, branch, reason: null, opsFiles: ops.files ?? 0 };
}

/** Runtime state that must never be copied into an agent's tree. */
const OPS_SKIP = new Set(['node_modules', 'state', 'queue', '.git']);

/**
 * `ops/` is not committed in this repository, so `git worktree add` hands the
 * dev agent a tree without it — while TASK.md points that agent at
 * `ops/ci/checks.conf` and the PRD cites `ops/...` as its evidence. The task is
 * then literally unfulfillable, and the agent spends its run looking for a file
 * that is not there (observed 2026-10-03 on idea-740f1748, where the log reads
 * "Notice ops/ isn't in the worktree").
 *
 * So the untracked tooling is copied in: the tooling, never the runtime state
 * (state/, queue/, node_modules/, *.env, deploy.sh — the worktree must not
 * become a second operator with its own tokens).
 */
export async function seedOps({ repo, dir, source = path.join(repo, 'ops'), log = () => {} } = {}) {
  const target = path.join(dir, 'ops');
  let files = 0;
  const walk = async (from, to) => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (OPS_SKIP.has(entry.name) || entry.name.endsWith('.env') || entry.name === 'deploy.sh') continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) await walk(src, dst);
      else if (entry.isFile()) {
        await copyFile(src, dst);
        files += 1;
      }
    }
  };
  try {
    if (!(await exists(source))) return { status: 'skipped', files: 0, reason: 'no ops/ in this checkout' };
    await walk(source, target);
  } catch (error) {
    return { status: 'failed', files, reason: error.message };
  }
  log(`seeded ${files} untracked ops/ file(s) into ${path.relative(repo, dir)} — the acceptance oracle the task cites`);
  return { status: 'seeded', files };
}

/** Put the PRD and the agent's briefing inside the worktree, where it works. */
export async function seedWorktree({ dir, idea, prd, acceptance = [], verifyCommands = [] } = {}) {
  const task = `# Task for the dev agent

Idea: ${idea.id} — ${idea.title}
Source rule: ${idea.source} · score ${idea.score} (${idea.band})

## Rules of engagement

- Work **only** inside this worktree. The main checkout belongs to the operator.
- Do not weaken or delete a check to make it pass: \`ops/ci/checks.conf\` and the
  tests under \`ops/**/test/\` are the acceptance oracle, not an obstacle.
- Never report success you did not observe: paste the real command output.
- When you are done, write \`AGENT_REPORT.md\` in this directory containing:
  what changed (file by file), the exact verification command(s) you ran, their
  real output, and anything you could not do.
- Commit your work on this branch with a message starting \`${idea.id}:\`.

## Acceptance

${acceptance.length ? acceptance.map((a) => `- ${a}`).join('\n') : '- The change is implemented and verifiable.'}

## Verify commands

\`\`\`bash
${verifyCommands.join('\n') || 'node --test "ops/**/test/*.test.mjs"'}
\`\`\`

---

${prd ?? '(no PRD generated)'}
`;
  await writeFile(path.join(dir, 'TASK.md'), task, 'utf8');
  if (prd) await writeFile(path.join(dir, 'PRD.md'), prd, 'utf8');
  return { taskFile: path.join(dir, 'TASK.md'), prdFile: prd ? path.join(dir, 'PRD.md') : null };
}

/** Has the agent finished? Its report file is the only honest completion signal. */
export async function agentReport({ dir } = {}) {
  const file = path.join(dir, 'AGENT_REPORT.md');
  if (!(await exists(file))) return null;
  const { readFile } = await import('node:fs/promises');
  return { file, body: await readFile(file, 'utf8') };
}

export async function removeWorktree({ repo, dir, exec = DEFAULT_EXEC, log = () => {} } = {}) {
  const rm = await exec('git', ['worktree', 'remove', '--force', dir], repo);
  await exec('git', ['worktree', 'prune'], repo);
  if (rm.code !== 0) {
    log(`worktree remove failed (${rm.code}): ${(rm.stderr || rm.stdout).trim().slice(0, 200)}`);
    return { status: 'failed', reason: (rm.stderr || rm.stdout).trim().slice(0, 400) };
  }
  return { status: 'removed' };
}
