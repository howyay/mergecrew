/**
 * Idea store — one JSON file, atomic writes, serialized mutations.
 *
 * Deliberately not a database. The decision log is small (tens of ideas),
 * human-inspected, and must survive `cat`. The one invariant that matters:
 * a fingerprint that a human already decided is never re-proposed, so a swipe
 * "no" is permanent until someone edits the file.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
const emptyState = () => ({ version: 1, updatedAt: null, lastGeneration: null, ideas: [] });

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
        version: parsed.version ?? 1,
        updatedAt: parsed.updatedAt ?? null,
        lastGeneration: parsed.lastGeneration ?? null,
        ideas: Array.isArray(parsed.ideas) ? parsed.ideas : [],
      };
    } catch {
      return emptyState();
    }
  }

  async #write(data) {
    const next = { ...data, updatedAt: new Date().toISOString() };
    await mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, this.#file);
    return next;
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
   */
  async addMany(ideas) {
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
        data.ideas.push({ ...idea, id, fingerprint, stale: false });
        added.push({ ...idea, id, fingerprint });
      }
      const saved = await this.#write(data);
      return { added, skipped, total: saved.ideas.length };
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

  /** decision: 'accepted' | 'rejected' | 'pending' (pending undoes a decision). */
  async decide(id, decision) {
    if (!['accepted', 'rejected', 'pending'].includes(decision)) throw new Error(`bad decision: ${decision}`);
    return this.#withLock(async () => {
      const data = await this.read();
      const idea = data.ideas.find((i) => i.id === id);
      if (!idea) return null;
      idea.status = decision;
      idea.decidedAt = decision === 'pending' ? null : new Date().toISOString();
      await this.#write(data);
      return idea;
    });
  }

  /**
   * Merge an execution patch into an idea. A new attempt starts a new record:
   * callers pass `finishedAt: null` (see `dispatchIdea`) so a previous run's
   * timestamp cannot make the reconciliation of the new attempt look stale.
   */
  async setExecution(id, patch) {
    return this.#withLock(async () => {
      const data = await this.read();
      const idea = data.ideas.find((i) => i.id === id);
      if (!idea) return null;
      idea.execution = { ...(idea.execution ?? {}), ...patch, updatedAt: new Date().toISOString() };
      await this.#write(data);
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
    return this.#withLock(async () => {
      const data = await this.read();
      const idea = data.ideas.find((i) => i.id === id);
      if (!idea) return null;
      idea.pipeline = { ...(idea.pipeline ?? {}), ...patch, updatedAt: new Date().toISOString() };
      await this.#write(data);
      return idea;
    });
  }

  async recordGeneration(meta) {
    return this.#withLock(async () => {
      const data = await this.read();
      data.lastGeneration = { ...meta, at: new Date().toISOString() };
      return this.#write(data);
    });
  }

  async stats() {
    const ideas = await this.list();
    const byStatus = { pending: 0, accepted: 0, rejected: 0 };
    for (const i of ideas) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    const byBand = {};
    for (const i of ideas) byBand[i.band] = (byBand[i.band] ?? 0) + 1;
    const stale = ideas.filter((i) => i.stale).length;
    return { total: ideas.length, byStatus, byBand, stale };
  }
}
