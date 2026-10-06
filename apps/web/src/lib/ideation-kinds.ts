/**
 * The idea-kind taxonomy, in a module both halves of the boundary can import.
 *
 * `lib/ideation.ts` owns the state file and therefore imports `node:fs` and
 * `node:crypto`; a client component that imported a runtime value from there
 * would drag those into the browser bundle. The kind rules are pure data, so
 * they live here, `lib/ideation.ts` re-exports them, and the deck imports them
 * from here. One definition, no duplication.
 */

/**
 * What a card is. `chore` is maintenance work: the operator has ruled that it is
 * not a product feature, so it is never specified and its QA stage is repo
 * checks rather than a browser session. That decision belongs to the host
 * pipeline — this module only reads it.
 */
export type IdeaKind = 'feature' | 'refactor' | 'chore';

/**
 * Kinds a writer may send. `technical` is the name this build used before
 * `chore` existed and is still accepted on write (then stored canonically as
 * `chore`), because a stale client or a saved curl command must not start
 * failing with a 400 over a rename.
 */
export const IDEA_KIND_INPUTS = ['feature', 'refactor', 'chore', 'technical'] as const;

/**
 * The kind as this build understands it.
 *
 * `technical` was the earlier spelling of `chore` and is still on disk — those
 * records must render as chores, not as a fourth kind this build cannot show.
 * Anything unrecognised reads as a feature, which is the conservative default:
 * a feature is the only kind whose card waits for a specification, so an
 * unknown kind can never slip past the specifier gate.
 *
 * The comparison is case- and whitespace-insensitive to stay byte-for-byte in
 * step with `ops/ideation/lib/kinds.mjs`, which is the writer of this field:
 * it trims and lowercases before matching, so a record it reads as a chore
 * (say a hand-edited `"Technical"`) must not read as a feature here, or the
 * deck would offer a swipe on a card whose workflow says "no specification".
 */
export function normalizeKind(kind: unknown): IdeaKind {
  const value = kind == null ? '' : String(kind).trim().toLowerCase();
  if (value === 'chore' || value === 'technical') return 'chore';
  if (value === 'refactor') return 'refactor';
  return 'feature';
}

/**
 * Whether a card must be specified before a human may swipe it.
 *
 * A chore does not: there is no product claim to verify against the code, and
 * the operator's rule is that maintenance work is not a product decision. It is
 * still gated on staleness — a withdrawn card is withdrawn for every kind.
 */
export function needsSpecification(kind: unknown): boolean {
  return normalizeKind(kind) !== 'chore';
}

/**
 * Whether the delivered artefact is a changelog entry rather than a demo
 * recording. Only a feature has user-visible behaviour worth recording; a
 * refactor and a chore are described by what changed in the repo.
 */
export function isChangelogDeliverable(kind: unknown): boolean {
  return normalizeKind(kind) !== 'feature';
}
