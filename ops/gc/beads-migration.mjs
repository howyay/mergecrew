// MergeCrew issues -> beads migration planner. ADR-0016 step 1, second slice.
//
// The bridge (ops/gc/beads-bridge.mjs, pull request #5) reports the difference between the two
// stores. This module turns that difference into actions, and can emit the bd commands. It writes
// nothing unless the caller passes --apply. Zero dependencies.
//
// Usage:
//   node ops/gc/beads-migration.mjs --from-json=issues.json             # plan only
//   node ops/gc/beads-migration.mjs --from-json=issues.json --apply     # run the commands
//
// Test: node --test ops/gc/test/beads-migration.test.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The bridge label. The same convention as ops/gc/beads-bridge.mjs. */
export const ISSUE_LABEL_PREFIX = 'mc-issue:';
export const BRIDGE_LABEL = 'mergecrew';

export function issueLabel(issueId) {
  return `${ISSUE_LABEL_PREFIX}${issueId}`;
}

export function clampPriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return Math.min(4, Math.max(1, Math.round(n)));
}

/** Map one MergeCrew issue to the bead fields a writer uses. */
export function mapIssue(issue) {
  if (!issue || !issue.id) throw new Error('mapIssue: issue.id is required');
  const title = String(issue.title ?? '').trim();
  if (!title) throw new Error('mapIssue: issue.title is required');
  return {
    title,
    description: String(issue.description ?? '').trim(),
    priority: clampPriority(issue.priority),
    type: String(issue.type ?? issue.kind ?? 'task'),
    labels: [...new Set([...(issue.labels ?? []), BRIDGE_LABEL, issueLabel(issue.id)])],
  };
}

/** Find the MergeCrew issue id on a bead, or null. */
export function beadIssueId(bead) {
  const labels = bead?.labels ?? [];
  const hit = labels.find((l) => typeof l === 'string' && l.startsWith(ISSUE_LABEL_PREFIX));
  return hit ? hit.slice(ISSUE_LABEL_PREFIX.length) : null;
}

function differs(mapped, bead) {
  const reasons = [];
  if (String(bead.title ?? '').trim() !== mapped.title) reasons.push('title');
  if (clampPriority(bead.priority) !== mapped.priority) reasons.push('priority');
  return reasons;
}

/**
 * Plan the migration. Returns { create, update, skip } where every entry names the issue and the
 * bead id (when one exists).
 */
export function planBeadActions(issues, beads) {
  const byIssue = new Map();
  for (const bead of beads) {
    const id = beadIssueId(bead);
    if (id) byIssue.set(id, bead);
  }

  const plan = { create: [], update: [], skip: [] };
  for (const issue of issues) {
    const mapped = mapIssue(issue);
    const bead = byIssue.get(issue.id);
    if (!bead) {
      plan.create.push({ issue: issue.id, mapped });
      continue;
    }
    const reasons = differs(mapped, bead);
    if (reasons.length) {
      plan.update.push({ issue: issue.id, beadId: bead.id, reasons, mapped });
    } else {
      plan.skip.push({ issue: issue.id, beadId: bead.id });
    }
  }
  return plan;
}

/** The bd argument lists for a plan. The caller runs them, or reads them. */
export function toBeadCommands(plan) {
  const commands = [];
  for (const item of plan.create) {
    const args = ['bd', 'create', '--title', item.mapped.title, '--type', item.mapped.type, '--priority', String(item.mapped.priority)];
    if (item.mapped.description) args.push('--description', item.mapped.description);
    for (const label of item.mapped.labels) args.push('--label', label);
    commands.push(args);
  }
  for (const item of plan.update) {
    const args = ['bd', 'update', item.beadId, '--title', item.mapped.title, '--priority', String(item.mapped.priority)];
    commands.push(args);
  }
  return commands;
}

export function renderPlan(plan, { applied = false } = {}) {
  const lines = ['# Beads migration plan (ADR-0016 step 1)', ''];
  lines.push(`${applied ? 'Applied' : 'Dry run'}. create ${plan.create.length} · update ${plan.update.length} · skip ${plan.skip.length}`);
  lines.push('');
  if (plan.create.length) {
    lines.push('## Create');
    lines.push('');
    for (const item of plan.create) lines.push(`- \`${item.issue}\` → ${item.mapped.title}`);
    lines.push('');
  }
  if (plan.update.length) {
    lines.push('## Update');
    lines.push('');
    for (const item of plan.update) lines.push(`- \`${item.issue}\` → ${item.beadId} (${item.reasons.join(', ')})`);
    lines.push('');
  }
  if (plan.skip.length) {
    lines.push('## Skip');
    lines.push('');
    for (const item of plan.skip) lines.push(`- \`${item.issue}\` → ${item.beadId} (in sync)`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function readBeads(runner = defaultRunner) {
  const out = runner(['bd', 'list', '--json']);
  const data = JSON.parse(out);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.issues)) return data.issues;
  return [];
}

function defaultRunner(args) {
  return execFileSync('gc', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const path = arg('--from-json');
  if (!path) {
    console.error('usage: node ops/gc/beads-migration.mjs --from-json=<issues.json> [--apply]');
    return 2;
  }
  const issues = JSON.parse(readFileSync(path, 'utf8'));
  const beads = readBeads();
  const plan = planBeadActions(issues, beads);
  const apply = args.includes('--apply');
  if (apply) {
    for (const command of toBeadCommands(plan)) {
      defaultRunner([...command, '--json'].filter((part) => part !== '--json'));
    }
  }
  console.log(renderPlan(plan, { applied: apply }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
