// Gas City order gate. ADR-0016 step 3, second slice.
//
// An exported schedule does nothing unless the city holds a schedulable order. A trigger without its
// field never fires, and an order without an action never runs. This gate checks both, and it checks
// that every file in the city's orders directory reached the city. Zero dependencies.
//
// Usage:
//   node ops/gc/order-gate.mjs [--city-dir=/home/haoye/gascity] [--expect=proj-demo-tick]
//
// Test: node --test ops/gc/test/order-gate.test.mjs

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const TRIGGERS = ['cron', 'cooldown', 'event', 'manual'];

/** The order names a city orders directory declares. */
export function expectedFromDirectory(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.toml'))
      .map((name) => name.replace(/\.toml$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/** Check one order as `gc order list --json` returns it. */
export function checkOrder(order) {
  const problems = [];
  const name = order?.name ?? '(unnamed)';
  const push = (text) => problems.push(`${name}: ${text}`);

  if (!TRIGGERS.includes(order?.trigger)) {
    push(`the trigger "${order?.trigger ?? ''}" is not one of ${TRIGGERS.join(', ')}`);
  }

  if (order?.trigger === 'cron') {
    const fields = String(order?.schedule ?? '').trim().split(/\s+/).filter(Boolean);
    if (fields.length !== 5) push(`a cron order needs a five-field schedule, and it has "${order?.schedule ?? ''}"`);
  }
  if (order?.trigger === 'cooldown' && !String(order?.interval ?? '').trim()) {
    push('a cooldown order needs an interval');
  }

  const hasAction = Boolean(String(order?.exec ?? '').trim()) || Boolean(String(order?.formula ?? '').trim());
  if (!hasAction) push('the order has no action: neither exec nor formula is set');

  if (typeof order?.enabled !== 'boolean') push('enabled must be a boolean, so the scheduler knows the state');

  return problems;
}

/** Every declared order must be present, or it was silently dropped. */
export function checkExpected(expected, available) {
  const names = new Set((available ?? []).map((order) => order?.name ?? order));
  const problems = [];
  for (const name of expected ?? []) {
    if (!names.has(name)) problems.push(`${name}: the order is absent from the city`);
  }
  return problems;
}

export function renderGate({ expected, reports, absent }) {
  const lines = ['# Order gate (ADR-0016 step 3)', ''];
  const problems = absent.length + reports.reduce((sum, report) => sum + report.problems.length, 0);
  lines.push(`Declared: ${expected.length} · in the city: ${reports.length} · problems: ${problems}`);
  lines.push('');
  for (const report of reports) {
    lines.push(`## ${report.name}`);
    lines.push('');
    if (!report.problems.length) {
      lines.push(`- ok · trigger ${report.trigger}${report.schedule ? ` · schedule ${report.schedule}` : ''}`);
    }
    for (const problem of report.problems) lines.push(`- ${problem}`);
    lines.push('');
  }
  if (absent.length) {
    lines.push('## Absent');
    lines.push('');
    for (const problem of absent) lines.push(`- ${problem}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function runGate({ orders, expected = [] } = {}) {
  const reports = (orders ?? []).map((order) => ({
    name: order?.name ?? '(unnamed)',
    trigger: order?.trigger ?? '',
    schedule: order?.schedule ?? order?.interval ?? '',
    problems: checkOrder(order),
  }));
  const absent = checkExpected(expected, orders);
  return { reports, absent, report: renderGate({ expected, reports, absent }) };
}

async function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const cityDir = arg('--city-dir') ?? process.env.GC_CITY_PATH ?? process.cwd();
  const { execFileSync } = await import('node:child_process');
  const run = (callArgs) => execFileSync('gc', callArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: cityDir });

  const listed = JSON.parse(run(['order', 'list', '--json']));
  const orders = listed.orders ?? [];
  const expected = arg('--expect') ? arg('--expect').split(',') : expectedFromDirectory(join(cityDir, 'orders'));

  const result = runGate({ orders, expected });
  console.log(result.report);
  return result.absent.length || result.reports.some((r) => r.problems.length) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv));
}
