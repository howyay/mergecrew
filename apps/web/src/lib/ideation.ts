/**
 * Idea triage, read and written from the mergecrew web app.
 *
 * The deck is produced by the `ops/ideation` service on the host (it reads repo
 * signals: git history, TODO markers, the last CI run). This app renders the
 * same idea file and records the human decision, because the swipe UI belongs
 * in the product rather than in a second browser tab.
 *
 * Contract with the host service — deliberately file-based:
 *   - this module writes `status` / `decidedAt` / `decision` / `events` /
 *     `triage` and the cleared `execution`;
 *   - only the host service writes `execution` (task files + agent runs),
 *     `pipeline`, `spec`/`verification` and `lastGeneration`, because it is the
 *     side that can touch the repo;
 *   - the host service sweeps the file every few seconds and turns any accepted
 *     idea into `ops/execution/queue/<id>.md`, so a decision made here becomes
 *     work without a network path between the container and the host.
 *
 * The shapes below mirror `ops/ideation/lib/store.mjs` (STATE_VERSION 2,
 * MAX_EVENTS 200, `appendEvent`, `decide`, `setTriage`), `lib/triage.mjs`
 * (`rankFor` / `overrideTriage`) and `lib/scorer.mjs` (the 40/20/20/20 rubric).
 * They are duplicated rather than imported: the host is .mjs, this is a Next
 * server bundle, and the file is the interface between them.
 *
 * Every field an older record lacks is optional here, because the file holds
 * records written before each field existed — the page must render a v1 card
 * without crashing.
 *
 * The file is mounted from the host (see docker-compose.override.yml); without
 * the mount this module must not pretend the feature works.
 */
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IDEA_KIND_INPUTS, isChangelogDeliverable, needsSpecification, normalizeKind, type IdeaKind } from './ideation-kinds';

export type IdeaBand = 'must' | 'should' | 'could' | 'wont';
export type IdeaStatus = 'pending' | 'accepted' | 'rejected';

/**
 * The kind taxonomy and the rules that hang off it live in `./ideation-kinds`,
 * which a client component may import (this module imports `node:fs`). They are
 * re-exported here so server code keeps one import: `@/lib/ideation`.
 */
export { IDEA_KIND_INPUTS, isChangelogDeliverable, needsSpecification, normalizeKind };
export type { IdeaKind };
/** `draft` → `specifying` → `specified`, or `spec-failed`. Only `specified` is swipable. */
export type IdeaStage = 'draft' | 'specifying' | 'specified' | 'spec-failed';

/** The four rubric axes, ceilings from `ops/ideation/lib/scorer.mjs`. */
export type IdeaFeatures = { impact: number; confidence: number; effort: number; risk: number };

export const RUBRIC_MAX: IdeaFeatures = { impact: 40, confidence: 20, effort: 20, risk: 20 };

/** One stage of the host pipeline, as the host last recorded it. */
export type PipelineStage = Record<string, unknown> & { status?: string; reason?: string | null; at?: string };

/**
 * One command the QA stage ran, for the kinds whose QA is repo checks rather
 * than a browser session. `evidence` is the tail of the output the host kept —
 * present on a failure, because "the check failed" without the line that failed
 * is not something a human can act on.
 */
export type IdeaCheckResult = {
  command: string;
  status: 'passed' | 'failed';
  exitCode?: number | null;
  evidence?: string | null;
};

/** A check the QA stage decided not to run, and the host's reason. */
export type IdeaSkippedCheck = { command: string; reason?: string | null };

export type IdeaPipeline = {
  status?: string;
  reason?: string | null;
  error?: string | null;
  attempts?: number;
  updatedAt?: string;
  prd?: { file: string; bytes: number; at: string; acceptance?: string[] };
  issue?: { status: string; url: string | null; number: number | null; file?: string; reason?: string };
  worktree?: { status: string; dir: string; branch: string; taskFile?: string };
  dev?: PipelineStage & {
    provider?: string;
    pid?: number;
    logFile?: string;
    logTail?: string;
    /** The harness session the agent run lives in, read back from its log. */
    sessionId?: string | null;
    watchUrl?: string | null;
    commit?: string | null;
    commitFiles?: number;
  };
  /**
   * Stage 4. Two records share this slot and the card tells them apart by
   * shape: a browser session for a feature (`verdict`, `report`, `demo`), repo
   * checks for a chore (`results`, `skipped`, no browser and no recording).
   * A chore never gets a `demo`, which is why the card can key on it.
   */
  qa?: PipelineStage & {
    verdict?: string;
    report?: string;
    demo?: string;
    apng?: string;
    port?: number;
    /** The commands the checker ran, in order. */
    results?: IdeaCheckResult[];
    /** The commands it deliberately did not run. */
    skipped?: IdeaSkippedCheck[];
    /** When the check run finished (the browser record also carries this). */
    ranAt?: string;
  };
  /** Stage 5's artefact: a demo recording for a feature, a changelog entry otherwise. */
  deliver?: PipelineStage & {
    kind?: string;
    file?: string;
    title?: string;
    demo?: string | null;
    changelog?: string | null;
    summary?: string | null;
    wroteAt?: string;
  };
  review?: PipelineStage;
};

/** The specifier's output: what the card is, in general terms, and what done means. */
export type IdeaSpec = {
  kind?: string;
  summary?: string;
  generalization?: string;
  persona?: string | null;
  acceptance?: string[];
  outOfScope?: string[];
  openQuestions?: string[];
  /** The full spec document, as written to `spec.file` by the host. */
  markdown?: string;
  /** Repo-relative path of the spec markdown artefact. */
  file?: string;
  specifiedAt?: string;
  specifiedBy?: string;
};

export type IdeaVerificationEvidence = { path?: string; line?: number | null; note?: string; token?: string };

/**
 * What the host found in the code about the claim. `alreadyImplemented` is
 * deliberately tri-state: `null` means "not checked / no evidence either way",
 * never "no".
 */
export type IdeaVerification = {
  checkedAt?: string;
  by?: string;
  basis?: string;
  alreadyImplemented?: null | 'possible';
  evidence?: IdeaVerificationEvidence[];
  notes?: string;
  tokens?: string[];
};

export type IdeaPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type IdeaTriageOverride = {
  priority: IdeaPriority;
  reason: string | null;
  by: string;
  at: string;
  /** The machine's verdict that this override replaced, kept beside it. */
  automatic: { priority: IdeaPriority | null; reason: string | null };
};

export type IdeaTriage = {
  priority?: IdeaPriority;
  rank?: number;
  reason?: string | null;
  triagedAt?: string;
  override?: IdeaTriageOverride | null;
};

/** The human's verdict at the swipe gate, with the reviewer's own words. */
export type IdeaDecision = { at: string; by: string; comment: string | null; commented: boolean };

/**
 * One row of the append-only per-idea log. `kind` is read as a plain string:
 * the host writes kinds this build does not know yet, and an unknown verb must
 * render as text rather than crash the timeline.
 */
export type IdeaEvent = { at: string; kind: string; detail?: string | null; by?: string };

/** Event kinds this app writes. The host may write others. */
export const IDEA_EVENT_KINDS = [
  'proposed',
  'specified',
  'spec-failed',
  'accepted',
  'rejected',
  'decision-undone',
  'priority',
  'stale',
  'queued',
  'dispatch-failed',
] as const;
export type IdeaEventKind = (typeof IDEA_EVENT_KINDS)[number];

/** A per-idea event flattened with the idea it belongs to — one timeline row. */
export type TimelineRow = {
  at: string;
  kind: string;
  detail: string | null;
  by: string;
  id: string;
  title: string;
  source: string;
  ideaStatus: IdeaStatus | string;
  ideaKind: string;
  priority: IdeaPriority | null;
  /** The reviewer's words, for `rejected` rows. */
  comment: string | null;
};

export type Idea = {
  id: string;
  title: string;
  status: IdeaStatus;
  fingerprint?: string;
  rationale?: string;
  source?: string;
  /**
   * Read as a plain string on purpose: records written before the chore rename
   * say `technical`, and a future host may write a kind this build has never
   * heard of. `normalizeKind` is what turns that into one of the three kinds.
   */
  kind?: string;
  evidence?: string[];
  effortHint?: 'small' | 'medium' | 'large';
  features?: IdeaFeatures;
  score?: number;
  band?: IdeaBand;
  scoreReasons?: string[];
  persona?: string | null;
  section?: string | null;
  createdAt?: string;
  decidedAt?: string | null;
  stale?: boolean;
  /** Set by the host specifier; a card is only swipable once this exists. */
  stage?: IdeaStage;
  specFailedReason?: string | null;
  spec?: IdeaSpec | null;
  verification?: IdeaVerification | null;
  triage?: IdeaTriage | null;
  decision?: IdeaDecision | null;
  events?: IdeaEvent[];
  /** Written only by the host pipeline; the app never invents a stage. */
  pipeline?: IdeaPipeline | null;
  /** The human's verdict on the delivered work (second gate). */
  review?: { decision: ReviewDecision; at: string; by: string; note: string | null } | null;
  execution?: {
    status: 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'none';
    taskFile?: string;
    reason?: string | null;
    pid?: number | null;
    finishedAt?: string | null;
    updatedAt?: string;
  } | null;
};

export type IdeaState = {
  version: number;
  updatedAt: string | null;
  lastGeneration:
    | {
        generator: string;
        fallbackReason: string | null;
        head: string | null;
        proposed: number;
        added: number;
        skipped: number;
        staleMarked?: number;
        staleCleared?: number;
        durationMs: number;
        at: string;
      }
    | null;
  ideas: Idea[];
};

/** The version the host writes; this module writes the same shape. */
export const STATE_VERSION = 2;
/** Per-idea event log cap, from `ops/ideation/lib/store.mjs`. */
export const MAX_EVENTS = 200;

export const IDEATION_STATE_FILE = process.env.IDEATION_STATE_FILE ?? '/data/ideas.json';

const emptyState = (): IdeaState => ({ version: STATE_VERSION, updatedAt: null, lastGeneration: null, ideas: [] });

export async function readIdeaState(): Promise<IdeaState> {
  try {
    const parsed = JSON.parse(await readFile(IDEATION_STATE_FILE, 'utf8')) as Partial<IdeaState>;
    return {
      version: parsed.version ?? STATE_VERSION,
      updatedAt: parsed.updatedAt ?? null,
      lastGeneration: parsed.lastGeneration ?? null,
      ideas: Array.isArray(parsed.ideas) ? parsed.ideas : [],
    };
  } catch {
    return emptyState();
  }
}

/**
 * Serialize mutations inside this process. The host service writes the same
 * file, so the read-modify-write below is kept as short as possible; a lost
 * update is possible in principle and would cost one regeneration, not data.
 */
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Replace the state file atomically: temp file + rename, so a reader (the host
 * sweep) never sees a half-written deck. `ideas` is written whole, which is why
 * every mutation starts from the freshly-read state — one idea's decision must
 * never drop another idea's spec.
 */
async function writeState(state: IdeaState): Promise<IdeaState> {
  const next: IdeaState = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  const tmp = `${IDEATION_STATE_FILE}.web.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, IDEATION_STATE_FILE);
  return next;
}

/**
 * Append one event to an idea's log, capped exactly as the host caps it.
 *
 * Note that this mutates `idea` in place, like `store.mjs::appendEvent`: the
 * caller already holds the record it is about to write.
 */
export function appendEvent(
  idea: Idea,
  {
    kind,
    detail = null,
    by = 'human',
    at = new Date().toISOString(),
  }: { kind: string; detail?: string | null; by?: string; at?: string },
): IdeaEvent {
  idea.events = Array.isArray(idea.events) ? idea.events : [];
  const event: IdeaEvent = { at, kind, detail, by };
  idea.events.push(event);
  if (idea.events.length > MAX_EVENTS) idea.events.splice(0, idea.events.length - MAX_EVENTS);
  return event;
}

/** Lower rank runs sooner. Priority dominates; score breaks ties inside it. */
export function rankFor(priority: string, score = 0): number {
  const index = (PRIORITIES as readonly string[]).indexOf(priority);
  return Math.max(0, index) * 1000 + Math.max(0, 100 - Math.round(Number(score) || 0));
}

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

export function isPriority(value: unknown): value is IdeaPriority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

/**
 * The swipe gate. A feature or refactor may be decided only once the host
 * specifier has verified it against the code and written a real spec — a draft
 * is a claim, not a proposal, and a stale card's evidence no longer holds.
 *
 * A chore is exempt from the specification (`needsSpecification`): the operator
 * has ruled that maintenance work is not a product decision, so there is no
 * product claim to verify and nothing for the deck to wait for. Staleness still
 * blocks it — a withdrawn card is withdrawn for every kind.
 */
export function isSwipeable(idea: Idea): boolean {
  if (idea.status !== 'pending' || idea.stale) return false;
  if (!needsSpecification(idea.kind)) return true;
  return (idea.stage ?? 'draft') === 'specified';
}

/** Why a pending card is not swipable yet, in the operator's words. */
export function preparingReason(idea: Idea): string {
  if (idea.status !== 'pending') return `already ${idea.status}`;
  if (idea.stale) {
    return 'the evidence this card was built from no longer holds (stale) — it is withdrawn until a cycle re-proposes it';
  }
  if (!needsSpecification(idea.kind)) {
    // Reachable only if a caller asks about a card that is in fact swipable:
    // no specification is ever written for a chore, so it is never "waiting".
    return 'maintenance work — chores are not specified, so this one goes straight to a decision';
  }
  const stage = idea.stage ?? 'draft';
  if (stage === 'specifying') return 'the host specifier is verifying it against the code right now';
  if (stage === 'spec-failed') {
    return `specification failed — ${idea.specFailedReason ?? 'the host recorded no reason'}`;
  }
  if (stage === 'specified') return 'ready to decide';
  return 'waiting for the host specifier to verify it against the code and write acceptance criteria';
}

/**
 * Server-side half of the swipe gate. The deck only offers ready cards; this is
 * what stops a hand-made POST from accepting a draft. `null` means no such idea.
 */
export async function swipeGate(id: string): Promise<{ ok: true } | { ok: false; reason: string } | null> {
  const state = await readIdeaState();
  const idea = state.ideas.find((i) => i.id === id);
  if (!idea) return null;
  return isSwipeable(idea) ? { ok: true } : { ok: false, reason: preparingReason(idea) };
}

/**
 * Record the human's verdict at the first gate.
 *
 * Mirrors `IdeaStore.decide`: a rejection may carry the reviewer's own words,
 * and those words go into the event itself rather than beside it — the timeline
 * reads events, and a verdict whose reason lives elsewhere is a verdict nobody
 * can act on later. The generator also receives recent rejection comments as
 * steering, so the next round answers the objection instead of repeating it.
 */
export async function decideIdea(
  id: string,
  decision: IdeaStatus,
  { comment = null, by = 'human' }: { comment?: string | null; by?: string } = {},
): Promise<Idea | null> {
  return withLock(async () => {
    const state = await readIdeaState();
    const idea = state.ideas.find((i) => i.id === id);
    if (!idea) return null;

    const at = new Date().toISOString();
    const note = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 2000) : null;

    idea.status = decision;
    idea.decidedAt = decision === 'pending' ? null : at;
    idea.decision = decision === 'pending' ? null : { at, by, comment: note, commented: Boolean(note) };
    appendEvent(idea, {
      kind: decision === 'pending' ? 'decision-undone' : decision,
      by,
      at,
      detail:
        note ??
        (decision === 'accepted'
          ? 'accepted at the swipe gate'
          : decision === 'rejected'
            ? 'rejected without a comment'
            : 'decision undone'),
    });

    if (decision === 'accepted') {
      // Clearing the record hands the idea to the host sweep: it writes the
      // task file and spawns the runner, and it is the only writer allowed to
      // claim an execution happened.
      idea.execution = null;
    } else {
      idea.execution = { status: 'none', reason: decision === 'rejected' ? 'rejected' : 'decision undone' };
    }

    await writeState(state);
    return idea;
  });
}

/**
 * Apply the operator's priority override, mirroring `triage.mjs::overrideTriage`.
 *
 * The automatic verdict is not replaced — it is kept inside `override`, so the
 * difference between "the machine ranked this low" and "a person disagreed"
 * stays visible to whoever reads the deck next.
 */
export async function setPriority(
  id: string,
  priority: IdeaPriority,
  { reason = null, by = 'human' }: { reason?: string | null; by?: string } = {},
): Promise<Idea | null> {
  return withLock(async () => {
    const state = await readIdeaState();
    const idea = state.ideas.find((i) => i.id === id);
    if (!idea) return null;

    const at = new Date().toISOString();
    const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : null;
    const previous = idea.triage ?? {};
    const automatic = { priority: previous.priority ?? null, reason: previous.reason ?? null };

    idea.triage = {
      ...previous,
      priority,
      rank: rankFor(priority, Number(idea.score) || 0),
      reason: note ?? `Set to ${priority} by ${by}.`,
      triagedAt: at,
      override: { priority, reason: note, by, at, automatic },
    };
    appendEvent(idea, {
      kind: 'priority',
      by,
      at,
      detail: `${automatic.priority ?? '?'} → ${priority}${note ? `: ${note}` : ''}`,
    });

    await writeState(state);
    return idea;
  });
}

export type ProposeInput = {
  title: string;
  /** `technical` is the legacy spelling of `chore`; both are accepted and stored canonically. */
  kind?: (typeof IDEA_KIND_INPUTS)[number];
  rationale?: string | null;
  persona?: string | null;
  by?: string;
};

export type ProposeResult = { ok: true; idea: Idea } | { ok: false; reason: string };

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/** Same derivation as `store.mjs`, so a hand-proposed idea is not an orphan. */
const deriveId = (source: string, title: string): string =>
  `idea-${createHash('sha1').update(`${source}:${title}`).digest('hex').slice(0, 8)}`;

/** Bands from `ops/ideation/lib/scorer.mjs`. */
export function bandFor(score: number): IdeaBand {
  if (score >= 75) return 'must';
  if (score >= 55) return 'should';
  if (score >= 35) return 'could';
  return 'wont';
}

/**
 * Stage 2's human door: a person asks for something by name (a refactor, a
 * piece of plumbing the generator cannot see).
 *
 * The idea is *not* exempt from the machine gate. It is stored as a draft with
 * a provisional score, and the host specifier still verifies it against the
 * code and re-scores it before a human is asked to swipe — which is how "the
 * human asked for it" and "the human is right about it" stay different claims.
 */
export async function proposeIdea({
  title,
  kind = 'feature',
  rationale = null,
  persona = null,
  by = 'human',
}: ProposeInput): Promise<ProposeResult> {
  const clean = String(title ?? '').trim();
  if (!clean) return { ok: false, reason: 'a title is required' };
  if (clean.length > 160) return { ok: false, reason: 'the title must be 160 characters or fewer' };
  if (!(IDEA_KIND_INPUTS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'kind must be feature, refactor or chore' };
  }

  return withLock(async () => {
    const state = await readIdeaState();
    const fingerprint = `human:${slug(clean)}`;
    const existing = state.ideas.find((i) => i.fingerprint === fingerprint);
    if (existing) {
      // The host's `addMany` silently skips a known fingerprint, so writing a
      // duplicate would look like success while the deck never changed.
      return { ok: false, reason: `this was already proposed as ${existing.id} (${existing.status})` };
    }

    const features: IdeaFeatures = { impact: 32, confidence: 10, effort: 13, risk: 12 };
    const score = features.impact + features.confidence + features.effort + features.risk;
    const at = new Date().toISOString();
    const idea: Idea = {
      id: deriveId('human', clean),
      fingerprint,
      title: clean,
      rationale: rationale && String(rationale).trim() ? String(rationale).trim().slice(0, 1200) : `Proposed by ${by}.`,
      evidence: [`proposed by: ${by}`],
      source: 'human',
      // Canonical on write: the file carries `chore`, never `technical`.
      kind: normalizeKind(kind),
      effortHint: 'medium',
      persona: persona && String(persona).trim() ? String(persona).trim().slice(0, 120) : null,
      features,
      score,
      band: bandFor(score),
      scoreReasons: (Object.keys(RUBRIC_MAX) as (keyof IdeaFeatures)[]).map(
        (axis) => `${axis} ${features[axis]}/${RUBRIC_MAX[axis]}`,
      ),
      status: 'pending',
      stage: 'draft',
      stale: false,
      createdAt: at,
      decidedAt: null,
      triage: null,
      decision: null,
      spec: null,
      verification: null,
      events: [{ at, kind: 'proposed', detail: 'proposed by hand', by }],
    };

    state.ideas.push(idea);
    await writeState(state);
    return { ok: true, idea };
  });
}

/**
 * The timeline: every idea's events, merged and newest first.
 *
 * One source of truth (the per-idea list) instead of a second log that can
 * disagree with it. Rejections keep their comment here, which is what makes
 * "why did we say no to this?" answerable without reading the whole file.
 * Mirrors `IdeaStore.timeline`.
 *
 * `status` filters on the idea's status *now* and `event` on the kind of the
 * row itself. They are different questions and both are needed: "everything we
 * rejected" is an event question, and it must still show a rejection whose idea
 * was later put back on the deck — filtering that by `status` would hide it.
 *
 * `kind` filters on the canonical kind, so the `chore` filter also matches the
 * records still spelled `technical` — otherwise the chip would go empty on the
 * day of the rename while the cards stayed on the deck.
 */
export function timeline(
  ideas: Idea[],
  {
    limit = 200,
    status = null,
    kind = null,
    event = null,
  }: { limit?: number; status?: string | null; kind?: string | null; event?: string | null } = {},
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const idea of ideas) {
    if (status && idea.status !== status) continue;
    if (kind && normalizeKind(idea.kind) !== kind) continue;
    for (const entry of idea.events ?? []) {
      if (event && entry.kind !== event) continue;
      rows.push({
        at: entry.at,
        kind: entry.kind,
        detail: entry.detail ?? null,
        by: entry.by ?? 'system',
        id: idea.id,
        title: idea.title,
        source: idea.source ?? 'unknown',
        ideaStatus: idea.status,
        ideaKind: normalizeKind(idea.kind),
        priority: idea.triage?.priority ?? null,
        comment: entry.kind === 'rejected' ? (idea.decision?.comment ?? null) : null,
      });
    }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return rows.slice(0, Math.max(1, limit));
}

/**
 * Deck order: triage rank ascending, then oldest first so nothing starves.
 *
 * An untriaged card sorts as if the machine had called it `P2`, which is what
 * `triage.mjs::queueOrder` does — the deck's next card must be the host queue's
 * next job, or the operator is deciding in a different order than the work runs.
 * Before triage existed this was score-descending, and for untriaged cards the
 * two are the same ordering (rank = 2000 + (100 - score)).
 *
 * The cards come back with their kind canonicalised, because these are exactly
 * the cards the deck renders: a record still spelled `technical` must reach the
 * UI as a chore, both in the badge and in every kind-conditional panel.
 */
export function deckOrder(ideas: Idea[]): Idea[] {
  const rank = (idea: Idea): number =>
    typeof idea.triage?.rank === 'number' ? idea.triage.rank : rankFor('P2', Number(idea.score) || 0);
  return [...ideas]
    .sort((a, b) => rank(a) - rank(b) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .map((idea) => ({ ...idea, kind: normalizeKind(idea.kind) }));
}

export type ReviewDecision = 'approved' | 'rejected';

/**
 * The second human gate: after the dev agent has delivered and QA has run its
 * UAT, a human approves or rejects the *result* (the demo recording exists to
 * make that a ten-second decision).
 *
 * As with `decideIdea`, this only records the human's word. The host pipeline
 * reads it and decides what that means for the worktree — this route never
 * claims anything was merged, deployed or torn down.
 */
export async function reviewIdea(
  id: string,
  decision: ReviewDecision,
  by = 'session',
  note?: string,
): Promise<Idea | null> {
  return withLock(async () => {
    const state = await readIdeaState();
    const idea = state.ideas.find((i) => i.id === id);
    if (!idea) return null;

    idea.review = { decision, at: new Date().toISOString(), by, note: note ?? null };
    await writeState(state);
    return idea;
  });
}

export function counts(ideas: Idea[]): {
  pending: number;
  ready: number;
  preparing: number;
  accepted: number;
  rejected: number;
  stale: number;
} {
  const pending = ideas.filter((i) => i.status === 'pending');
  return {
    pending: pending.length,
    // Both sides go through the same kind-aware predicate, which is the point:
    // a chore is ready the moment it is proposed (it is never specified) and so
    // can never be counted as "being prepared".
    ready: pending.filter(isSwipeable).length,
    preparing: pending.filter((i) => !isSwipeable(i)).length,
    accepted: ideas.filter((i) => i.status === 'accepted').length,
    rejected: ideas.filter((i) => i.status === 'rejected').length,
    stale: ideas.filter((i) => i.stale).length,
  };
}

/**
 * The host pipeline writes its artefacts (PRD, UAT report, demo recording) into
 * `ops/pipeline/`, mounted read-only here. Reading them is how the product can
 * show what the automation actually produced instead of only its status.
 */
export const PIPELINE_ROOT = process.env.PIPELINE_ROOT ?? '/pipeline';

/** Resolve a repo-relative artefact path inside the mount, or null. */
export function artifactPath(relPath: string): string | null {
  if (!relPath || path.isAbsolute(relPath) || relPath.includes('\0')) return null;
  const normalised = path.normalize(relPath).replace(/^(\.\/)+/, '');
  if (normalised.startsWith('..')) return null;
  const stripped = normalised.replace(/^ops\/pipeline\//, '');
  const full = path.join(PIPELINE_ROOT, stripped);
  if (!full.startsWith(PIPELINE_ROOT)) return null;
  return full;
}

export async function readArtifact(relPath: string): Promise<string | null> {
  const full = artifactPath(relPath);
  if (!full) return null;
  try {
    return await readFile(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Ask the host to run one ideation cycle.
 *
 * The app cannot collect repo signals (it has no checkout and no repo access),
 * so it drops a request file the host service polls. The request is a file for
 * the same reason decisions are: it is the only channel that exists.
 */
export const GENERATE_REQUEST_FILE = process.env.IDEATION_REQUEST_FILE ?? '/data/generate.request';

export async function requestGeneration(requestedBy: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const tmp = `${GENERATE_REQUEST_FILE}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ at: new Date().toISOString(), requestedBy })}\n`, 'utf8');
    await rename(tmp, GENERATE_REQUEST_FILE);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
