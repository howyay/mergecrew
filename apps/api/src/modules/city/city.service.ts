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

const DEFAULT_TIMEOUT_MS = 1_500;
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

  private async read<T>(resource: string): Promise<T> {
    const url = `${this.baseUrl}/v0/city/${encodeURIComponent(this.city)}/${resource}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`city read "${resource}" failed: HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`city read "${resource}" failed: ${message}`);
      throw new Error(
        `Gas City is not reachable at ${this.baseUrl}. Start the supervisor, or set CITY_API_URL. (${message})`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
