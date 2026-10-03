/**
 * What kind of work an idea is, and what that costs.
 *
 * The deck used to have two kinds — `feature` and `technical` — and every stage
 * treated them the same apart from the label on the deliverable. That made a
 * one-line test addition pay for a product requirements document, a token-grep
 * "verification" pass and a browser run with a screen recording. The operator's
 * words: *"this is not even a feature this is chore. chore should be a separate
 * workflow. chores dont need a PRD. nor idea verification."*
 *
 * So the kind is not a label any more, it is the workflow selector. One table,
 * read by the specifier (does this get specified?), the pipeline (does this get
 * a PRD? a browser?) and the deck (what is a human looking at?).
 *
 *   feature   product work a user can see. Full treatment: specification,
 *             PRD, browser UAT, demo recording.
 *   refactor  on-demand structural work, carefully specced, no user-visible
 *             behaviour to watch: specification + PRD, but its acceptance is
 *             the test suite, not a recording.
 *   chore     maintenance found by signals (a disabled check, a cluster of
 *             TODOs, an untested area). No specification, no PRD, no browser:
 *             the acceptance oracle is the repository's own checks.
 */

/** The vocabulary, in the order the deck shows it. */
export const KINDS = Object.freeze(['feature', 'chore', 'refactor']);

/**
 * Names that used to mean something. `technical` was the old word for what is
 * now `chore`; records on disk and delivered artifacts still carry it, and a
 * card that reads as an unknown kind would fall out of every workflow gate.
 */
export const LEGACY_KINDS = Object.freeze({ technical: 'chore' });

/**
 * What an API is allowed to send: the current words plus the ones old clients
 * still use. Validation reads this instead of its own list, so "the server
 * rejects chore" and "the form offers chore" cannot both be true.
 */
export const KIND_INPUTS = Object.freeze([...KINDS, ...Object.keys(LEGACY_KINDS)]);

export function normalizeKind(kind) {
  const value = kind == null ? '' : String(kind).trim().toLowerCase();
  if (KINDS.includes(value)) return value;
  return LEGACY_KINDS[value] ?? 'feature';
}

/**
 * Sources that produce maintenance work rather than product work.
 *
 * The deck split product features from engineering chores, so a record from
 * before that split (or one proposed without a kind) has to be classified
 * rather than defaulted: reading a "clean up 10 TODO markers" card as a
 * user-facing feature would put it on the swipe deck as something to ship.
 */
export const CHORE_SOURCES = new Set([
  'ci-failure',
  'ci-missing',
  'todo-cluster',
  'disabled-check',
  'deploy-hook',
  'untested-area',
  'backlog',
  'fix-churn',
]);

export function kindForSource(source) {
  return CHORE_SOURCES.has(source) ? 'chore' : 'feature';
}

/**
 * The workflow each kind buys. Every consumer reads this instead of testing
 * `kind === 'feature'` in its own way — that is how the pipeline and the deck
 * stay in agreement about what a chore is.
 *
 *   specification  'full' | 'none'   — spec document, code verification, rescore
 *   prd            boolean           — write a requirements document
 *   qa             'uat' | 'checks'  — browser run + recording, or the checks
 *   deliverable    'demo' | 'changelog'
 */
export const WORKFLOWS = Object.freeze({
  feature: Object.freeze({
    kind: 'feature',
    label: 'Feature',
    specification: 'full',
    prd: true,
    qa: 'uat',
    deliverable: 'demo',
  }),
  refactor: Object.freeze({
    kind: 'refactor',
    label: 'Refactor',
    specification: 'full',
    prd: true,
    qa: 'checks',
    deliverable: 'changelog',
  }),
  chore: Object.freeze({
    kind: 'chore',
    label: 'Chore',
    specification: 'none',
    prd: false,
    qa: 'checks',
    deliverable: 'changelog',
  }),
});

/** The workflow for a kind, tolerating the legacy spellings. Never throws. */
export function workflowFor(kind) {
  return WORKFLOWS[normalizeKind(kind)];
}

/** Does this kind need a specification (and the verification that comes with it)? */
export function needsSpecification(kind) {
  return workflowFor(kind).specification !== 'none';
}

/** Does this kind get a product requirements document? */
export function needsPrd(kind) {
  return workflowFor(kind).prd === true;
}

/** How is this kind's QA run: 'uat' (browser + recording) or 'checks'? */
export function qaModeFor(kind) {
  return workflowFor(kind).qa;
}
