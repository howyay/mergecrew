import {
  CITY_STATUS_SUMMARY_FIELDS,
  CityService,
  projectStatus,
  rigNameForOrg,
  rigRows,
  rigsFromAgents,
  type CityStatus,
} from './city.service.js';
import { CityController } from './city.controller.js';
import type { OrgProjectSource } from './project-source.js';
import type { TenantContextService } from '../../common/tenant-context.service.js';

/**
 * The city module is the product's door to Gas City. These tests cover the tenant
 * rule and the read path, and they run in the repository CI (apps/api `test`).
 */
describe('rigNameForOrg', () => {
  it('keeps the reference rig for the reference organization', () => {
    expect(rigNameForOrg('mergecrew')).toBe('mergecrew');
  });

  it('prefixes every other organization', () => {
    expect(rigNameForOrg('acme')).toBe('mc-acme');
  });

  it('refuses an empty slug', () => {
    expect(() => rigNameForOrg('')).toThrow(/slug is required/);
  });
});

describe('rigsFromAgents', () => {
  it('reads the rig field when the payload has one', () => {
    expect(rigsFromAgents([{ rig: 'mergecrew' }, { rig: 'mc-acme' }, { rig: 'mergecrew' }])).toEqual(['mergecrew', 'mc-acme']);
  });

  it('falls back to the qualified name prefix', () => {
    expect(rigsFromAgents([{ qualified_name: 'mergecrew/gastown.polecat' }, { qualified_name: 'gastown.mayor' }])).toEqual(['mergecrew']);
  });

  it('lets CITY_RIGS win, because a rig with no agent cannot be derived', () => {
    expect(rigsFromAgents([{ rig: 'mergecrew' }], 'mc-acme, mc-other')).toEqual(['mc-acme', 'mc-other']);
  });

  it('tolerates an empty list', () => {
    expect(rigsFromAgents([])).toEqual([]);
  });
});

describe('CityService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('reports a known rig', async () => {
    const service = new CityService();
    jest.spyOn(service, 'agents').mockResolvedValue({ items: [{ qualified_name: 'mergecrew/gastown.polecat' }], total: 1 });
    await expect(service.tenant('mergecrew')).resolves.toEqual({
      organization: 'mergecrew',
      city: 'gascity',
      rig: 'mergecrew',
      known: true,
    });
  });

  it('reports an unknown rig instead of inventing one', async () => {
    const service = new CityService();
    jest.spyOn(service, 'agents').mockResolvedValue({ items: [{ qualified_name: 'mergecrew/gastown.polecat' }], total: 1 });
    const tenant = await service.tenant('acme');
    expect(tenant.rig).toBe('mc-acme');
    expect(tenant.known).toBe(false);
  });

  it('names the address and the fix when the supervisor is unreachable', async () => {
    process.env.CITY_API_URL = 'http://127.0.0.1:9';
    const service = new CityService();
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof fetch;
    await expect(service.status()).rejects.toThrow(/Gas City is not reachable at http:\/\/127\.0\.0\.1:9/);
  });

  it('reads the agent list once for a burst of tenant reads', async () => {
    const service = new CityService();
    const agents = jest.spyOn(service, 'agents').mockResolvedValue({ items: [{ rig: 'mergecrew' }], total: 1 });

    await service.tenant('mergecrew');
    await service.tenant('acme');
    await service.tenant('other');

    expect(agents).toHaveBeenCalledTimes(1);
  });

  it('re-reads the agent list once the cache window has passed', async () => {
    jest.useFakeTimers();
    try {
      const service = new CityService();
      const agents = jest.spyOn(service, 'agents').mockResolvedValue({ items: [{ rig: 'mergecrew' }], total: 1 });

      await service.tenant('mergecrew');
      jest.setSystemTime(Date.now() + 6_000);
      await service.tenant('mergecrew');

      expect(agents).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('honours an explicit cache window when the operator sets one', async () => {
    process.env.CITY_RIGS_CACHE_MS = '0';
    const service = new CityService();
    const agents = jest.spyOn(service, 'agents').mockResolvedValue({ items: [{ rig: 'mergecrew' }], total: 1 });

    await service.tenant('mergecrew');
    await service.tenant('mergecrew');

    expect(agents).toHaveBeenCalledTimes(2);
  });

  it('does not read the city at all when CITY_RIGS names the rigs', async () => {
    process.env.CITY_RIGS = 'mergecrew,mc-acme';
    const service = new CityService();
    const agents = jest.spyOn(service, 'agents');

    await expect(service.tenant('acme')).resolves.toEqual({
      organization: 'acme',
      city: 'gascity',
      rig: 'mc-acme',
      known: true,
    });
    await expect(service.knownRigs()).resolves.toEqual(['mergecrew', 'mc-acme']);
    expect(agents).not.toHaveBeenCalled();
  });
});

/**
 * The supervisor answers with the full status every time — `agent_details` alone was
 * 4,337 of 5,235 bytes on a twenty-agent city — so the product pages ask for the
 * summary view and this projection is what makes that cheap.
 */
describe('projectStatus', () => {
  const full: CityStatus = {
    name: 'gascity',
    version: '1.4.2',
    path: '/home/haoye/gascity',
    uptime_sec: 41_000,
    suspended: false,
    agent_count: 20,
    rig_count: 1,
    beads_version: 'v66',
    running: 4,
    agents: { total: 20, running: 4 },
    agent_details: Array.from({ length: 20 }, (_, index) => ({
      name: `agent-${index}`,
      state: 'stopped',
      provider: 'claude',
      pool: 'default',
      last_active: '2026-10-05T21:00:00Z',
    })),
  };

  it('keeps every field the product pages read', () => {
    const summary = projectStatus(full, 'summary');
    for (const field of CITY_STATUS_SUMMARY_FIELDS) {
      expect(summary[field]).toEqual(full[field]);
    }
  });

  it('drops the detail blocks that dominate the payload', () => {
    const summary = projectStatus(full, 'summary');
    expect(summary).not.toHaveProperty('agent_details');
    expect(summary).not.toHaveProperty('running');
  });

  it('shrinks the payload by more than an order of magnitude', () => {
    const ratio = JSON.stringify(projectStatus(full, 'summary')).length / JSON.stringify(full).length;
    expect(ratio).toBeLessThan(0.1);
  });

  it('returns the payload untouched by default, so existing callers are unaffected', () => {
    expect(projectStatus(full)).toBe(full);
  });
});

describe('CityService status views', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('projects on the summary view and passes the full payload through otherwise', async () => {
    const payload = { name: 'gascity', agent_count: 2, agent_details: [{ name: 'a' }] };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => payload }) as unknown as typeof fetch;

    const service = new CityService();

    await expect(service.status('summary')).resolves.toEqual({ name: 'gascity', agent_count: 2 });
    await expect(service.status()).resolves.toEqual(payload);
  });
});

describe('rigRows', () => {
  it('keeps the fields the binding and the page read', () => {
    expect(
      rigRows([
        {
          name: 'mergecrew',
          path: '/home/me/projects/mergecrew',
          suspended: false,
          default_branch: 'main',
          agent_count: 8,
          running_count: 1,
          last_activity: '2026-10-05T22:40:59Z',
          unrecognized: 'dropped',
        },
      ]),
    ).toEqual([
      {
        name: 'mergecrew',
        path: '/home/me/projects/mergecrew',
        suspended: false,
        default_branch: 'main',
        agent_count: 8,
        running_count: 1,
        last_activity: '2026-10-05T22:40:59Z',
      },
    ]);
  });

  it('fills missing fields with null rather than undefined', () => {
    expect(rigRows([{ name: 'mergecrew' }])).toEqual([
      {
        name: 'mergecrew',
        path: null,
        suspended: null,
        default_branch: null,
        agent_count: null,
        running_count: null,
        last_activity: null,
      },
    ]);
  });

  it('drops a row with no usable name, because it cannot be matched', () => {
    expect(rigRows([{ path: '/x' }, { name: '   ' }, { name: 'keep' }]).map((r) => r.name)).toEqual([
      'keep',
    ]);
  });

  it('tolerates an empty list', () => {
    expect(rigRows([])).toEqual([]);
  });
});

describe('CityService project rigs', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  const rigPayload = {
    items: [{ name: 'mergecrew', path: '/home/me/projects/mergecrew', suspended: false }],
    total: 1,
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => rigPayload }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('binds each project and reports the ones the city does not carry', async () => {
    const service = new CityService({
      listByOrganizationId: async () => [
        { slug: 'mergecrew', name: 'Mergecrew', repoFullName: 'howyay/mergecrew' },
        { slug: 'blank', name: 'Blank' },
      ],
    } as OrgProjectSource);

    const result = await service.projectRigs('org-1');

    expect(result.city).toBe('gascity');
    expect(result.rigs.map((rig) => rig.name)).toEqual(['mergecrew']);
    expect(result.items).toEqual([
      expect.objectContaining({ projectSlug: 'blank', matched: false, rig: null }),
      expect.objectContaining({
        projectSlug: 'mergecrew',
        rig: 'mergecrew',
        rigPath: '/home/me/projects/mergecrew',
        matched: true,
        fix: null,
      }),
    ]);
    expect(result.items[0].fix).toContain('gc rig add');
    expect(result).toMatchObject({ total: 2, unmatched: 1, complete: false });
  });

  it('reads the rig resource once and never the agent list', async () => {
    const service = new CityService({ listByOrganizationId: async () => [] } as OrgProjectSource);
    await service.projectRigs('org-1');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('/v0/city/gascity/rigs');
  });

  it('lets CITY_PROJECT_RIGS pick a rig the derivation cannot guess', async () => {
    process.env.CITY_PROJECT_RIGS = '{"mergecrew":"mc-mergecrew"}';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { name: 'mergecrew', path: '/home/me/projects/mergecrew' },
          { name: 'mc-mergecrew', path: '/srv/mc-mergecrew' },
        ],
      }),
    }) as unknown as typeof fetch;
    const service = new CityService({
      listByOrganizationId: async () => [
        { slug: 'mergecrew', repoFullName: 'howyay/mergecrew' },
      ],
    } as OrgProjectSource);

    const result = await service.projectRigs('org-1');

    expect(result.items[0]).toMatchObject({
      rig: 'mc-mergecrew',
      matched: true,
      reason: 'mapped explicitly to rig "mc-mergecrew"',
    });
  });

  it('still answers about the city when no project source is wired in', async () => {
    const result = await new CityService().projectRigs('org-1');

    expect(result.rigs.map((rig) => rig.name)).toEqual(['mergecrew']);
    expect(result).toMatchObject({ items: [], total: 0, complete: false });
  });

  it('surfaces a city that cannot be read instead of pretending there are no rigs', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    const service = new CityService({ listByOrganizationId: async () => [] } as OrgProjectSource);

    await expect(service.projectRigs('org-1')).rejects.toThrow(/not reachable/);
  });
});

describe('CityController project rigs', () => {
  it('passes the calling organization to the service', async () => {
    const seen: string[] = [];
    const city = {
      projectRigs: async (organizationId: string) => {
        seen.push(organizationId);
        return { city: 'gascity', rigs: [], items: [], total: 0, unmatched: 0, complete: false };
      },
    } as unknown as CityService;
    const tenant = {
      require: () => ({ organizationId: 'org-1', organizationSlug: 'acme' }),
    } as unknown as TenantContextService;

    const controller = new CityController(city, tenant);

    await expect(controller.projects()).resolves.toMatchObject({ city: 'gascity' });
    expect(seen).toEqual(['org-1']);
  });
});
