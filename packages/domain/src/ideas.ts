import { ForbiddenError } from './errors.js';

/**
 * Ideas are the product's queue of candidate work: a sentence a human typed
 * during onboarding, a Sentry issue, a bug-triage finding, a direction picked
 * off a discovery report. An idea is a proposal, not a task — it becomes work
 * only after a human approves it, and the runner seeds runs from approved
 * ideas alone.
 *
 * `queued`    — waiting for a human decision. Nothing runs from it.
 * `approved`  — a human said yes. The runner may consume it.
 * `rejected`  — a human said no. Nothing will ever run from it.
 * `picked_up` — a run consumed it; the runner flips this atomically.
 *
 * The vocabulary lives here so the API, the runner and the web agree on what
 * "the human gate for ideas" means; the statuses are plain strings in the
 * database, so this module is the only place that has to be right.
 */
export const IDEA_STATUSES = ['queued', 'approved', 'rejected', 'picked_up'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** Waiting for a human decision — the only status a decision may act on. */
export const IDEA_STATUS_QUEUED: IdeaStatus = 'queued';

/** The one status the runner seeds work from. */
export const PICKABLE_IDEA_STATUS: IdeaStatus = 'approved';

export const IDEA_STATUS_REJECTED: IdeaStatus = 'rejected';

export const IDEA_STATUS_PICKED_UP: IdeaStatus = 'picked_up';

export const IDEA_DECISIONS = ['approve', 'reject'] as const;
export type IdeaDecision = (typeof IDEA_DECISIONS)[number];

export function isIdeaStatus(value: string): value is IdeaStatus {
  return (IDEA_STATUSES as readonly string[]).includes(value);
}

export function isIdeaDecision(value: string): value is IdeaDecision {
  return (IDEA_DECISIONS as readonly string[]).includes(value);
}

/** Only an approved idea may seed a run; everything else waits or is done. */
export function isPickableIdea(status: string): boolean {
  return status === PICKABLE_IDEA_STATUS;
}

/** A decision is legal only while the idea is still waiting for one. */
export function isIdeaDecidable(status: string): boolean {
  return status === IDEA_STATUS_QUEUED;
}

/**
 * The gate itself: the status an idea moves to, given a human decision. A
 * second decision never silently overwrites the first — it is refused, because
 * "approved then rejected" and "rejected then approved" would both be lies
 * about what a human said.
 */
export function decideIdea(status: string, decision: IdeaDecision): IdeaStatus {
  if (!isIdeaDecidable(status)) {
    throw new ForbiddenError(`idea is ${status}, so it is past the human gate`);
  }
  return decision === 'approve' ? PICKABLE_IDEA_STATUS : IDEA_STATUS_REJECTED;
}

/** Audit-log action name for a decision, so every surface records it alike. */
export function ideaDecisionAction(decision: IdeaDecision): string {
  return decision === 'approve' ? 'idea.approved' : 'idea.rejected';
}
