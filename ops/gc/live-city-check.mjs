// Live contract check for the Gas City supervisor API. ADR-0016 criterion 3.
//
// The integration contract (docs/03-infrastructure/08-gas-city-integration.md) states the payload
// shapes. This module checks them against the running supervisor. When the supervisor is not
// reachable the check reports "unreachable" instead of failing, so a machine without Gas City can
// still run the suite.
//
// Usage:
//   node ops/gc/live-city-check.mjs [--city=gascity] [--base-url=http://127.0.0.1:8372]
//
// Test: node --test ops/gc/test/live-city.test.mjs

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8372';
export const DEFAULT_CITY = 'gascity';

/** Status keys the contract promises. */
export const STATUS_KEYS = ['name', 'path', 'version', 'uptime_sec', 'suspended', 'agent_count', 'rig_count', 'running'];

/** Usage keys the contract promises. */
export const USAGE_KEYS = ['available', 'recording', 'source', 'today', 'recent', 'updated_at'];

export function missingKeys(payload, keys) {
  if (!payload || typeof payload !== 'object') return [...keys];
  return keys.filter((key) => !(key in payload));
}

export async function readResource({ baseUrl = DEFAULT_BASE_URL, city = DEFAULT_CITY, resource, fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}/v0/city/${encodeURIComponent(city)}/${resource}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const text = await response.text();
    return { url, status: response.status, ok: response.ok, payload: safeJson(text), raw: text };
  } catch (error) {
    return { url, status: 0, ok: false, unreachable: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function checkListShape(payload) {
  const problems = [];
  if (!payload || typeof payload !== 'object') return ['the payload is not an object'];
  if (!Array.isArray(payload.items)) problems.push('items is not an array');
  if (typeof payload.total !== 'number') problems.push('total is not a number');
  return problems;
}

export async function checkCity(options = {}) {
  const report = { city: options.city ?? DEFAULT_CITY, baseUrl: options.baseUrl ?? DEFAULT_BASE_URL, results: [], problems: [] };

  const status = await readResource({ ...options, resource: 'status' });
  if (status.unreachable) {
    report.unreachable = true;
    report.problems.push(`status unreachable: ${status.error}`);
    return report;
  }
  const statusMissing = missingKeys(status.payload, STATUS_KEYS);
  report.results.push({ resource: 'status', http: status.status, missing: statusMissing });
  for (const key of statusMissing) report.problems.push(`status is missing "${key}"`);

  for (const resource of ['agents', 'sessions']) {
    const read = await readResource({ ...options, resource });
    const problems = read.unreachable ? ['unreachable'] : checkListShape(read.payload);
    report.results.push({ resource, http: read.status, missing: problems, total: read.payload?.total });
    for (const problem of problems) report.problems.push(`${resource}: ${problem}`);
  }

  const usage = await readResource({ ...options, resource: 'usage' });
  const usageMissing = usage.unreachable ? ['unreachable'] : missingKeys(usage.payload, USAGE_KEYS);
  report.results.push({ resource: 'usage', http: usage.status, missing: usageMissing });
  for (const key of usageMissing) report.problems.push(`usage is missing "${key}"`);

  return report;
}

async function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const report = await checkCity({ city: arg('--city') ?? DEFAULT_CITY, baseUrl: arg('--base-url') ?? DEFAULT_BASE_URL });
  if (report.unreachable) {
    console.log(`city ${report.city} is not reachable at ${report.baseUrl}`);
    return 2;
  }
  for (const result of report.results) {
    const state = result.missing.length ? `problems: ${result.missing.join(', ')}` : 'ok';
    console.log(`${result.resource}: HTTP ${result.http} · ${state}`);
  }
  console.log(report.problems.length === 0 ? 'contract holds' : `contract problems: ${report.problems.length}`);
  return report.problems.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv));
}
