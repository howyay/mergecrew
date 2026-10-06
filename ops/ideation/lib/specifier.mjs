/**
 * Specification, verification and scoring.
 *
 * Stage 2 of the pipeline. An idea arrives from the generator as a *claim* — a
 * row in a document, a failing check, a cluster of TODOs. Before a human is
 * asked to swipe, this module turns the claim into something a reviewer can
 * actually judge:
 *
 *   generalization — the capability stated in general terms, without the
 *                    document's wording, so the card says what it *is*
 *   verification   — what the code says about the claim, with file:line
 *                    evidence. A doc row that says "Planned" can be stale.
 *   specification  — acceptance criteria, out of scope, open questions
 *   scoring        — the rubric re-run on the verified picture, not the claim
 *
 * Two ways to do it, and the card always records which one ran:
 *
 *   heuristic (default) — deterministic. Cheap checks over the repo, criteria
 *                         derived from the row, verification explicitly marked
 *                         `possible` when it is only a token match.
 *   agent               — a dev agent with a scratch worktree at HEAD, told to
 *                         verify against the code before writing SPEC.json.
 *                         Anything it cannot verify, it must say so.
 *
 * Nothing here is allowed to assert what it did not check: `basis` on the
 * verification record is what the deck shows the human.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { scoreIdea } from './scorer.mjs';
import { needsSpecification, normalizeKind } from './kinds.mjs';

const pexec = promisify(execFile);

export const SPEC_MODES = ['agent', 'heuristic', 'off'];

/** Resolve IDEATION_SPECIFIER. Unknown values fall back to the safe default. */
export function specifierMode(env = process.env) {
  const mode = String(env.IDEATION_SPECIFIER ?? 'heuristic').toLowerCase();
  return SPEC_MODES.includes(mode) ? mode : 'heuristic';
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'then', 'than', 'them', 'they',
  'your', 'you', 'our', 'its', 'per', 'via', 'all', 'use', 'uses', 'using', 'used', 'user', 'users',
  'new', 'not', 'yet', 'map', 'app', 'apps', 'page', 'pages', 'view', 'views', 'list', 'show', 'shows',
  'agent', 'agents', 'feature', 'features', 'support', 'supports', 'based', 'able', 'plus', 'one', 'two',
  'project', 'projects', 'team', 'teams', 'org', 'orgs', 'api', 'apis', 'ui', 'end', 'day', 'daily',
]);

/** Distinctive tokens in a feature name — how the code would spell it. */
export function keywordsIn(text, { max = 2 } = {}) {
  const counts = new Map();
  for (const raw of String(text ?? '').match(/[A-Za-z][A-Za-z0-9-]{3,}/g) ?? []) {
    const token = raw.toLowerCase();
    if (STOPWORDS.has(token) || token.includes('--')) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.keys()]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, max);
}

/**
 * Search the product code for a token. Returns real matches, never a guess.
 *
 * `git grep` on purpose: it is fast, it respects the index, and an exit code of
 * 1 ("no match") is a normal answer rather than an error.
 */
export async function grepCode(repo, token, { limit = 3, exec = pexec } = {}) {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', repo, 'grep', '-n', '-I', '-i', '-F', '-e', token, '--', 'apps', 'packages', 'src'],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, limit)
      .map((line) => line.replace(/^[^:]+:/, (m) => m).slice(0, 200));
  } catch {
    return [];
  }
}

/**
 * Ask the code whether this feature already exists.
 *
 * A token match is not proof: `SAML` in a test fixture is not SAML support. So
 * the verdict is `possible`, carries the matches, and says what it is — the
 * human decides. Only a match count high enough to be structural is reported as
 * more than a hint.
 */
export async function verifyAgainstCode(idea, { repo, grep = grepCode } = {}) {
  const tokens = keywordsIn(idea.title ?? '');
  const checkedAt = new Date().toISOString();
  if (!tokens.length) {
    return { checkedAt, by: 'heuristic', basis: 'no-distinctive-token', alreadyImplemented: null, tokens: [], evidence: [], notes: 'No distinctive token in the title to search for; the code was not consulted.' };
  }
  const evidence = [];
  let hits = 0;
  for (const token of tokens) {
    const matches = await grep(repo, token);
    hits += matches.length;
    evidence.push(...matches.map((m) => ({ path: m.split(':')[0], line: Number(m.split(':')[1]) || null, note: m.trim().slice(0, 200), token })));
  }
  const alreadyImplemented = hits >= 3 ? 'possible' : null;
  return {
    checkedAt,
    by: 'heuristic',
    basis: 'token-grep',
    alreadyImplemented,
    tokens,
    evidence: evidence.slice(0, 6),
    notes:
      hits === 0
        ? `No match for ${tokens.map((t) => `"${t}"`).join(' or ')} under apps/, packages/ or src/ — consistent with the doc's claim that it is not built.`
        : `${hits} match(es) for ${tokens.map((t) => `"${t}"`).join(' or ')} in the product code. A token match is not proof of the feature; read the evidence before trusting either way.`,
  };
}

/** The capability, restated without the source document's wording. */
export function generalize(idea) {
  const feature = String(idea.title ?? '').replace(/^(Ship|Finish):\s*/, '').trim();
  const persona = idea.persona ? `${idea.persona} ` : '';
  const kind = normalizeKind(idea.kind) === 'chore' ? 'a maintenance change' : 'a user-visible capability';
  const scope = idea.section ? ` in the "${idea.section}" area of the product` : '';
  if (idea.source === 'product-in-progress') {
    return `Finish ${feature}${scope}: ${persona}users can already do part of it, and the remaining part is not built. The work is to close the gap, not to rebuild what exists.`;
  }
  return `Ship ${feature}${scope}: ${kind} that ${persona}users cannot get today. The work is to make it reachable end to end, not to scaffold it.`;
}

/** Acceptance criteria a reviewer can hold the work to. */
export function acceptanceFor(idea) {
  const feature = String(idea.title ?? '').replace(/^(Ship|Finish):\s*/, '').trim();
  const persona = idea.persona ?? 'the primary persona';
  const partial = idea.source === 'product-in-progress';
  return [
    `${persona} can complete "${feature}" end to end through the product UI, with no manual step outside it.`,
    partial
      ? `The part the product doc already marks as landed still works exactly as before.`
      : `Nothing that exists today stops working: the repo's own gate (\`node ops/ci/ci-loop.mjs --once\`) passes on the branch.`,
    `A test fails before the change and passes after it, and names the behaviour rather than the implementation.`,
    `The recorded demo shows the capability being used — not only the page it would live on.`,
  ];
}

export function outOfScopeFor(idea) {
  const out = [
    idea.section
      ? `Anything outside "${idea.section}": this ships one row of the product's inventory, not a redesign of the area around it.`
      : `Anything not required to make the capability work end to end.`,
    `New infrastructure, providers or dependencies that the capability does not strictly need.`,
  ];
  if (idea.source === 'product-in-progress') {
    out.push(`Re-implementing the part the doc already reports as landed.`);
  }
  return out;
}

export function openQuestionsFor(idea) {
  const questions = [];
  if (idea.source === 'product-feature') {
    questions.push(`Which slice ships first? The product doc names a capability, not a milestone.`);
  }
  if (idea.source === 'product-in-progress') {
    questions.push(`What exactly is missing? The doc says "in progress"; only the code is authoritative.`);
  }
  if (idea.persona) {
    questions.push(`Is ${idea.persona} the right persona to optimise for in the first slice?`);
  }
  questions.push(`Does this need a flag, or can it be the only behaviour?`);
  return questions;
}

/** The spec document. Rendered from the same fields the deck reads. */
export function renderSpecMarkdown(idea, { spec, verification }) {
  const lines = [
    `# ${idea.title}`,
    '',
    `- idea: ${idea.id}`,
    `- source: ${idea.source}`,
    `- kind: ${idea.kind ?? 'feature'}`,
    idea.persona ? `- persona: ${idea.persona}` : null,
    idea.section ? `- product area: ${idea.section}` : null,
    `- specification: ${spec.specifiedBy}`,
    `- verified: ${verification.basis} (${verification.checkedAt})`,
    '',
    '## Generalization',
    '',
    spec.generalization,
    '',
    '## Summary',
    '',
    spec.summary,
    '',
    '## Acceptance criteria',
    '',
    ...spec.acceptance.map((a, i) => `${i + 1}. ${a}`),
    '',
    '## Out of scope',
    '',
    ...spec.outOfScope.map((o) => `- ${o}`),
    '',
    '## Open questions',
    '',
    ...spec.openQuestions.map((q) => `- ${q}`),
    '',
    '## Evidence',
    '',
    ...(idea.evidence ?? []).map((e) => `- \`${e}\``),
    '',
    '## Verification',
    '',
    `- already implemented: ${verification.alreadyImplemented ?? 'unknown'}`,
    `- basis: ${verification.basis}`,
    `- notes: ${verification.notes}`,
  ];
  if (verification.evidence?.length) {
    lines.push('', '| where | note |', '| --- | --- |');
    for (const e of verification.evidence) lines.push(`| \`${e.path}:${e.line ?? '?'}\` | ${String(e.note ?? '').replace(/\|/g, '\\|')} |`);
  } else {
    lines.push('', '_No code evidence was found either way._');
  }
  return lines.filter((l) => l !== null).join('\n') + '\n';
}

/**
 * Re-score on the verified picture rather than the claim.
 *
 * The only axis the verification moves is impact: a feature that the code
 * already seems to have is worth much less than one it does not. Confidence
 * moves with the *quality* of the verification (an agent read the code; a
 * grep matched tokens), never with how good the idea sounds.
 */
export function scoreSpecified(idea, verification, { effortHint } = {}) {
  const baseImpact = normalizeKind(idea.kind) === 'chore' ? 26 : idea.source === 'product-in-progress' ? 28 : 34;
  const alreadyThere = verification?.alreadyImplemented === 'possible';
  const impact = alreadyThere ? 10 : baseImpact;
  const evidenceCount = (idea.evidence?.length ?? 0) + (verification?.evidence?.length ?? 0);
  const verifiedByAgent = verification?.basis === 'agent-read-code';
  let confidence = Math.min(20, 8 + Math.min(6, evidenceCount * 2) + (verifiedByAgent ? 6 : 0));
  if (verification?.basis === 'no-distinctive-token') confidence = Math.max(6, confidence - 4);
  const effortMap = { small: 20, medium: 13, large: 6 };
  const effort = effortMap[effortHint ?? idea.effortHint] ?? 13;
  const risky = /\b(auth|sso|saml|scim|payment|billing|migration|secret|token|encryption)\b/i.test(`${idea.title} ${idea.section ?? ''}`);
  const risk = risky ? 8 : 14;
  const scored = scoreIdea({ impact, confidence, effort, risk });
  const scoreReasons = [...scored.reasons];
  if (alreadyThere) scoreReasons.push('impact cut: the code appears to already contain this');
  if (verifiedByAgent) scoreReasons.push('confidence raised: an agent read the code, not just the doc');
  if (risky) scoreReasons.push('risk lowered: the title or area touches auth, payments or migrations');
  return { ...scored, scoreReasons };
}

/**
 * Build the deterministic specification for one idea.
 *
 * Split out from the store so it can be tested without a deck, and so the agent
 * path can reuse the same acceptance/out-of-scope derivation as its fallback.
 */
export async function heuristicSpecify(idea, { repo, verify = verifyAgainstCode, at = new Date().toISOString() } = {}) {
  const verification = await verify(idea, { repo });
  const spec = {
    kind: idea.kind ?? 'feature',
    summary: `${String(idea.title ?? '').replace(/^(Ship|Finish):\s*/, '')} — from ${idea.source}${idea.section ? ` (${idea.section})` : ''}.`,
    generalization: generalize(idea),
    persona: idea.persona ?? null,
    acceptance: acceptanceFor(idea),
    outOfScope: outOfScopeFor(idea),
    openQuestions: openQuestionsFor(idea),
    specifiedAt: at,
    specifiedBy: 'heuristic',
  };
  spec.markdown = renderSpecMarkdown(idea, { spec, verification });
  return { spec, verification, ...scoreSpecified(idea, verification, { effortHint: idea.effortHint }) };
}

/** Where a spec document is kept. One file per idea, overwritten on re-spec. */
export function specPath(repo, idea) {
  return path.join(repo, 'ops/ideation/specs', `${idea.id}.md`);
}

/**
 * Specify one idea and persist the result: spec document on disk, spec +
 * verification + score in the store, timeline event for the human.
 */
export async function specifyIdea(idea, { repo, store, verify, at } = {}) {
  // `specifyDue` already filters chores; this guard is for direct callers (the
  // propose endpoint, anything a human runs by hand). A chore is defined by the
  // signal that produced it, so a generated specification would be invention.
  if (!needsSpecification(idea?.kind)) {
    return {
      spec: null,
      verification: null,
      skipped: `a ${normalizeKind(idea?.kind)} is not specified`,
    };
  }
  await store.setStage(idea.id, 'specifying').catch(() => null);
  try {
    const result = await heuristicSpecify(idea, { repo, verify, at });
    const file = specPath(repo, idea);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, result.spec.markdown, 'utf8');
    const stored = await store.setSpecification(idea.id, {
      spec: { ...result.spec, file: path.relative(repo, file) },
      verification: result.verification,
      features: result.features,
      score: result.score,
      band: result.band,
      scoreReasons: result.scoreReasons,
      by: result.spec.specifiedBy,
    });
    return { ...result, file: path.relative(repo, file), idea: stored };
  } catch (err) {
    await store.setSpecFailure(idea.id, err?.message ?? String(err)).catch(() => null);
    return { spec: null, verification: null, error: String(err?.message ?? err) };
  }
}

/** Specify every draft card, oldest first, up to `limit` per pass. */
export async function specifyDue(store, { repo, limit = 3, log = () => {}, verify, at } = {}) {
  const data = await store.read();
  // Chores are not specified, verified or scored: the signal that produced one
  // already says what has to change, and a specification would only restate it.
  // They also must not consume the specifier's per-pass budget, which belongs to
  // the cards a human actually has to judge.
  const chores = data.ideas.filter((i) => !needsSpecification(i.kind));
  const due = data.ideas
    .filter((i) => (i.stage ?? 'draft') === 'draft' && i.status === 'pending' && needsSpecification(i.kind))
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .slice(0, limit);
  if (chores.length && log) {
    log(`${chores.length} chore(s) need no specification: ${chores.map((i) => i.id).join(', ')}`);
  }
  const done = [];
  for (const idea of due) {
    const result = await specifyIdea(idea, { repo, store, verify, at });
    done.push({ id: idea.id, ok: Boolean(result.spec), score: result.score ?? null, alreadyImplemented: result.verification?.alreadyImplemented ?? null });
    log(`specified ${idea.id} (${result.spec?.specifiedBy ?? 'failed'}) score=${result.score ?? '-'}${result.error ? ` error=${result.error}` : ''}`);
  }
  return done;
}

/** Read a spec document written by the agent path. */
export async function readSpecFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
