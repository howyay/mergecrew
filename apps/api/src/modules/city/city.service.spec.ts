import {
  CITY_STATUS_SUMMARY_FIELDS,
  CityService,
  EMPTY_CITY_USAGE,
  projectMail,
  projectMailMessage,
  projectStatus,
  projectUsage,
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
    const fetchMock = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(service.status()).rejects.toThrow(/Gas City is not reachable at http:\/\/127\.0\.0\.1:9/);
    // A refused connection is an answer: it must not be retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives a slow city a second chance instead of calling it unreachable', async () => {
    process.env.CITY_API_URL = 'http://127.0.0.1:8372';
    process.env.CITY_API_TIMEOUT_MS = '25';
    const service = new CityService();
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
          }),
      )
      .mockResolvedValue({ ok: true, json: async () => ({ name: 'gascity', agent_count: 3 }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const status = await service.status();

    expect(status.name).toBe('gascity');
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    const [blank, mapped] = result.items;

    expect(result.city).toBe('gascity');
    expect(result.rigs.map((rig) => rig.name)).toEqual(['mergecrew']);
    expect(blank).toMatchObject({ projectSlug: 'blank', matched: false, rig: null });
    expect(blank?.fix).toContain('gc rig add');
    expect(mapped).toMatchObject({
      projectSlug: 'mergecrew',
      rig: 'mergecrew',
      rigPath: '/home/me/projects/mergecrew',
      matched: true,
      fix: null,
    });
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

describe('CityController tenant mapping', () => {
  // A city that does not hold the derived rig is the normal state of an
  // organization whose rig has not been created yet. The route reports it —
  // the page renders "unknown rig" beside the fix — instead of answering 404,
  // which is what hid the answer this read exists to give.
  const controllerFor = (tenant: (slug: string) => Promise<{ organization: string; city: string; rig: string; known: boolean }>) =>
    new CityController(
      { tenant } as unknown as CityService,
      {} as unknown as TenantContextService,
    );

  it('reports a missing rig as a value with known=false', async () => {
    const controller = controllerFor(async (slug) => ({
      organization: slug,
      city: 'gascity',
      rig: `mc-${slug}`,
      known: false,
    }));

    await expect(controller.tenant('acme')).resolves.toEqual({
      organization: 'acme',
      city: 'gascity',
      rig: 'mc-acme',
      known: false,
    });
  });

  it('reports a rig the city holds as mapped', async () => {
    const controller = controllerFor(async (slug) => ({
      organization: slug,
      city: 'gascity',
      rig: 'mergecrew',
      known: true,
    }));

    await expect(controller.tenant('mergecrew')).resolves.toMatchObject({ rig: 'mergecrew', known: true });
  });
});

describe('projectUsage', () => {
  // The shape the supervisor answered on 2026-10-05: 45 invocations, none of
  // them priced, so the estimate is 0 for a reason.
  const live = {
    available: true,
    recording: true,
    source: 'local_estimate',
    today: {
      invocations: 45,
      compute_facts: 22,
      input_tokens: 1_500_725,
      output_tokens: 10_223,
      cache_read_tokens: 1_336_832,
      cache_creation_tokens: 0,
      wall_seconds: 6_355.41,
      cost_usd_estimate: 0,
      unpriced: 45,
    },
    recent: { invocations: 0, wall_seconds: 0, cost_usd_estimate: 0, unpriced: 0 },
    recent_window_secs: 300,
    observed_from: '2026-10-05T01:53:17.391Z',
    updated_at: '2026-10-05T23:53:50.133257401Z',
  };

  it('carries the counters through and flags a partial estimate', () => {
    const usage = projectUsage(live);

    expect(usage.today).toEqual({
      invocations: 45,
      compute_facts: 22,
      input_tokens: 1_500_725,
      output_tokens: 10_223,
      cache_read_tokens: 1_336_832,
      cache_creation_tokens: 0,
      wall_seconds: 6_355.41,
      cost_usd_estimate: 0,
      unpriced: 45,
    });
    expect(usage).toMatchObject({
      available: true,
      recording: true,
      source: 'local_estimate',
      recent_window_secs: 300,
      partial: true,
    });
    expect(usage.observed_from).toBe('2026-10-05T01:53:17.391Z');
  });

  it('is not partial when every invocation has a price', () => {
    const usage = projectUsage({ ...live, today: { ...live.today, unpriced: 0 } });
    expect(usage.partial).toBe(false);
  });

  it('turns a payload the supervisor could not fill in into zeros', () => {
    const usage = projectUsage({ available: false, recording: false });

    expect(usage).toMatchObject({ available: false, recording: false, source: 'unknown', partial: false });
    expect(usage.today.invocations).toBe(0);
    expect(usage.recent.wall_seconds).toBe(0);
    expect(usage.observed_from).toBeNull();
    expect(usage.updated_at).toBeNull();
  });

  it('ignores a malformed counter instead of rendering NaN', () => {
    const usage = projectUsage({ available: true, today: { invocations: 'lots', wall_seconds: null } });
    expect(usage.today.invocations).toBe(0);
    expect(usage.today.wall_seconds).toBe(0);
  });

  it('answers with the empty projection when there is nothing at all', () => {
    expect(projectUsage(undefined)).toEqual(EMPTY_CITY_USAGE);
  });
});

describe('CityService usage', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads the usage resource and normalizes it', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        available: true,
        recording: true,
        source: 'local_estimate',
        today: { invocations: 2, unpriced: 2 },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const usage = await new CityService().usage();

    expect(String(fetchMock.mock.calls[0][0])).toContain('/v0/city/gascity/usage');
    expect(usage.today.invocations).toBe(2);
    expect(usage.partial).toBe(true);
  });

  it('surfaces an unreachable supervisor instead of reporting zero usage', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch;

    await expect(new CityService().usage()).rejects.toThrow(/not reachable/);
  });
});

describe('CityController usage', () => {
  it('answers with what the service reports', async () => {
    const city = {
      usage: async () => ({ ...EMPTY_CITY_USAGE, available: true, recording: true }),
    } as unknown as CityService;

    const controller = new CityController(city, {} as unknown as TenantContextService);

    await expect(controller.usage()).resolves.toMatchObject({ available: true, recording: true });
  });
});

describe('projectMail', () => {
  // The shape the supervisor answered on 2026-10-06, trimmed to two messages.
  const live = {
    items: [
      {
        id: 'gc-881',
        from: '',
        to: 'human',
        subject: 'Re: Dolt health advisory [MEDIUM]',
        body: 'MergeCrew probe: reply contract',
        created_at: '2026-10-06T02:05:11Z',
        read: true,
        thread_id: 'thread-1',
        rig: 'mergecrew',
      },
      {
        id: 'gc-844',
        from: 'human',
        to: 'human',
        subject: 'Dolt backup: 1/2 databases failed to sync [MEDIUM]',
        body: 'Operator review required before forcing cleanup',
        created_at: '2026-10-06T01:28:00Z',
        read: false,
      },
    ],
    total: 2,
  };

  it('normalizes the messages the city asks a human about', () => {
    const box = projectMail(live);

    expect(box.total).toBe(2);
    expect(box.unread).toBe(1);
    expect(box.items[0]).toEqual({
      id: 'gc-881',
      from: '',
      to: 'human',
      subject: 'Re: Dolt health advisory [MEDIUM]',
      body: 'MergeCrew probe: reply contract',
      createdAt: '2026-10-06T02:05:11Z',
      read: true,
      threadId: 'thread-1',
      rig: 'mergecrew',
    });
    expect(box.items[1]).toMatchObject({ id: 'gc-844', read: false, threadId: null, rig: null });
  });

  it('drops a message that cannot be answered', () => {
    const box = projectMail({ items: [{ subject: 'no id' }, { id: '  ' }, live.items[1]] });
    expect(box.items.map((item) => item.id)).toEqual(['gc-844']);
    expect(box.total).toBe(1);
  });

  it('answers with an empty mailbox when there is nothing to read', () => {
    expect(projectMail(undefined)).toEqual({ items: [], total: 0, unread: 0 });
    expect(projectMail({ items: 'not a list', total: 12 })).toMatchObject({ items: [], total: 12, unread: 0 });
  });
});

describe('projectMailMessage', () => {
  it('keeps the thread a reply has to join, and tolerates a bare payload', () => {
    expect(projectMailMessage({ id: 'gc-1', thread_id: 'thread-9' })).toMatchObject({
      id: 'gc-1',
      threadId: 'thread-9',
      read: false,
      createdAt: null,
    });
    expect(projectMailMessage({ body: 'no id' })).toBeNull();
  });
});

describe('CityService mail', () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.CITY_BRIDGE_TOKEN;
  const originalTimeout = process.env.CITY_API_TIMEOUT_MS;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.CITY_BRIDGE_TOKEN;
    else process.env.CITY_BRIDGE_TOKEN = originalToken;
    if (originalTimeout === undefined) delete process.env.CITY_API_TIMEOUT_MS;
    else process.env.CITY_API_TIMEOUT_MS = originalTimeout;
  });

  it('reads the mailbox and carries the bridge token', async () => {
    process.env.CITY_BRIDGE_TOKEN = 'bridge-secret';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'gc-844', read: false }], total: 1 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const box = await new CityService().mail();

    expect(String(fetchMock.mock.calls[0][0])).toContain('/v0/city/gascity/mail');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ 'x-city-bridge-token': 'bridge-secret' });
    expect(box.unread).toBe(1);
  });

  it('sends no token when none is configured, and reports the bridge refusal as one', async () => {
    delete process.env.CITY_BRIDGE_TOKEN;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'mail is not open to the network: the bridge has no CITY_BRIDGE_TOKEN, so mail stays closed.',
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(new CityService().mail()).rejects.toThrow(/refused the read/);
    await expect(new CityService().mail()).rejects.toThrow(/CITY_BRIDGE_TOKEN/);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({});
  });

  it('answers a message and then puts the unread flag down', async () => {
    process.env.CITY_BRIDGE_TOKEN = 'bridge-secret';
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'gc-900', reply_to: 'gc-844', thread_id: 'thread-1', body: 'handled' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'read' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const created = await new CityService().replyToMail('gc-844', 'Handled — the backup is green again.');

    expect(created).toMatchObject({ id: 'gc-900', threadId: 'thread-1' });
    const [replyUrl, replyInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(replyUrl)).toContain('/v0/city/gascity/mail/gc-844/reply');
    expect(replyInit.method).toBe('POST');
    expect(replyInit.headers).toMatchObject({
      'content-type': 'application/json',
      'x-gc-request': 'mergecrew-inbox',
      'x-city-bridge-token': 'bridge-secret',
    });
    expect(JSON.parse(String(replyInit.body))).toEqual({ body: 'Handled — the backup is green again.' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/v0/city/gascity/mail/gc-844/read');
  });

  it('keeps the reply when the unread flag could not be cleared', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'gc-901', thread_id: 'thread-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'nope' });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(new CityService().replyToMail('gc-844', 'handled')).resolves.toMatchObject({ id: 'gc-901' });
  });

  it('reports an archive that did not land instead of pretending it did', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"title":"Unprocessable Entity","detail":"unknown message"}',
    }) as unknown as typeof fetch;

    await expect(new CityService().archiveMail('gc-844')).rejects.toThrow(/city write "mail\/gc-844\/archive" did not complete/);
  });

  it('names the one action that cannot be retried safely when a write times out', async () => {
    process.env.CITY_API_TIMEOUT_MS = '10';
    global.fetch = jest.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        }),
    ) as unknown as typeof fetch;

    await expect(new CityService().markMailRead('gc-844')).rejects.toThrow(/may or may not have landed/);
  });

  it('reports a read the supervisor answered without a status as the city being gone', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed')) as unknown as typeof fetch;
    await expect(new CityService().mail()).rejects.toThrow(/not reachable/);
  });
});

describe('CityController mail', () => {
  const city = {
    mail: async () => ({ items: [{ id: 'gc-1' }], total: 1, unread: 1 }),
    replyToMail: async (id: string, body: string) => ({ id: 'gc-900', body, threadId: `thread-of-${id}` }),
    markMailRead: async (id: string) => ({ id, status: 'read' }),
    markMailUnread: async (id: string) => ({ id, status: 'unread' }),
    archiveMail: async (id: string) => ({ id, status: 'archived' }),
  } as unknown as CityService;

  const controller = () => new CityController(city, {} as unknown as TenantContextService);

  it('answers with the mailbox the service read', async () => {
    await expect(controller().mail()).resolves.toMatchObject({ total: 1, unread: 1 });
  });

  it('trims a reply before it sends it', async () => {
    await expect(controller().reply('gc-844', { body: '  handled  ' })).resolves.toMatchObject({
      body: 'handled',
      threadId: 'thread-of-gc-844',
    });
  });

  it('refuses an empty reply and an id that is not a message id', async () => {
    await expect(controller().reply('gc-844', { body: '   ' })).rejects.toThrow(/a reply needs a body/);
    await expect(controller().reply('gc-844', {})).rejects.toThrow(/a reply needs a body/);
    await expect(controller().reply('../../admin', { body: 'hi' })).rejects.toThrow(/not a city message id/);
    await expect(controller().archive('gc/../1')).rejects.toThrow(/not a city message id/);
  });

  it('carries read, unread and archive through', async () => {
    await expect(controller().markRead('gc-1')).resolves.toEqual({ id: 'gc-1', status: 'read' });
    await expect(controller().markUnread('gc-1')).resolves.toEqual({ id: 'gc-1', status: 'unread' });
    await expect(controller().archive('gc-1')).resolves.toEqual({ id: 'gc-1', status: 'archived' });
  });

  it('refuses a reply longer than a message to an agent', async () => {
    await expect(controller().reply('gc-1', { body: 'x'.repeat(4_001) })).rejects.toThrow(/limited to 4000 characters/);
  });
});
