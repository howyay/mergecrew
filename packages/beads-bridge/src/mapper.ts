import type { Issue } from '@mergecrew/adapters-tracker';
import type { Bead } from './types.js';

/**
 * Bidirectional mapping between the mergecrew tracker `Issue` shape
 * (packages/adapters-tracker/src/types.ts) and a bd bead.
 *
 * Identity: the tracker issue's `url` is stored as the bead's
 * `external_ref`, so reconciliation can match an existing export by
 * exact URL instead of guessing by title.
 *
 * What deliberately does NOT map:
 * - priority: tracker issues carry none; exported beads keep bd's
 *   own default (2 / P2) rather than inventing one.
 * - deps/metadata are bead-only; the tracker issue shape has neither.
 */

/** Tracker issue -> bead-creation input (for `bd create`). */
export function issueToBeadInput(issue: Issue) {
  return {
    title: issue.title,
    description: issue.body ?? '',
    labels: ['tracker-import', ...(issue.labels ?? [])],
    externalRef: issue.url,
  };
}

/** Bead -> tracker-shaped issue (for reading beads back). */
export function beadToIssue(bead: Bead): Issue {
  return {
    id: bead.id,
    title: bead.title,
    body: bead.description ?? '',
    status: bead.status,
    url: bead.external_ref,
    labels: bead.labels ?? [],
    createdAt: bead.created_at ?? '',
  };
}

/**
 * Does this bead already represent the given tracker issue?
 * Match rule: external_ref equals the issue URL when both sides have one;
 * otherwise fall back to exact title (documented, conservative).
 */
export function beadMatchesIssue(bead: Bead, issue: Issue): boolean {
  if (issue.url && bead.external_ref) return bead.external_ref === issue.url;
  return bead.title === issue.title;
}
