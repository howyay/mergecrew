import { Injectable, Logger } from '@nestjs/common';

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

@Injectable()
export class CityService {
  private readonly logger = new Logger(CityService.name);
  private readonly baseUrl = (process.env.CITY_API_URL ?? 'http://127.0.0.1:8372').replace(/\/$/, '');
  private readonly city = process.env.GC_CITY ?? 'gascity';
  private readonly timeoutMs = Number(process.env.CITY_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  async status(): Promise<CityStatus> {
    return this.read<CityStatus>('status');
  }

  async agents(): Promise<CityList> {
    return this.read<CityList>('agents');
  }

  async sessions(): Promise<CityList> {
    return this.read<CityList>('sessions');
  }

  /**
   * The tenant rule of ADR-0016 step 6, exposed for the project and org views.
   * `known` says whether the city holds that rig. A mapping to a rig that does not
   * exist is a configuration error, and the caller must see it.
   */
  async tenant(orgSlug: string): Promise<Tenant> {
    const rig = rigNameForOrg(orgSlug);
    const response = await this.agents();
    const rigs = rigsFromAgents((response.items ?? []) as unknown[], process.env.CITY_RIGS);
    return { organization: orgSlug, city: this.city, rig, known: rigs.includes(rig) };
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
