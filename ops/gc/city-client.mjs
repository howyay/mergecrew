// MergeCrew -> Gas City client. ADR-0016 step 6 (criterion 3), the frontend-facing surface.
//
// The MergeCrew API and web app must not shell out to `gc` by hand. This module is the one door:
// reads go to the supervisor HTTP API, actions go to the `gc` CLI. Every rule of the tenant map
// applies: one city, one rig per organization. Zero dependencies.
//
// Usage (a live check):
//   node ops/gc/city-client.mjs --city=gascity
//
// Test: node --test ops/gc/test/city-client.test.mjs

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8372';
export const DEFAULT_CITY = 'gascity';

export function parseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('parseJson: empty input');
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`parseJson: not JSON (${String(error.message).slice(0, 60)})`);
  }
}

/** argv for `gc bd create`, without the leading gc and bd. */
export function beadCreateArgs({ title, description, type = 'task', priority = 2, labels = [] } = {}) {
  if (!title) throw new Error('beadCreateArgs: title is required');
  const args = ['create', '--title', title, '--type', type, '--priority', String(priority)];
  if (description) args.push('--description', description);
  for (const label of labels) args.push('--label', label);
  args.push('--json');
  return args;
}

/** argv for `gc sling`, without the leading gc. */
export function slingArgs(target, bead) {
  if (!target) throw new Error('slingArgs: target is required');
  if (!bead) throw new Error('slingArgs: bead is required');
  return ['sling', target, bead];
}

export function readUrl(baseUrl, city, resource) {
  return `${baseUrl.replace(/\/$/, '')}/v0/city/${encodeURIComponent(city)}/${resource}`;
}

/**
 * The supervisor wraps a list as { items, total }. This helper accepts that envelope and a plain
 * array, so a caller does not break when the shape changes.
 */
export function items(response) {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.items)) return response.items;
  if (response && Array.isArray(response.agents)) return response.agents;
  if (response && Array.isArray(response.sessions)) return response.sessions;
  if (response && Array.isArray(response.rigs)) return response.rigs;
  return [];
}

/** The tenant rule, restated where the client can enforce it. */
export function assertSingleRig(rigs, city) {
  const names = rigs.map((r) => (typeof r === 'string' ? r : r.name));
  if (names.length === 0) throw new Error(`assertSingleRig: city "${city}" has no rig`);
  return names;
}

export function createCityClient(options = {}) {
  const city = options.city ?? DEFAULT_CITY;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const exec = options.exec;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function read(resource) {
    if (!fetchImpl) throw new Error('createCityClient: fetch is not available');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(readUrl(baseUrl, city, resource), { signal: controller.signal });
      if (!response.ok) throw new Error(`city read "${resource}" failed: HTTP ${response.status}`);
      return parseJson(await response.text());
    } finally {
      clearTimeout(timer);
    }
  }

  function run(args) {
    if (!exec) throw new Error('createCityClient: an exec function is required for actions');
    return parseJson(exec(args));
  }

  return {
    city,
    baseUrl,
    status: () => read('status'),
    agents: () => read('agents'),
    sessions: () => read('sessions'),
    usage: () => read('usage'),
    orders: () => run(['order', 'list', '--json']),
    formulas: () => run(['formula', 'list', '--json']),
    rigs: () => run(['rig', 'list', '--json']),
    createBead: (input) => run(['bd', ...beadCreateArgs(input)]),
    showBead: (id) => run(['bd', 'show', id, '--json']),
    sling: (target, bead) => run(slingArgs(target, bead)),
  };
}

async function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const { execFileSync } = await import('node:child_process');
  const client = createCityClient({
    city: arg('--city') ?? DEFAULT_CITY,
    baseUrl: arg('--base-url') ?? DEFAULT_BASE_URL,
    exec: (callArgs) => execFileSync('gc', callArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
  });

  const status = await client.status();
  const agents = await client.agents();
  const list = items(agents);
  console.log(`city: ${status.name ?? client.city} · version: ${status.version ?? 'n/a'} · suspended: ${status.suspended}`);
  console.log(`agents: ${status.agent_count ?? list.length} (listed ${list.length}) · rigs: ${status.rig_count ?? 'n/a'}`);
  const rigs = client.rigs();
  const rigList = items(rigs);
  console.log(`rigs: ${rigList.map((r) => r.name ?? r).join(', ')}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv));
}
