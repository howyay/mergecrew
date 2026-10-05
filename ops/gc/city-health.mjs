// Gas City health gate. ADR-0016 criterion 4, and the lessons of 2026-10-05.
//
// On 2026-10-05 fourteen orders that wrote once per minute dropped the Dolt connection, and session
// metadata writes failed with them. A `min_active_sessions = 0` pool then sent workers to sleep, and
// `nudge-on-route` was off, so routed work was never claimed. This gate checks all three conditions,
// so the same outage cannot return unnoticed. Zero dependencies.
//
// Usage:
//   node ops/gc/city-health.mjs [--since-minutes=60] [--log=~/.gc/supervisor.log]
//
// Test: node --test ops/gc/test/city-health.test.mjs

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The fastest schedule a Gas City order may have. */
export const MIN_SCHEDULE_MINUTES = 5;

/** Patterns that show a broken store write. Both the spaced and the hyphenated forms appear. */
export const DOLT_ERROR_PATTERNS = [
  /invalid connection/i,
  /result indeterminate/i,
  /circuit[- ]breaker/i,
  /i\/o timeout/i,
];

/** The log stamp format: local time, as the supervisor writes it. */
export function logStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A session that waits this long to start is stuck. */
export const MAX_START_PENDING_MINUTES = 10;

/** The order that wakes a worker when work is routed to it. Without it, work waits. */
export const REQUIRED_ORDERS = ['nudge-on-route'];

/** Read a five-field cron minute field, or an interval such as "30s", "15m", "2h". */
export function scheduleMinutes(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const interval = text.match(/^(\d+)\s*(s|m|h)$/i);
  if (interval) {
    const amount = Number(interval[1]);
    const unit = interval[2].toLowerCase();
    if (unit === 's') return amount / 60;
    if (unit === 'm') return amount;
    return amount * 60;
  }
  return null;
}

export function cronMinutes(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute] = fields;
  const step = minute.match(/^\*\/(\d+)$/);
  if (step) return Number(step[1]);
  if (minute === '*') return 1;
  if (/^\d+$/.test(minute)) return 60;
  return null;
}

/** Problems found in the order list. Each order is { name, trigger, schedule, interval, enabled }. */
export function checkOrders(orders, { required = REQUIRED_ORDERS } = {}) {
  const problems = [];
  const names = new Set();
  for (const order of orders ?? []) {
    const name = order.name ?? '(unnamed)';
    names.add(name);
    if (order.enabled === false) continue;
    const minutes = order.trigger === 'cron' ? cronMinutes(order.schedule) : scheduleMinutes(order.interval);
    if (minutes !== null && minutes < MIN_SCHEDULE_MINUTES) {
      problems.push(`order "${name}" fires every ${minutes} minute(s). The minimum is ${MIN_SCHEDULE_MINUTES}.`);
    }
  }
  for (const name of required) {
    if (!names.has(name)) problems.push(`order "${name}" is absent. A routed bead will not wake a worker.`);
  }
  return problems;
}

/**
 * Count the store-write error records in a supervisor log after a time mark.
 *
 * A supervisor error is a timestamped line plus the lines that wrap it. Counting every matching
 * line inflates the number, and the wrapped lines have no stamp of their own, so they could not be
 * filtered by time. This groups the lines into records first.
 */
export function countDoltErrors(logText, { since } = {}) {
  const records = [];
  let current = null;
  for (const line of String(logText ?? '').split('\n')) {
    const stamp = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2})/);
    if (stamp) {
      if (current) records.push(current);
      current = { stamp: stamp[1], lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) records.push(current);

  const hits = [];
  for (const record of records) {
    if (since && record.stamp < since) continue;
    if (!record.lines.some((line) => DOLT_ERROR_PATTERNS.some((pattern) => pattern.test(line)))) continue;
    hits.push(record.lines[0].slice(0, 160));
  }
  return hits;
}

/** Problems found in the session list. Each session is { id, state, reason, created_at }. */
export function checkSessions(sessions, now = Date.now(), { maxPendingMinutes = MAX_START_PENDING_MINUTES } = {}) {
  const problems = [];
  for (const session of sessions ?? []) {
    if (session.state !== 'start-pending') continue;
    const created = session.created_at ? Date.parse(session.created_at) : NaN;
    if (!Number.isFinite(created)) continue;
    const minutes = (now - created) / 60_000;
    if (minutes > maxPendingMinutes) {
      problems.push(`session "${session.id}" waits ${Math.round(minutes)} minute(s) to start.`);
    }
  }
  return problems;
}

export function renderHealth({ orders, doltErrors, sessions, since }) {
  const lines = ['# Gas City health', ''];
  lines.push(`Store errors since ${since ?? 'the start of the log'}: ${doltErrors.length}`);
  lines.push(`Order problems: ${orders.length}`);
  lines.push(`Session problems: ${sessions.length}`);
  lines.push('');
  const sections = [
    ['Store errors', doltErrors],
    ['Orders', orders],
    ['Sessions', sessions],
  ];
  for (const [title, items] of sections) {
    lines.push(`## ${title}`);
    lines.push('');
    if (!items.length) lines.push('None.');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function logPath() {
  return process.env.GC_SUPERVISOR_LOG ?? join(homedir(), '.gc', 'supervisor.log');
}

export function runHealth({ orders = [], logText = '', sessions = [], since } = {}) {
  const orderProblems = checkOrders(orders);
  const doltErrors = countDoltErrors(logText, { since });
  const sessionProblems = checkSessions(sessions);
  return { orderProblems, doltErrors, sessionProblems, report: renderHealth({ orders: orderProblems, doltErrors, sessions: sessionProblems, since }) };
}

async function main(argv) {
  const args = argv.slice(2);
  const arg = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=');
  const sinceMinutes = Number(arg('--since-minutes') ?? 60);
  const since = logStamp(new Date(Date.now() - sinceMinutes * 60_000));
  // `gc` answers only inside a city. The tool may run from anywhere, so name the city directory.
  const cityDir = arg('--city-dir') ?? process.env.GC_CITY_PATH ?? process.cwd();

  const { execFileSync } = await import('node:child_process');
  const read = (resource) => {
    const out = execFileSync('gc', [resource, 'list', '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      cwd: cityDir,
    });
    const data = JSON.parse(out);
    return Array.isArray(data) ? data : (data.items ?? data.orders ?? data.sessions ?? []);
  };

  let logText = '';
  try {
    logText = readFileSync(arg('--log') ?? logPath(), 'utf8');
  } catch {
    logText = '';
  }

  const result = runHealth({ orders: read('order'), sessions: read('session'), logText, since });
  console.log(result.report);
  return result.orderProblems.length || result.doltErrors.length || result.sessionProblems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv));
}
