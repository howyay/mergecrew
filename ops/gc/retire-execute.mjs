// Retire a duplicated module for real. ADR-0016 step 5, second slice.
//
// The inventory (ops/gc/retire-plan.mjs, pull request #12) says what can go. This module picks a safe
// batch and removes it. It refuses to act when any file outside the batch still imports a target, and
// it never deletes outside the named directories. Dry run by default. Zero dependencies.
//
// Usage:
//   node ops/gc/retire-execute.mjs --root=. --targets=apps/runner,apps/worker-cron        # dry run
//   node ops/gc/retire-execute.mjs --root=. --targets=apps/runner --apply                 # delete
//
// Test: node --test ops/gc/test/retire-execute.test.mjs

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.worktrees', 'coverage', '.turbo', '.dsh']);
const SCAN_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|prisma|ya?ml)$/;

/** Directories and files under one target. */
export function listTargetFiles(root, target) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full));
      }
    }
  };
  walk(join(root, target));
  return out.sort();
}

/** Every file in the tree that is not inside a target. */
export function listOutsideFiles(root, targets) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (targets.some((t) => rel === t)) continue;
        walk(full);
      } else if (entry.isFile() && SCAN_EXTENSIONS.test(entry.name)) {
        if (targets.some((t) => rel === t || rel.startsWith(`${t}/`))) continue;
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** A reference is a resolved import. A path inside a string is data, not a reference. */
export function referencesTarget(text, target) {
  const escaped = target.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
  const packageName = target.startsWith('packages/') ? `@mergecrew/${target.split('/')[1]}` : null;
  const anchors = [`from\\s+['"]([^'"]*)`, `import\\(\\s*['"]([^'"]*)`, `require\\(\\s*['"]([^'"]*)`];
  for (const anchor of anchors) {
    if (packageName && new RegExp(`${anchor}${packageName.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"/]`).test(text)) return true;
    if (new RegExp(`${anchor}[^'"]*${escaped}/`).test(text)) return true;
  }
  return false;
}

/**
 * Build a removal batch. A target qualifies only when no file outside the batch references it.
 * Returns { batch: [{ target, files }], blocked: [{ target, by: [file, ...] }] }.
 */
export function buildBatch({
  root,
  targets,
  maxModules = 5,
  readFile = (p) => readFileSync(join(root, p), 'utf8'),
  listOutside = (names) => listOutsideFiles(root, names),
  listTarget = (name) => listTargetFiles(root, name),
}) {
  const outside = listOutside(targets);
  const contents = new Map();
  for (const file of outside) {
    try {
      contents.set(file, readFile(file));
    } catch {
      contents.set(file, '');
    }
  }

  const batch = [];
  const blocked = [];
  for (const target of targets) {
    const by = outside.filter((file) => referencesTarget(contents.get(file) ?? '', target));
    if (by.length) {
      blocked.push({ target, by: by.slice(0, 10) });
      continue;
    }
    if (batch.length >= maxModules) break;
    batch.push({ target, files: listTarget(target) });
  }
  return { batch, blocked };
}

export function renderBatch(plan, { applied = false } = {}) {
  const lines = ['# Retirement batch (ADR-0016 step 5)', ''];
  const files = plan.batch.reduce((sum, item) => sum + item.files.length, 0);
  lines.push(`${applied ? 'Applied' : 'Dry run'}. Modules ${plan.batch.length} · files ${files} · blocked ${plan.blocked.length}`);
  lines.push('');
  lines.push('## Batch');
  lines.push('');
  if (!plan.batch.length) lines.push('None. Every candidate is still imported.');
  for (const item of plan.batch) {
    lines.push(`- \`${item.target}\` (${item.files.length} files)`);
    for (const file of item.files.slice(0, 5)) lines.push(`  - \`${file}\``);
    if (item.files.length > 5) lines.push(`  - ... and ${item.files.length - 5} more`);
  }
  lines.push('');
  lines.push('## Blocked');
  lines.push('');
  if (!plan.blocked.length) lines.push('None.');
  for (const item of plan.blocked) {
    lines.push(`- \`${item.target}\` is imported by ${item.by.length} file(s): ${item.by.map((f) => `\`${f}\``).join(', ')}`);
  }
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Delete the batch. Refuses a path outside a named target. */
export function applyBatch(root, plan) {
  const removed = [];
  for (const item of plan.batch) {
    for (const file of item.files) {
      if (!(file === item.target || file.startsWith(`${item.target}/`))) {
        throw new Error(`applyBatch: refusing to delete "${file}" outside "${item.target}"`);
      }
      const full = join(root, file);
      if (!existsSync(full)) continue;
      rmSync(full, { force: true });
      removed.push(file);
    }
    // Remove the directories that are now empty, deepest first.
    const dirs = [];
    const collect = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const child = join(dir, entry.name);
          collect(child);
          dirs.push(child);
        }
      }
    };
    const top = join(root, item.target);
    if (existsSync(top) && statSync(top).isDirectory()) {
      collect(top);
      for (const dir of [...dirs, top]) {
        try {
          if (readdirSync(dir).length === 0) rmSync(dir, { recursive: false, force: true });
        } catch {
          // A non-empty or busy directory is left in place.
        }
      }
    }
  }
  return removed;
}

function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const root = arg('--root') ?? process.cwd();
  const targets = (arg('--targets') ?? '').split(',').filter(Boolean);
  if (!targets.length) {
    console.error('usage: node ops/gc/retire-execute.mjs --root=. --targets=a,b [--max=5] [--apply]');
    return 2;
  }
  const plan = buildBatch({ root, targets, maxModules: Number(arg('--max') ?? 5) });
  const apply = args.includes('--apply');
  const report = renderBatch(plan, { applied: apply });
  const removed = apply ? applyBatch(root, plan) : [];
  console.log(report);
  if (apply) console.log(`Removed ${removed.length} file(s).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
