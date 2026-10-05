// Engine retirement inventory for ADR-0016 step 5. First slice.
//
// ADR-0016 retires the MergeCrew orchestration stack in favour of Gas City primitives. Before any
// module is deleted, this tool answers three questions: how large is the module, who still imports
// it, and in which order can the modules go. Zero dependencies.
//
// Usage:
//   node ops/gc/retire-plan.mjs [--root=.] [--out=ops/gc/retire-plan.md]
//
// Test: node --test ops/gc/test/retire-plan.test.mjs

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Modules the ADR-0016 step 5 retires. Paths are workspace-relative. */
export const DEFAULT_TARGETS = [
  'apps/orchestrator',
  'packages/agent-runtime',
  'apps/runner',
  'apps/runner-agent',
  'apps/worker-cron',
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.worktrees', 'coverage', '.turbo', '.dsh']);

export function walk(dir, { root = process.cwd(), skip = SKIP_DIRS } = {}) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      out.push(...walk(join(dir, entry.name), { root, skip }));
    } else if (entry.isFile() && /\.(ts|tsx|mts|cts|js|mjs|cjs|json|prisma|ya?ml)$/.test(entry.name)) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
  return out;
}

export function countLines(root, path) {
  try {
    const text = readFileSync(join(root, path), 'utf8');
    return text.split('\n').length;
  } catch {
    return 0;
  }
}

/** References to a target: a resolved import, or a relative path that enters the directory. */
export function findReferences(files, contents, target) {
  const packageName = target.startsWith('packages/') ? `@mergecrew/${target.split('/')[1]}` : null;
  const escaped = target.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
  // Anchor on an import statement. A path inside a string is data, not a reference.
  const anchors = [`from\\s+['"]([^'"]*)`, `import\\(\\s*['"]([^'"]*)`, `require\\(\\s*['"]([^'"]*)`];
  const patterns = [];
  for (const anchor of anchors) {
    if (packageName) patterns.push(new RegExp(`${anchor}${packageName.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"/]`, 'g'));
    patterns.push(new RegExp(`${anchor}[^'"]*${escaped}/`, 'g'));
  }

  const hits = [];
  for (const file of files) {
    if (file === target || file.startsWith(`${target}/`)) continue;
    const text = contents.get(file) ?? '';
    let count = 0;
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      count += matches ? matches.length : 0;
    }
    if (count > 0) hits.push({ from: file, count });
  }
  return hits.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}

export function buildInventory({ files, contents, targets = DEFAULT_TARGETS, lineCount = () => 0 }) {
  return targets.map((target) => {
    const own = files.filter((f) => f === target || f.startsWith(`${target}/`));
    const references = findReferences(files, contents, target);
    return {
      target,
      files: own.length,
      lines: own.reduce((sum, f) => sum + lineCount(f), 0),
      references,
      inbound: references.length,
    };
  });
}

/** Leaf first: a module with no inbound reference inside the target set can go first. */
export function retireOrder(inventory) {
  const targets = new Set(inventory.map((i) => i.target));
  const internal = new Map();
  for (const item of inventory) {
    const inside = item.references.filter((r) => [...targets].some((t) => r.from === t || r.from.startsWith(`${t}/`)));
    internal.set(item.target, inside.length);
  }
  return [...inventory]
    .sort((a, b) => {
      const ai = internal.get(a.target);
      const bi = internal.get(b.target);
      if (ai !== bi) return ai - bi;
      if (a.inbound !== b.inbound) return a.inbound - b.inbound;
      if (b.lines !== a.lines) return b.lines - a.lines;
      return a.target.localeCompare(b.target);
    })
    .map((item, index) => ({ step: index + 1, target: item.target, internalRefs: internal.get(item.target), inbound: item.inbound }));
}

export function renderPlan(inventory, order) {
  const lines = ['# Engine retirement plan (ADR-0016 step 5)', ''];
  lines.push('| Module | Files | Lines | Inbound refs | Internal refs |');
  lines.push('| - | - | - | - | - |');
  const internalByTarget = new Map(order.map((o) => [o.target, o.internalRefs]));
  for (const item of inventory) {
    lines.push(`| \`${item.target}\` | ${item.files} | ${item.lines} | ${item.inbound} | ${internalByTarget.get(item.target) ?? 0} |`);
  }
  lines.push('');
  lines.push('## Retirement order');
  lines.push('');
  lines.push('Leaf first. A module goes when it has no internal reference and no outside reference.');
  lines.push('');
  for (const step of order) lines.push(`${step.step}. \`${step.target}\` — internal refs ${step.internalRefs}, outside refs ${step.inbound}`);
  lines.push('');
  lines.push('## References');
  lines.push('');
  lines.push('A reference is a resolved import (`from`, `import(`, or `require(`).');
  lines.push('A path inside a string is data, not a reference.');
  lines.push('A test file that imports a target counts. The retirement must delete or rewrite it.');
  lines.push('');
  lines.push('## Blockers');
  lines.push('');
  const blockers = inventory.filter((i) => i.inbound > 0);
  if (blockers.length === 0) {
    lines.push('None. No file outside a target module references a target module.');
  } else {
    for (const item of blockers) {
      lines.push(`- \`${item.target}\` is referenced by ${item.inbound} file(s):`);
      for (const ref of item.references.slice(0, 10)) lines.push(`  - \`${ref.from}\` (${ref.count})`);
    }
  }
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

export function collect(root) {
  const files = walk(root, { root });
  const contents = new Map();
  for (const file of files) {
    try {
      contents.set(file, readFileSync(join(root, file), 'utf8'));
    } catch {
      contents.set(file, '');
    }
  }
  return { files, contents };
}

function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const root = arg('--root') ?? process.cwd();
  const { files, contents } = collect(root);
  const inventory = buildInventory({
    files,
    contents,
    lineCount: (f) => countLines(root, f),
  });
  const order = retireOrder(inventory);
  const plan = renderPlan(inventory, order);
  const out = arg('--out');
  if (out) {
    writeFileSync(join(root, out), plan);
    console.log(join(root, out));
  } else {
    console.log(plan);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
