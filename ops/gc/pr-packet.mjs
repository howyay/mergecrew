// Pull-request packet for one Gas City work branch. ADR-0016 step 1-3 support.
//
// A packet is the body of a pull request: summary, scope, check evidence, and a review conclusion.
// It is written before the push, so the pull request carries the evidence from the first second.
// Zero dependencies.
//
// Usage:
//   node ops/gc/pr-packet.mjs --branch=gc/orders-export [--base=main] [--out=ops/gc/pr]
//
// Test: node --test ops/gc/test/pr-packet.test.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Review rules the packet must state. Each one comes from ADR-0016 or the MergeCrew policy. */
export const REVIEW_CHECKLIST = [
  'One branch for one work item. No other work item is mixed in.',
  'No push to the default branch and no force push.',
  'Every check in the Evidence section passed.',
  'No order or schedule fires more often than every five minutes (the Dolt churn rule).',
  'The work item in the tracker matches this branch.',
];

export function renderPacket({ branch, base, commit, files, tests, summary, createdAt }) {
  if (!branch) throw new Error('renderPacket: branch is required');
  if (!commit) throw new Error('renderPacket: commit is required');
  const failed = (tests ?? []).filter((t) => t.failed > 0);
  const lines = [];

  lines.push(`# \`${branch}\``);
  lines.push('');
  lines.push(`Base: \`${base ?? 'main'}\` · Commit: \`${commit.slice(0, 12)}\`${createdAt ? ` · ${createdAt}` : ''}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(summary?.trim() || 'No commit summary was found.');
  lines.push('');

  lines.push('## Scope');
  lines.push('');
  if ((files ?? []).length === 0) lines.push('No file changes were found.');
  for (const file of files ?? []) lines.push(`- \`${file}\``);
  lines.push('');

  lines.push('## Evidence');
  lines.push('');
  if ((tests ?? []).length === 0) lines.push('No test file ran. State the reason in the review section.');
  for (const t of tests ?? []) {
    const state = t.failed > 0 ? 'FAIL' : 'PASS';
    lines.push(`- **${state}** \`${t.file}\` — ${t.passed} passed, ${t.failed} failed`);
  }
  lines.push('');

  lines.push('## Review checklist');
  lines.push('');
  for (const item of REVIEW_CHECKLIST) lines.push(`- [ ] ${item}`);
  lines.push('');

  lines.push('## Review conclusion');
  lines.push('');
  if (failed.length > 0) {
    lines.push('**Needs revision.** A test failed. Do not land this change.');
  } else {
    lines.push('**Ready for review.** Every recorded check passed.');
  }
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

export function collectFiles(branch, base) {
  const out = run('git', ['diff', '--name-only', `${base}..${branch}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

export function collectSummary(branch) {
  return run('git', ['log', '-1', '--format=%B', branch]);
}

export function collectCommit(branch) {
  return run('git', ['rev-parse', branch]);
}

export function runTests(branch) {
  const files = run('git', ['ls-tree', '-r', '--name-only', branch, 'ops/gc/test'])
    .split('\n')
    .filter((f) => f.endsWith('.test.mjs'));
  const results = [];
  for (const file of files) {
    const body = run('git', ['show', `${branch}:${file}`]);
    const tmp = join('/tmp', `pr-packet-${file.split('/').pop()}`);
    writeFileSync(tmp, body);
    let passed = 0;
    let failed = 0;
    try {
      const out = execFileSync('node', ['--test', tmp], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      passed = Number(out.match(/^ℹ pass (\d+)$/m)?.[1] ?? 0);
      failed = Number(out.match(/^ℹ fail (\d+)$/m)?.[1] ?? 0);
    } catch (error) {
      const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      passed = Number(out.match(/^ℹ pass (\d+)$/m)?.[1] ?? 0);
      failed = Number(out.match(/^ℹ fail (\d+)$/m)?.[1] ?? 1);
    }
    results.push({ file, passed, failed });
  }
  return results;
}

function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const branch = arg('--branch');
  if (!branch) {
    console.error('usage: node ops/gc/pr-packet.mjs --branch=<branch> [--base=main] [--out=ops/gc/pr]');
    return 2;
  }
  const base = arg('--base') ?? 'main';
  const packet = renderPacket({
    branch,
    base,
    commit: collectCommit(branch),
    files: collectFiles(branch, base),
    tests: runTests(branch),
    summary: collectSummary(branch),
    createdAt: new Date().toISOString().slice(0, 10),
  });
  const out = arg('--out');
  if (out) {
    mkdirSync(out, { recursive: true });
    const file = join(out, `${branch.replace(/\//g, '-')}.md`);
    writeFileSync(file, packet);
    console.log(file);
  } else {
    console.log(packet);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
