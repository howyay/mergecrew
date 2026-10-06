/**
 * Idea scoring.
 *
 * One rubric, four axes, fixed weights — so two ideas generated a week apart
 * are comparable, and so a swipe decision has a number behind it instead of a
 * vibe. Pure functions; no I/O, no clock.
 *
 *   impact      0–40  how much it moves the product
 *   confidence  0–20  how sure we are it is real and correctly scoped
 *   effort      0–20  inverse of cost (small change scores high)
 *   risk        0–20  inverse of blast radius (safe scores high)
 *
 * Bands: ≥75 must · ≥55 should · ≥35 could · else wont.
 */

export const RUBRIC = Object.freeze({ impact: 40, confidence: 20, effort: 20, risk: 20 });

const AXES = Object.keys(RUBRIC);
const clamp = (n, max) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)));

export function bandFor(score) {
  if (score >= 75) return 'must';
  if (score >= 55) return 'should';
  if (score >= 35) return 'could';
  return 'wont';
}

/**
 * Score a raw feature vector. Values above an axis ceiling are clamped rather
 * than rejected: an over-eager LLM should degrade, not crash the pipeline.
 */
export function scoreIdea(features = {}) {
  const clamped = {};
  for (const axis of AXES) clamped[axis] = clamp(features[axis], RUBRIC[axis]);
  const score = AXES.reduce((sum, axis) => sum + clamped[axis], 0);
  return {
    features: clamped,
    score,
    band: bandFor(score),
    reasons: AXES.map((axis) => `${axis} ${clamped[axis]}/${RUBRIC[axis]}`),
  };
}

/**
 * Deterministic feature estimate when the generator hands us no LLM numbers.
 * Derived only from the evidence an idea already carries, so the same idea
 * always scores the same.
 *
 * Impacts are deliberately conservative for housekeeping work: only a red trunk
 * (`ci-failure`) reaches `must`. A TODO cluster or an untested `ops/` area is
 * real work, but it must not outrank a broken build.
 */
export function scoreFromIdea(idea) {
  const evidence = idea.evidence?.length ?? 0;
  const source = idea.source ?? 'unknown';
  const impactBySource = {
    // Product features are what this pipeline exists to ship: a row in the
    // product's own inventory is a user-visible capability, not plumbing.
    'product-feature': 34,
    'product-in-progress': 28,
    // A human asked for this one by hand — the strongest value signal
    // available before the specifier has anything to say.
    human: 32,
    'ci-failure': 36,
    'ci-missing': 24,
    'disabled-check': 22,
    'deploy-hook': 20,
    'untested-area': 18,
    backlog: 30,
    'fix-churn': 26,
    'todo-cluster': 14,
    llm: 26,
  };
  const effortByHint = { small: 20, medium: 13, large: 6 };
  const effort = effortByHint[idea.effortHint] ?? 13;
  const impact = impactBySource[source] ?? 22;
  const confidence = Math.min(20, 6 + evidence * 4 + (idea.evidence?.some((e) => /:\d+/.test(e)) ? 4 : 0));
  const risk = source === 'todo-cluster' || source === 'ci-missing' ? 19 : source === 'ci-failure' ? 14 : 12;
  return scoreIdea({ impact, confidence, effort, risk });
}

