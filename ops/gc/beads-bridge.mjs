// MergeCrew <-> Gas City beads bridge. ADR-0016 step 1, first slice.
//
// Read-only. Zero dependencies. It answers one question: for every MergeCrew issue, is there a
// matching bead, and do the fields agree? It writes nothing unless a caller asks it to.
//
// Usage:
//   node ops/gc/beads-bridge.mjs reconcile           # report against the rig store
//   node ops/gc/beads-bridge.mjs reconcile --json    # same, machine readable
//
// Test: node --test ops/gc/test/beads-bridge.test.mjs

import { execFileSync } from 'node:child_process';

export const BRIDGE_LABEL = 'mergecrew';
export const ISSUE_LABEL_PREFIX = 'mc-issue:';

export function issueLabel(issueId) {
  return `${ISSUE_LABEL_PREFIX}${issueId}`;
}

export function issueRef(issueId) {
  return `mergecrew:issue:${issueId}`;
}

/** Bead priority is 1..4. MergeCrew uses 1..4 too, with 2 as the normal value. */
export function clampPriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return Math.min(4, Math.max(1, Math.round(n)));
}

function unique(list) {
  return [...new Set(list.filter((x) => typeof x === 'string' && x.length > 0))];
}

/** Map one MergeCrew issue row to the bead fields a writer would use. */
export function mapIssueToBead(issue) {
  if (!issue || !issue.id) throw new Error('mapIssueToBead: issue.id is required');
  const title = String(issue.title ?? '').trim();
  if (!title) throw new Error('mapIssueToBead: issue.title is required');
  return {
    title,
    description: buildDescription(issue),
    priority: clampPriority(issue.priority),
    labels: unique([...(issue.labels ?? []), BRIDGE_LABEL, issueLabel(issue.id)]),
    externalRef: issueRef(issue.id),
  };
}

export function buildDescription(issue) {
  const body = String(issue.description ?? '').trim();
  const kind = String(issue.type ?? issue.kind ?? 'issue');
  const header = `MergeCrew issue ${issue.id} (${kind})`;
  const footer = `\n\n---\nbridged by ops/gc/beads-bridge.mjs · ${issueRef(issue.id)}`;
  return body ? `${header}\n\n${body}${footer}` : `${header}${footer}`;
}

/** A bead identifies its MergeCrew issue by external ref or by the bridge label. */
export function beadRef(bead) {
  const ref = bead?.external_ref ?? bead?.externalRef;
  if (typeof ref === 'string' && ref.startsWith('mergecrew:issue:')) return ref;
  const labels = bead?.labels ?? [];
  const hit = labels.find((l) => typeof l === 'string' && l.startsWith(ISSUE_LABEL_PREFIX));
  return hit ? issueRef(hit.slice(ISSUE_LABEL_PREFIX.length)) : null;
}

function fieldsDiffer(mapped, bead) {
  const diffs = [];
  if (String(bead.title ?? '').trim() !== mapped.title) diffs.push('title');
  if (clampPriority(bead.priority) !== mapped.priority) diffs.push('priority');
  const beadLabels = new Set(bead.labels ?? []);
  if (!beadLabels.has(BRIDGE_LABEL) || !beadLabels.has(issueLabel(mapped.externalRef.split(':').pop()))) {
    diffs.push('labels');
  }
  return diffs;
}

/** Compare MergeCrew issues with beads. Pure function: no store access. */
export function reconcile(issues, beads) {
  const beadsByRef = new Map();
  for (const bead of beads) {
    const ref = beadRef(bead);
    if (ref) beadsByRef.set(ref, bead);
  }

  const onlyInIssues = [];
  const differing = [];
  const matchedRefs = new Set();

  for (const issue of issues) {
    const ref = issueRef(issue.id);
    const bead = beadsByRef.get(ref);
    if (!bead) {
      onlyInIssues.push({ ref, title: issue.title });
      continue;
    }
    matchedRefs.add(ref);
    const diffs = fieldsDiffer(mapIssueToBead(issue), bead);
    if (diffs.length) differing.push({ ref, beadId: bead.id, diffs });
  }

  const onlyInBeads = [];
  for (const [ref, bead] of beadsByRef) {
    if (!matchedRefs.has(ref) && !onlyInIssues.some((x) => x.ref === ref)) {
      onlyInBeads.push({ ref, beadId: bead.id, title: bead.title });
    }
  }

  return {
    onlyInIssues,
    onlyInBeads,
    differing,
    counts: {
      issues: issues.length,
      beads: beads.length,
      onlyInIssues: onlyInIssues.length,
      onlyInBeads: onlyInBeads.length,
      differing: differing.length,
    },
  };
}

export function parseBeadsJson(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.issues)) return data.issues;
  return [];
}

export function defaultRunner(args) {
  return execFileSync('gc', ['bd', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function listBeads({ runner = defaultRunner } = {}) {
  return parseBeadsJson(runner(['list', '--json', '--limit', '0']));
}

/** MergeCrew issues come from the product store. Until the adapter exists, read a JSON file. */
export function loadIssuesFromFile(path) {
  return JSON.parse(execFileSync('cat', [path], { encoding: 'utf8' }));
}

function formatReport(report) {
  const { counts } = report;
  const lines = [
    '# MergeCrew <-> beads reconciliation',
    '',
    `issues: ${counts.issues} · beads: ${counts.beads}`,
    `missing beads: ${counts.onlyInIssues} · missing issues: ${counts.onlyInBeads} · field drift: ${counts.differing}`,
    '',
  ];
  if (counts.onlyInIssues) {
    lines.push('## Issues without a bead', '');
    for (const row of report.onlyInIssues) lines.push(`- ${row.ref} — ${row.title}`);
    lines.push('');
  }
  if (counts.onlyInBeads) {
    lines.push('## Beads without an issue', '');
    for (const row of report.onlyInBeads) lines.push(`- ${row.beadId} (${row.ref}) — ${row.title}`);
    lines.push('');
  }
  if (counts.differing) {
    lines.push('## Field drift', '');
    for (const row of report.differing) lines.push(`- ${row.beadId} (${row.ref}) — ${row.diffs.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const command = args[0] ?? 'reconcile';
  const asJson = args.includes('--json');
  const issuesPath = args.find((a) => a.startsWith('--issues='))?.split('=')[1] ?? process.env.MC_ISSUES_JSON;

  if (command !== 'reconcile') {
    console.error(`unknown command: ${command}`);
    console.error('usage: node ops/gc/beads-bridge.mjs reconcile [--json] [--issues=path.json]');
    return 2;
  }
  if (!issuesPath) {
    console.error('no MergeCrew issue source yet. Pass --issues=<file.json> or set MC_ISSUES_JSON.');
    console.error('The product adapter lands in the next slice of ADR-0016 step 1.');
    return 2;
  }

  const issues = loadIssuesFromFile(issuesPath);
  const beads = listBeads();
  const report = reconcile(issues, beads);
  console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.counts.onlyInIssues || report.counts.onlyInBeads || report.counts.differing ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
