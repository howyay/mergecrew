/**
 * Triage: turn a specified idea into a queue position.
 *
 * Step 2b of the pipeline. The score answers "is this worth doing"; triage
 * answers "before or after what" — which the dev queue needs, because a deck of
 * twelve equally-scored cards is not a plan.
 *
 * A chore is not specified or scored, so it is ranked from the signal that
 * produced it instead (`choreTriage` below): a red build and a TODO cluster must
 * not land in the same place just because neither has a rubric score.
 *
 * The mapping is deterministic and explainable, and every reason is a sentence
 * a human can argue with:
 *
 *   P0  ship next — a product feature the rubric calls `must` and the code says
 *       is missing
 *   P1  high — `must` but possibly already present, or a high-impact `should`
 *   P2  normal — the rest of `should`
 *   P3  last — `could`/`wont`, or the code already appears to contain it
 *
 * A human can override any of it; the override is kept beside the automatic
 * verdict rather than replacing it, so the difference between "the machine
 * ranked this low" and "a person agreed" stays visible.
 */

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

/** Lower rank runs sooner. Priority dominates; score breaks ties inside it. */
export function rankFor(priority, score = 0) {
  const index = Math.max(0, PRIORITIES.indexOf(priority));
  return index * 1000 + Math.max(0, 100 - Math.round(Number(score) || 0));
}

export function triageIdea(idea, { at = new Date().toISOString() } = {}) {
  const score = Number(idea.score) || 0;
  const band = idea.band ?? 'wont';
  const impact = Number(idea.features?.impact) || 0;
  const alreadyThere = idea.verification?.alreadyImplemented === 'possible';

  let priority;
  let reason;
  if (alreadyThere) {
    priority = 'P3';
    reason = `The code appears to already contain this (${idea.verification?.basis ?? 'verification'}), so it is worth a look before it is worth a sprint.`;
  } else if (band === 'must') {
    priority = 'P0';
    reason = `Score ${score} (${band}) on a product feature the code does not appear to have: this is the next thing to build.`;
  } else if (band === 'should' && impact >= 28) {
    priority = 'P1';
    reason = `Score ${score} (${band}) with impact ${impact}/40: high value, not urgent enough to jump the queue.`;
  } else if (band === 'should') {
    priority = 'P2';
    reason = `Score ${score} (${band}): worth building in order, after the higher-impact rows.`;
  } else {
    priority = 'P3';
    reason = `Score ${score} (${band}): keep it, but it should not displace anything above it.`;
  }

  const triage = { priority, rank: rankFor(priority, score), reason, triagedAt: at, override: null };
  if (idea.triage?.override) {
    triage.override = idea.triage.override;
    triage.priority = idea.triage.override.priority;
    triage.rank = rankFor(triage.priority, score);
  }
  return triage;
}

/**
 * Triage for a chore: the same queue position, from a different input.
 *
 * A chore is never scored against the product rubric and is never verified —
 * it *is* the finding (`ops/ideation/lib/kinds.mjs`). Its urgency is therefore
 * the signal that produced it, and that mapping is written down rather than
 * inferred from an empty score, which would have filed a red build under the
 * same "wont" as a TODO cluster.
 */
const CHORE_PRIORITY = {
  'ci-failure': ['P0', 'The build is red: this is the one chore that stops everything else.'],
  'disabled-check': ['P1', 'A check is switched off, so the suite is quieter than it looks.'],
  'deploy-hook': ['P1', 'The delivery path has a hole in it, and the next deploy would not be caught.'],
  'ci-missing': ['P2', 'No automation covers this yet, so it costs more every time it regresses.'],
  'untested-area': ['P2', 'Nothing exercises this area, so every change to it is a guess.'],
  'fix-churn': ['P2', 'This keeps breaking; the maintenance is overdue rather than optional.'],
  'todo-cluster': ['P3', 'Housekeeping: worth doing, but it should not displace a real row.'],
  backlog: ['P3', 'Housekeeping: worth doing, but it should not displace a real row.'],
};

export function choreTriage(idea, { at = new Date().toISOString() } = {}) {
  const [priority, why] = CHORE_PRIORITY[idea.source] ?? [
    'P2',
    'Maintenance work with no product score: ranked on the signal that produced it.',
  ];
  const score = Number(idea.score) || 0;
  const triage = {
    priority,
    rank: rankFor(priority, score),
    reason: `${why} (\`${idea.source ?? 'unknown'}\` chore, no specification: nothing to score.)`,
    triagedAt: at,
    override: null,
  };
  if (idea.triage?.override) {
    triage.override = idea.triage.override;
    triage.priority = idea.triage.override.priority;
    triage.rank = rankFor(triage.priority, score);
  }
  return triage;
}

/** Apply a human's priority override, keeping the automatic verdict beside it. */export function overrideTriage(idea, { priority, reason = null, by = 'human', at = new Date().toISOString() } = {}) {
  if (!PRIORITIES.includes(priority)) throw new Error(`unknown priority "${priority}" (expected ${PRIORITIES.join('|')})`);
  const automatic = { priority: idea.triage?.priority, reason: idea.triage?.reason ?? null };
  return {
    priority,
    rank: rankFor(priority, Number(idea.score) || 0),
    reason: reason ? String(reason).slice(0, 300) : `Set to ${priority} by ${by}.`,
    triagedAt: at,
    override: { priority, reason: reason ? String(reason).slice(0, 300) : null, by, at, automatic },
  };
}

/** Queue order: priority, then rank, then oldest first. */
export function queueOrder(ideas = []) {
  return [...ideas].sort(
    (a, b) =>
      (a.triage?.rank ?? rankFor('P2', a.score)) - (b.triage?.rank ?? rankFor('P2', b.score)) ||
      String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
  );
}
