/**
 * Idea store — one JSON file, atomic writes, serialized mutations.
 *
 * Deliberately not a database. The decision log is small (tens of ideas),
 * human-inspected, and must survive `cat`. The invariants that matter:
 *
 *   - a fingerprint a human already decided is never re-proposed, so a swipe
 *     "no" is permanent until someone edits the file;
 *   - every idea carries an append-only `events` list, because "we accepted
 *     this" and "we rejected this with a reason" are decisions a team has to be
 *     able to read back months later (the timeline view renders exactly this);
 *   - the deck only shows ideas that have been *specified*: an idea is a
 *     question until the specifier has generalised it, checked it against the
 *     code and scored it.
 *
 * Two writers share this file: this service and the mergecrew web app (which
 * renders the deck inside the product). Both read-modify-write the whole file
 * under a short lock, and both append their own events — the file is the
 * integration point, not an internal detail of either side.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATE_VERSION = 2;

/** Per-idea event log cap. History matters; unbounded growth does not. */
export const MAX_EVENTS = 200;

/**
 * Every stored idea needs a stable id: it is the handle the pipeline, the web
 * API and the operator all use. Deriving it here (rather than trusting callers)
 * means an idea that reaches the store is never an orphan that cannot be
 * decided, dispatched or reviewed.
 */
const deriveId = (source, title) =>
  `idea-${createHash('sha1').update(`${source}:${title}`).digest('hex').slice(0, 8)}`;

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/**
 * A FRESH empty state per call. A shared frozen template spread into the
 * return value would hand every caller the same mutable `ideas` array, and
 * one store's pushes would appear inside another store's file.
 */
const emptyState = () => ({ version: STATE_VERSION, updatedAt: null, lastGeneration: null, ideas: [] });

/**
 * What an idea is *for*, when the record does not say.
 *
 * The deck split product features from engineering chores, so a record from
 * before that split has to be classified rather than defaulted: reading a
 * "clean up 10 TODO markers" card as a user-facing feature would put it on the
 * swipe deck as something to ship.
 */
const CHORE_SOURCES = new Set([
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
  return CHORE_SOURCES.has(source) ? 'technical' : 'feature';
}

/**
 * Bring a stored idea up to the current shape, in memory, on read.
 *
 * State files outlive the code that wrote them: the live deck was recording
 * `{source, score, status}` while the deck gained `kind`, `stage` and a
 * timeline. Without this, every pre-existing card reads as `stage: undefined`,
 * the specifier only picks up `stage === 'draft'`, and the swipe deck looks
 * broken while the file is fine. Reading is not writing — the file keeps its
 * old shape until something actually mutates it.
 */
export function normalizeIdea(idea) {
  if (!idea || typeof idea !== 'object') return idea;
  const out = { ...idea };
  out.kind = out.kind ?? kindForSource(out.source);
  out.stage = out.stage ?? 'draft';
  out.stale = out.stale ?? false;
  out.events = Array.isArray(out.events) ? out.events : [];
  if (!out.events.length) {
    out.events.push({
      at: out.createdAt ?? new Date().toISOString(),
      kind: 'proposed',
      detail: out.source === 'human' ? 'proposed by hand' : `proposed by ${out.source ?? 'unknown'}`,
      by: out.proposedBy ?? (out.source === 'human' ? 'human' : 'generator'),
    });
  }
  return out;
}

/**
 * Append one event to an idea's timeline.
 *
 * `kind` is the machine-readable verb the timeline view groups by
 * (proposed | specified | scored | accepted | rejected | retriaged |
 * dispatched | dev-started | dev-done | qa | delivered | approved | rework …).
 * `detail` is the human sentence, and for a rejection it is the reviewer's own
 * words — that is the whole point of allowing a comment.
 */
export function appendEvent(idea, { kind, detail = null, by = 'system', at = new Date().toISOString() }) {
  if (!idea || !kind) return null;
  idea.events = Array.isArray(idea.events) ? idea.events : [];
  const event = { at, kind, detail, by };
  idea.events.push(event);
  if (idea.events.length > MAX_EVENTS) idea.events.splice(0, idea.events.length - MAX_EVENTS);
  return event;
}

export class IdeaStore {
  #file;
  #lock = Promise.resolve();

  constructor(file) {
    // Every write goes through this path. An options object (`new IdeaStore({file})`)
    // used to be accepted silently: read() swallowed the resulting TypeError,
    // returned an empty deck, and setPipeline() then found no such idea and wrote
    // nothing — a caller that reported success while the file never changed
    // (hit 2026-10-03 from an operator script). Fail at construction instead.
    if (typeof file !== 'string' || !file) {
      throw new TypeError(`IdeaStore needs a state file path (got ${typeof file})`);
    }
    this.#file = file;
  }

  get file() {
    return this.#file;
  }

  /** Serialize every mutation: the server and the timer can race. */
  #withLock(fn) {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8'));
      return {
        version: parsed.version ?? STATE_VERSION,
        updatedAt: parsed.updatedAt ?? null,
        lastGeneration: parsed.lastGeneration ?? null,
        ideas: Array.isArray(parsed.ideas) ? parsed.ideas.map(normalizeIdea) : [],
      };
    } catch {
      return emptyState();
    }
  }

  async #write(data) {
    const next = { ...data, version: STATE_VERSION, updatedAt: new Date().toISOString() };
    await mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, this.#file);
    return next;
  }

  /** Read-modify-write one idea under the lock. Returns the idea, or null. */
  #mutate(id, fn) {
    return this.#withLock(async () => {
      const data = await this.read();
      const idea = data.ideas.find((i) => i.id === id);
      if (!idea) return null;
      const result = fn(idea, data);
      await this.#write(data);
      return result === undefined ? idea : result;
    });
  }

  async list() {
    return (await this.read()).ideas;
  }

  async get(id) {
    return (await this.read()).ideas.find((i) => i.id === id) ?? null;
  }

  /**
   * Insert ideas, skipping any fingerprint already present in any status.
   * Returns `{added, skipped}` so the caller can report real numbers.
   *
   * Every inserted idea starts as a *draft*: generation says "this might be
   * worth doing", the specifier (a separate, slower stage) is what turns it
   * into something a human can judge.
   */
  async addMany(ideas, { by = 'generator' } = {}) {
    return this.#withLock(async () => {
      const data = await this.read();
      const known = new Set(data.ideas.map((i) => i.fingerprint));
      const added = [];
      const skipped = [];
      for (const idea of ideas) {
        // A missing fingerprint must not silently collapse every such idea into
        // the first one: derive one from what the idea *is*.
        const fingerprint = idea.fingerprint ?? `${idea.source ?? 'unknown'}:${slug(idea.title)}`;
        if (known.has(fingerprint)) {
          skipped.push(fingerprint);
          continue;
        }
        known.add(fingerprint);
        const id = idea.id ?? deriveId(idea.source ?? 'unknown', idea.title ?? '');
        const record = {
          ...idea,
          id,
          fingerprint,
          // Defaults go *after* the spread: a caller that passes an explicit
          // `kind: undefined` (easy to do when mapping over parsed rows) must
          // not erase the default and hand the deck a card with no kind.
          kind: idea.kind ?? 'feature',
          stage: idea.stage ?? 'draft',
          stale: false,
          events: Array.isArray(idea.events) ? idea.events : [],
        };
        if (!record.events.length) {
          appendEvent(record, {
            kind: 'proposed',
            by: idea.source === 'human' ? idea.proposedBy ?? 'human' : by,
            detail:
              idea.source === 'human'
                ? `proposed by hand${idea.persona ? ` for ${idea.persona}` : ''}`
                : `proposed by ${idea.source}`,
          });
        }
        data.ideas.push(record);
        added.push(record);
      }
      const saved = await this.#write(data);
      return { added, skipped, total: saved.ideas.length };
    });
  }

  /**
   * Write the specifier's output. This is the transition that makes an idea
   * swipable: generalisation + spec + verification + score, all produced from
   * the code as it is, not from the idea's one-line rationale.
   */
  async setSpecification(id, { spec, verification, features, score, band, scoreReasons, by = 'specifier' }) {
    return this.#mutate(id, (idea) => {
      idea.spec = spec;
      idea.verification = verification ?? idea.verification ?? null;
      if (features) idea.features = features;
      if (typeof score === 'number') idea.score = score;
      if (band) idea.band = band;
      if (Array.isArray(scoreReasons)) idea.scoreReasons = scoreReasons;
      if (spec?.kind) idea.kind = spec.kind;
      idea.stage = 'specified';
      idea.specFailedReason = null;
      appendEvent(idea, {
        kind: 'specified',
        by,
        detail: `${spec?.summary ? `${String(spec.summary).slice(0, 140)} — ` : ''}score ${idea.score} (${idea.band})`,
      });
      return idea;
    });
  }

  /** Record that the specifier could not produce a spec, and why. */
  async setSpecFailure(id, reason, { by = 'specifier' } = {}) {
    return this.#mutate(id, (idea) => {
      idea.stage = 'spec-failed';
      idea.specFailedReason = String(reason ?? 'unknown');
      appendEvent(idea, { kind: 'spec-failed', by, detail: String(reason ?? 'unknown').slice(0, 300) });
      return idea;
    });
  }

  /** Mark a draft as being specified right now (so the deck can say so). */
  async setStage(id, stage, patch = {}) {
    return this.#mutate(id, (idea) => {
      idea.stage = stage;
      Object.assign(idea, patch);
      return idea;
    });
  }

  /** Automatic triage result, or a human override of it. */
  async setTriage(id, triage) {
    return this.#mutate(id, (idea) => {
      idea.triage = { ...(idea.triage ?? {}), ...triage };
      return idea;
    });
  }

  /**
   * Record the human's verdict at the first gate.
   *
   * `decision: 'rejected'` may carry a comment. The comment is not decoration:
   * it is shown on the timeline, it travels with the idea forever, and the
   * generator receives recent rejection comments as steering so the next round
   * of proposals answers the objection instead of repeating it.
   */
  async decide(id, decision, { comment = null, by = 'human', at = new Date().toISOString() } = {}) {
    if (!['accepted', 'rejected', 'pending'].includes(decision)) throw new Error(`bad decision: ${decision}`);
    return this.#mutate(id, (idea) => {
      const note = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 2000) : null;
      idea.status = decision;
      idea.decidedAt = decision === 'pending' ? null : at;
      idea.decision =
        decision === 'pending'
          ? null
          : { at, by, comment: note, commented: Boolean(note) };
      appendEvent(idea, {
        kind: decision === 'pending' ? 'decision-undone' : decision,
        by,
        // The rejection comment belongs in the event itself: the timeline reads
        // events, and a verdict whose reason lives somewhere else is a verdict
        // nobody can act on later.
        detail:
          note ??
          (decision === 'accepted'
            ? 'accepted at the swipe gate'
            : decision === 'rejected'
              ? 'rejected without a comment'
              : 'decision undone'),
      });
      return idea;
    });
  }

  /**
   * Merge an execution patch into an idea. A new attempt starts a new record:
   * callers pass `finishedAt: null` (see `dispatchIdea`) so a previous run's
   * timestamp cannot make the reconciliation of the new attempt look stale.
   */
  async setExecution(id, patch) {
    return this.#mutate(id, (idea) => {
      idea.execution = { ...(idea.execution ?? {}), ...patch, updatedAt: new Date().toISOString() };
      return idea;
    });
  }

  /**
   * Merge a pipeline patch into an idea (PRD, issue, worktree, dev agent, QA).
   *
   * The pipeline is a separate process from this service — and the web app
   * renders whatever lands here, so this field is the observability contract
   * between the three: it must stay JSON-serialisable and small.
   */
  async setPipeline(id, patch) {
    return this.#mutate(id, (idea) => {
      idea.pipeline = { ...(idea.pipeline ?? {}), ...patch, updatedAt: new Date().toISOString() };
      return idea;
    });
  }

  /** Append an event without changing anything else (used by the pipeline). */
  async recordEvent(id, event) {
    return this.#mutate(id, (idea) => appendEvent(idea, event));
  }

  async recordGeneration(meta) {
    return this.#withLock(async () => {
      const data = await this.read();
      data.lastGeneration = { ...meta, at: new Date().toISOString() };
      return this.#write(data);
    });
  }

  /**
   * Mark pending ideas whose fingerprint is not in `fresh` as stale. Ideas the
   * current signals no longer support must say so instead of keeping a claim
   * that has quietly stopped being true (for example "add tests to ops/ci"
   * after ops/ci gained a test suite).
   */
  async markStaleness(fresh) {
    const keep = fresh instanceof Set ? fresh : new Set(fresh);
    return this.#withLock(async () => {
      const data = await this.read();
      let marked = 0;
      let cleared = 0;
      for (const idea of data.ideas) {
        if (idea.status !== 'pending') continue; // a decided card keeps its history
        const stale = !keep.has(idea.fingerprint);
        if (stale && !idea.stale) marked++;
        if (!stale && idea.stale) cleared++;
        idea.stale = stale;
      }
      await this.#write(data);
      return { marked, cleared };
    });
  }

  /**
   * The timeline: every idea's events, merged and newest first.
   *
   * One source of truth (the per-idea list) instead of a second log that can
   * disagree with it. Rejections keep their comment here, which is what makes
   * "why did we say no to this?" answerable without reading the whole file.
   */
  async timeline({ limit = 200, status = null, kind = null, id = null } = {}) {
    const ideas = await this.list();
    const rows = [];
    for (const idea of ideas) {
      if (id && idea.id !== id) continue;
      if (status && idea.status !== status) continue;
      if (kind && idea.kind !== kind) continue;
      for (const event of idea.events ?? []) {
        rows.push({
          at: event.at,
          kind: event.kind,
          detail: event.detail ?? null,
          by: event.by ?? 'system',
          id: idea.id,
          title: idea.title,
          source: idea.source,
          ideaStatus: idea.status,
          ideaKind: idea.kind ?? 'feature',
          priority: idea.triage?.priority ?? null,
          comment: event.kind === 'rejected' ? (idea.decision?.comment ?? null) : null,
        });
      }
    }
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return rows.slice(0, Math.max(1, limit));
  }

  async stats() {
    const ideas = await this.list();
    const byStatus = { pending: 0, accepted: 0, rejected: 0 };
    for (const i of ideas) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    const byBand = {};
    for (const i of ideas) byBand[i.band] = (byBand[i.band] ?? 0) + 1;
    const byStage = {};
    for (const i of ideas) byStage[i.stage ?? 'draft'] = (byStage[i.stage ?? 'draft'] ?? 0) + 1;
    const byKind = { feature: 0, technical: 0 };
    for (const i of ideas) byKind[i.kind ?? 'feature'] = (byKind[i.kind ?? 'feature'] ?? 0) + 1;
    const byPriority = {};
    for (const i of ideas) {
      const p = i.triage?.priority ?? 'untriaged';
      byPriority[p] = (byPriority[p] ?? 0) + 1;
    }
    const stale = ideas.filter((i) => i.stale).length;
    // The deck is a queue with three lengths the reader has to be able to tell
    // apart: not yet specified (no human should see it), waiting for a swipe,
    // and decided.
    const swipable = ideas.filter((i) => i.stage === 'specified' && i.status === 'pending' && !i.stale).length;
    const preparing = ideas.filter((i) => i.stage !== 'specified' && i.status === 'pending').length;
    const rejectedWithComment = ideas.filter((i) => i.status === 'rejected' && i.decision?.comment).length;
    return {
      total: ideas.length,
      byStatus,
      byBand,
      byStage,
      byKind,
      byPriority,
      stale,
      swipable,
      preparing,
      rejectedWithComment,
    };
  }
}
