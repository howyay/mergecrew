import {
  CITY_STATUS_SUMMARY_FIELDS,
  CityService,
  projectStatus,
  rigNameForOrg,
  rigsFromAgents,
  type CityStatus,
} from './city.service.js';

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
