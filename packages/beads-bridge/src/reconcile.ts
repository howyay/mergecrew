import type { Issue } from '@mergecrew/adapters-tracker';

import { BeadsClient } from './beads-client.js';
import { beadMatchesIssue, issueToBeadInput } from './mapper.js';
import type { Bead } from './types.js';

/**
 * Read-only reconciliation: diff the mergecrew tracker issues against
 * the bd bead store and report what a one-way export would change.
 *
 * Default mode is dry-run (report only). With `write: true` the ONLY
 * mutation is creating beads for tracker issues that have no bead yet
 * (tagged `tracker-import`). Nothing is ever updated or closed here,
 * and no bead is deleted — matching DEDUP-1 slice-1 acceptance
 * ("写入可选、默认 dry-run", "不双写").
 */

export interface ReconcileReport {
  /** Tracker issues that already have a matching bead. */
  matched: Array<{ issueId: string; beadId: string; title: string }>;
  /** Tracker issues with no bead; created when write=true. */
  missing: Array<{ issueId: string; title: string; createdBeadId?: string }>;
  /** Beads tagged tracker-import whose issue no longer exists on the tracker side. */
  orphanedBeads: Array<{ beadId: string; title: string }>;
}

export interface ReconcileOpts {
  /** When true, create beads for missing issues. Default false (dry-run). */
  write?: boolean;
  /** Only consider tracker issues with this status (tracker-side filter). */
  trackerStatus?: string;
  /** Fetch at most this many tracker issues (default 0 = all). */
  max?: number;
}

export async function reconcile(
  tracker: { listIssues(q: { status?: string; max?: number }): Promise<Issue[]> },
  beads: BeadsClient,
  opts: ReconcileOpts = {},
): Promise<ReconcileReport> {
  const issues = await tracker.listIssues({ status: opts.trackerStatus, max: opts.max });

  // Beads previously exported from the tracker carry the `tracker-import`
  // label; scoping bd to that label keeps the diff one-way and cheap.
  const exported = await beads.list({ status: 'open' });
  const importedBeads = exported.filter((b) => (b.labels ?? []).includes('tracker-import'));

  const matched: ReconcileReport['matched'] = [];
  const missing: ReconcileReport['missing'] = [];
  const claimed = new Set<string>();

  for (const issue of issues) {
    const bead = importedBeads.find((b) => beadMatchesIssue(b, issue));
    if (bead) {
      claimed.add(bead.id);
      matched.push({ issueId: issue.id, beadId: bead.id, title: issue.title });
    } else {
      missing.push({ issueId: issue.id, title: issue.title });
    }
  }

  const orphanedBeads = importedBeads
    .filter((b) => !claimed.has(b.id))
    .map((b) => ({ beadId: b.id, title: b.title }));

  if (opts.write && missing.length) {
    for (const m of missing) {
      const issue = issues.find((i) => i.id === m.issueId)!;
      const bead = await beads.create(issueToBeadInput(issue));
      m.createdBeadId = bead.id;
    }
  }

  return { matched, missing, orphanedBeads };
}

/** One-line-per-row text rendering of the report (used by the CLI). */
export function renderReport(report: ReconcileReport): string {
  const lines: string[] = [];
  lines.push(`matched: ${report.matched.length}`);
  for (const m of report.matched) lines.push(`  = ${m.issueId} <-> ${m.beadId} ${m.title}`);
  lines.push(`missing (would create): ${report.missing.length}`);
  for (const m of report.missing)
    lines.push(`  + ${m.issueId} ${m.title}${m.createdBeadId ? ` -> created ${m.createdBeadId}` : ''}`);
  lines.push(`orphaned beads (exported, issue gone): ${report.orphanedBeads.length}`);
  for (const o of report.orphanedBeads) lines.push(`  - ${o.beadId} ${o.title}`);
  return lines.join('\n');
}

export type { Bead };
