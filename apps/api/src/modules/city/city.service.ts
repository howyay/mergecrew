import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  bindProjects,
  parseRigOverrides,
  type CityRig,
  type ProjectRigMap,
} from '@mergecrew/domain';
import { ORG_PROJECT_SOURCE, type OrgProjectSource } from './project-source.js';

/**
 * Reads Gas City state for the product. The supervisor serves a read-only HTTP
 * API on the loopback address; this service is the only place in the API that
 * knows its shape. See ADR-0016 and `ops/gc/city-client.mjs` for the same door
 * outside the API process.
 */
export interface CityStatus {
  name?: string;
  version?: string;
  suspended?: boolean;
  agent_count?: number;
  rig_count?: number;
  [key: string]: unknown;
}

export interface CityList {
  items?: unknown[];
  total?: number;
  [key: string]: unknown;
}

/**
 * The counters the city records for a window. The supervisor's own number is a
 * local estimate, never a provider bill, so every field is passed through with
 * the reason it can be zero: `unpriced` counts invocations it had no price for.
 */
export interface CityUsageWindow {
  invocations: number;
  compute_facts: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  wall_seconds: number;
  cost_usd_estimate: number;
  unpriced: number;
}

export interface CityUsage {
  available: boolean;
  recording: boolean;
  source: string;
  today: CityUsageWindow;
  recent: CityUsageWindow;
  recent_window_secs: number;
  observed_from: string | null;
  updated_at: string | null;
  /**
   * True when at least one invocation in today's window has no price on file, so
   * `cost_usd_estimate` is a floor rather than a bill.
   */
  partial: boolean;
}

const EMPTY_USAGE_WINDOW: CityUsageWindow = {
  invocations: 0,
  compute_facts: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  wall_seconds: 0,
  cost_usd_estimate: 0,
  unpriced: 0,
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function windowOf(raw: unknown): CityUsageWindow {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    invocations: count(record.invocations),
    compute_facts: count(record.compute_facts),
    input_tokens: count(record.input_tokens),
    output_tokens: count(record.output_tokens),
    cache_read_tokens: count(record.cache_read_tokens),
    cache_creation_tokens: count(record.cache_creation_tokens),
    wall_seconds: count(record.wall_seconds),
    cost_usd_estimate: count(record.cost_usd_estimate),
    unpriced: count(record.unpriced),
  };
}

/**
 * Normalizes `/v0/city/<city>/usage`. A payload the supervisor could not fill in
 * turns into zeros, and `partial` carries the honesty flag the cost page needs:
 * an unpriced invocation is a missing price, not a free one.
 */
export function projectUsage(raw: unknown): CityUsage {
  const record = (raw ?? {}) as Record<string, unknown>;
  const today = windowOf(record.today);
  return {
    available: record.available === true,
    recording: record.recording === true,
    source: typeof record.source === 'string' ? record.source : 'unknown',
    today,
    recent: windowOf(record.recent),
    recent_window_secs: count(record.recent_window_secs),
    observed_from: typeof record.observed_from === 'string' ? record.observed_from : null,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : null,
    partial: today.unpriced > 0,
  };
}

export const EMPTY_CITY_USAGE: CityUsage = {
  available: false,
  recording: false,
  source: 'unknown',
  today: EMPTY_USAGE_WINDOW,
  recent: EMPTY_USAGE_WINDOW,
  recent_window_secs: 0,
  observed_from: null,
  updated_at: null,
  partial: false,
};

/**
 * One message the city's agents left for a human. This is the "ask a human"
 * primitive: an agent that needs a decision writes to the `human` mailbox and
 * waits, and a reply joins the same thread so the answer reaches the agent that
 * asked (`gc mail`, `docs/03-infrastructure/08-gas-city-integration.md`).
 */
export interface CityMailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  createdAt: string | null;
  read: boolean;
  threadId: string | null;
  rig: string | null;
}

export interface CityMailbox {
  items: CityMailMessage[];
  total: number;
  /** How many of `items` still want an answer. Counted here, not by the page. */
  unread: number;
}

/** What a mailbox write answers: the id it acted on, and the state it reached. */
export interface CityMailAction {
  id: string;
  status: string;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * One message, normalized from the supervisor's snake_case. A message without an
 * id cannot be answered, so it projects to null and the caller drops it rather
 * than rendering a button that goes nowhere.
 */
export function projectMailMessage(raw: unknown): CityMailMessage | null {
  const record = (raw ?? {}) as Record<string, unknown>;
  const id = textOf(record.id).trim();
  if (!id) return null;
  return {
    id,
    from: textOf(record.from),
    to: textOf(record.to),
    subject: textOf(record.subject),
    body: textOf(record.body),
    createdAt: typeof record.created_at === 'string' ? record.created_at : null,
    read: record.read === true,
    threadId: typeof record.thread_id === 'string' ? record.thread_id : null,
    rig: typeof record.rig === 'string' ? record.rig : null,
  };
}

/**
 * Normalizes `/v0/city/<city>/mail`. The order is the city's own — newest first —
 * and the unread count is the number a person still has to deal with, which is
 * what the Inbox says out loud.
 */
export function projectMail(raw: unknown): CityMailbox {
  const record = (raw ?? {}) as Record<string, unknown>;
  const items = (Array.isArray(record.items) ? record.items : [])
    .map((item) => projectMailMessage(item))
    .filter((item): item is CityMailMessage => item !== null);
  const total = typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : items.length;
  return { items, total, unread: items.filter((item) => !item.read).length };
}

export type StatusView = 'full' | 'summary';

/**
 * The status fields the product reads: `?view=summary` keeps these nine, and the
 * rest of the payload is for a human with a terminal.
 *
 * The supervisor always answers with the full payload, `agent_details` included —
 * 4,337 of 5,235 bytes on a twenty-agent city, and it grows with the agent count.
 * It ignores query parameters, so the projection has to happen here. This is a
 * keep-list rather than a drop-list on purpose: a new supervisor field cannot
 * silently re-inflate the summary.
 */
export const CITY_STATUS_SUMMARY_FIELDS = [
  'name',
  'version',
  'path',
  'uptime_sec',
  'suspended',
  'agent_count',
  'rig_count',
  'beads_version',
  'agents',
] as const;

export function projectStatus(payload: CityStatus, view: StatusView = 'full'): CityStatus {
  if (view !== 'summary') return payload;
  // A record rather than `CityStatus`: writing through a union of literal keys resolves to
  // the intersection of those properties, which for a payload of mixed types is `undefined`.
  const summary: Record<string, unknown> = {};
  for (const field of CITY_STATUS_SUMMARY_FIELDS) {
    if (field in payload) summary[field] = payload[field];
  }
  return summary;
}

/** The reference organization keeps the existing rig. Every other org is prefixed. */
export const REFERENCE_ORG_SLUG = 'mergecrew';

export function rigNameForOrg(slug: string, referenceRig = REFERENCE_ORG_SLUG): string {
  const clean = String(slug ?? '').trim();
  if (!clean) throw new Error('rigNameForOrg: slug is required');
  return clean === REFERENCE_ORG_SLUG ? referenceRig : `mc-${clean}`;
}

export interface Tenant {
  organization: string;
  city: string;
  rig: string;
  known: boolean;
}

/**
 * The rigs the city holds. `CITY_RIGS` wins when it is set, because a rig with no
 * agent cannot be derived from the agent list. Otherwise the rig is the part of an
 * agent's qualified name before the slash.
 */
export function rigsFromAgents(items: unknown[], configured?: string): string[] {
  const fromEnv = String(configured ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (fromEnv.length) return [...new Set(fromEnv)];
  const names = new Set<string>();
  for (const item of items ?? []) {
    const record = item as { rig?: unknown; qualified_name?: unknown; name?: unknown };
    if (typeof record?.rig === 'string' && record.rig) {
      names.add(record.rig);
      continue;
    }
    const qualified = typeof record?.qualified_name === 'string' ? record.qualified_name : '';
    const prefix = qualified.includes('/') ? qualified.split('/')[0] : '';
    if (prefix) names.add(prefix);
  }
  return [...names];
}

/**
 * A city read can be slow without being broken: the supervisor sweeps every agent
 * and every session before it answers, and a loaded host pushes that past a second.
 * At 1.5s a busy city read as unreachable and the Gas City screens filled with
 * failure cards, so the budget has to cover a real sweep.
 */
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RIG_CACHE_MS = 5_000;

/** The rigs of one city, plus every project of the organization bound to one. */
export interface CityProjectRigs extends ProjectRigMap {
  city: string;
  rigs: CityRig[];
}

/**
 * The supervisor's rig rows, normalized. A rig without a name cannot be matched
 * against a project, so it is dropped rather than surfaced as an unknown.
 */
export function rigRows(items: unknown[]): CityRig[] {
  const out: CityRig[] = [];
  for (const item of items ?? []) {
    const record = item as Record<string, unknown>;
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    out.push({
      name,
      path: typeof record.path === 'string' ? record.path : null,
      suspended: typeof record.suspended === 'boolean' ? record.suspended : null,
      default_branch: typeof record.default_branch === 'string' ? record.default_branch : null,
      agent_count: typeof record.agent_count === 'number' ? record.agent_count : null,
      running_count: typeof record.running_count === 'number' ? record.running_count : null,
      last_activity: typeof record.last_activity === 'string' ? record.last_activity : null,
    });
  }
  return out;
}

/**
 * The supervisor explains a refusal in the body — `{"detail":"csrf: X-GC-Request
 * header required…"}`, or the bridge's "the mailbox stays closed". Keep the reason
 * and cap it: an error log wants the sentence, not the payload.
 */
async function detailOf(response: { text(): Promise<string> }): Promise<string> {
  try {
    const body = (await response.text()).trim().replace(/\s+/g, ' ');
    return body ? ` — ${body.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

/**
 * An answer, as opposed to silence. The difference decides what the operator is
 * told: a 403 from the bridge is a token to set, and answering "Gas City is not
 * reachable" would send them to restart a supervisor that is running fine.
 */
class CityAnswerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Statuses that mean nobody was there to answer: the bridge could not reach it. */
const UNREACHABLE_STATUSES = new Set([502, 503, 504]);

@Injectable()
export class CityService {
  private readonly logger = new Logger(CityService.name);
  private readonly baseUrl = (process.env.CITY_API_URL ?? 'http://127.0.0.1:8372').replace(/\/$/, '');
  private readonly city = process.env.GC_CITY ?? 'gascity';
  private readonly timeoutMs = Number(process.env.CITY_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  /** See `knownRigs()`. `null` means nothing has been read yet. */
  private rigCache: { at: number; rigs: string[] } | null = null;
  private readonly rigCacheMs = Number(process.env.CITY_RIGS_CACHE_MS ?? DEFAULT_RIG_CACHE_MS);
  /**
   * The secret the bridge wants before it will carry anything from the mailbox.
   * Empty is a working configuration, not a broken one: the bridge answers 403 and
   * the Inbox says the mailbox could not be read.
   */
  private readonly bridgeToken = String(process.env.CITY_BRIDGE_TOKEN ?? '').trim();

  /**
   * `orgProjects` is optional so the rig binding degrades to "no projects" rather
   * than failing a city read when the product database is not wired in.
   */
  constructor(
    @Optional()
    @Inject(ORG_PROJECT_SOURCE)
    private readonly orgProjects?: OrgProjectSource,
  ) {}

  async status(view: StatusView = 'full'): Promise<CityStatus> {
    return projectStatus(await this.read<CityStatus>('status'), view);
  }

  async agents(): Promise<CityList> {
    return this.read<CityList>('agents');
  }

  async sessions(): Promise<CityList> {
    return this.read<CityList>('sessions');
  }

  /**
   * The rig names the city holds.
   *
   * A tenant read used to fetch the agent list every time it ran, so a page that
   * resolves several organizations paid one agent read per organization. Two rules
   * remove that: with `CITY_RIGS` set the operator has already named the rigs, so no
   * read happens at all; otherwise the read is cached for `CITY_RIGS_CACHE_MS` (five
   * seconds by default), which collapses a burst of tenant reads into one.
   */
  async knownRigs(): Promise<string[]> {
    const configured = String(process.env.CITY_RIGS ?? '').trim();
    if (configured) return rigsFromAgents([], configured);

    const now = Date.now();
    if (this.rigCache && now - this.rigCache.at < this.rigCacheMs) return this.rigCache.rigs;

    const response = await this.agents();
    const rigs = rigsFromAgents((response.items ?? []) as unknown[], configured);
    this.rigCache = { at: now, rigs };
    return rigs;
  }

  /**
   * The tenant rule of ADR-0016 step 6, exposed for the project and org views.
   * `known` says whether the city holds that rig. A mapping to a rig that does not
   * exist is a configuration error, and the caller must see it.
   */
  async tenant(orgSlug: string): Promise<Tenant> {
    const rig = rigNameForOrg(orgSlug);
    const rigs = await this.knownRigs();
    return { organization: orgSlug, city: this.city, rig, known: rigs.includes(rig) };
  }

  /** The rigs the city holds, with the directories they point at. */
  async rigs(): Promise<CityRig[]> {
    const response = await this.read<CityList>('rigs');
    return rigRows((response.items ?? []) as unknown[]);
  }

  /**
   * Every project of the organization, each bound to the rig that carries it
   * (ADR-0016 step 6).
   *
   * The city read and the project read run together, and an unmapped project
   * comes back with the reason plus the command that fixes it rather than being
   * dropped — a project the city does not carry is a configuration error the
   * operator has to see. `CITY_PROJECT_RIGS` overrides the derivation.
   */
  async projectRigs(organizationId: string): Promise<CityProjectRigs> {
    const [rigs, projects] = await Promise.all([
      this.rigs(),
      this.orgProjects ? this.orgProjects.listByOrganizationId(organizationId) : Promise.resolve([]),
    ]);
    const map = bindProjects(projects, rigs, parseRigOverrides(process.env.CITY_PROJECT_RIGS));
    return { city: this.city, rigs, ...map };
  }

  /**
   * What the city recorded today, and in the last few minutes.
   *
   * The supervisor's counters are a local estimate: it knows the tokens and wall
   * time it observed, and it cannot know what the provider will charge. So the
   * cost figure is reported next to `unpriced` and `partial` instead of being
   * dressed up as a bill.
   */
  async usage(): Promise<CityUsage> {
    return projectUsage(await this.read<unknown>('usage'));
  }

  /**
   * What the city's agents asked a human, newest first.
   *
   * The only read that carries the bridge token: the bridge binds the host's
   * LAN address, and a mailbox is correspondence rather than a counter.
   */
  async mail(): Promise<CityMailbox> {
    return projectMail(await this.read<unknown>('mail', { headers: this.mailboxHeaders() }));
  }

  /**
   * Answer a message. The reply joins the message's thread, which is what makes
   * the answer reach the agent that stopped to ask.
   *
   * Returns the message the supervisor created, or null when it answered without
   * naming one — the reply has landed either way, so a missing echo is not an error.
   */
  async replyToMail(messageId: string, body: string): Promise<CityMailMessage | null> {
    const id = encodeURIComponent(messageId);
    const created = await this.write<unknown>(`mail/${id}/reply`, { body });
    // Answering is answering: an unread flag left behind would keep asking a person
    // who has already replied. Best-effort, because the reply itself has landed.
    await this.write(`mail/${id}/read`, {}).catch((error: unknown) => {
      this.logger.warn(
        `city mail "${messageId}" was replied to but not marked read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return projectMailMessage(created);
  }

  /** Mark one message read without answering it. */
  async markMailRead(messageId: string): Promise<CityMailAction> {
    return this.mailAction(messageId, 'read');
  }

  /** Put a message back in the unread pile. */
  async markMailUnread(messageId: string): Promise<CityMailAction> {
    return this.mailAction(messageId, 'mark-unread');
  }

  /**
   * Put a message away. The supervisor drops an archived message from the mailbox
   * read, and offers no way back — so the Inbox's archive button is the only one
   * that asks before it writes.
   */
  async archiveMail(messageId: string): Promise<CityMailAction> {
    return this.mailAction(messageId, 'archive');
  }

  private async mailAction(messageId: string, action: string): Promise<CityMailAction> {
    const answer = await this.write<unknown>(`mail/${encodeURIComponent(messageId)}/${action}`, {});
    const record = (answer ?? {}) as Record<string, unknown>;
    return { id: messageId, status: typeof record.status === 'string' ? record.status : action };
  }

  private mailboxHeaders(): Record<string, string> {
    return this.bridgeToken ? { 'x-city-bridge-token': this.bridgeToken } : {};
  }

  /**
   * The mailbox writes. One attempt, never a retry: a mutation repeated answers
   * twice, and a reply sent twice is a second message in somebody's thread.
   */
  private async write<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}/v0/city/${encodeURIComponent(this.city)}/${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          // The supervisor refuses every mutation without it.
          'x-gc-request': 'mergecrew-inbox',
          ...this.mailboxHeaders(),
        },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${await detailOf(response)}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const why = controller.signal.aborted
        ? `it did not answer within ${this.timeoutMs}ms, so the write may or may not have landed`
        : message;
      throw new Error(`city write "${path}" did not complete at ${this.baseUrl}: ${why}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async read<T>(resource: string, init: { headers?: Record<string, string> } = {}): Promise<T> {
    const url = `${this.baseUrl}/v0/city/${encodeURIComponent(this.city)}/${resource}`;
    // Two attempts, and only a *timeout* is repeated: a refused connection or an
    // HTTP status is the city answering, and asking again would only make the
    // operator wait for the same verdict.
    const attempts = 2;
    let message = 'the city did not answer';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: init.headers });
        if (!response.ok) {
          throw new CityAnswerError(
            response.status,
            `city read "${resource}" failed: HTTP ${response.status}${await detailOf(response)}`,
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        // An HTTP status is the city answering, so it is reported as one instead of
        // being retried into the "not reachable" message.
        if (error instanceof CityAnswerError && !UNREACHABLE_STATUSES.has(error.status)) {
          this.logger.warn(`city read "${resource}" refused: HTTP ${error.status}`);
          throw new Error(`Gas City refused the read at ${this.baseUrl}: ${error.message}`);
        }
        message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`city read "${resource}" failed (attempt ${attempt} of ${attempts}): ${message}`);
        if (!controller.signal.aborted) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(
      `Gas City is not reachable at ${this.baseUrl}. Start the supervisor, or set CITY_API_URL. (${message})`,
    );
  }
}
