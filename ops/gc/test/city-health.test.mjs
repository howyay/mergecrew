// Tests for the Gas City health gate.
//
//   node --test ops/gc/test/city-health.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_START_PENDING_MINUTES,
  MIN_SCHEDULE_MINUTES,
  REQUIRED_ORDERS,
  checkEndpointMirror,
  checkOrders,
  checkSessions,
  countDoltErrors,
  cronMinutes,
  errorWindow,
  logStamp,
  renderHealth,
  runHealth,
  scheduleMinutes,
} from '../city-health.mjs';

test('cronMinutes reads the minute field', () => {
  assert.equal(cronMinutes('* * * * *'), 1);
  assert.equal(cronMinutes('*/2 * * * *'), 2);
  assert.equal(cronMinutes('*/15 * * * *'), 15);
  assert.equal(cronMinutes('0 8 * * 1-5'), 60);
  assert.equal(cronMinutes('0,30 * * * *'), null);
  assert.equal(cronMinutes('nonsense'), null);
});

test('scheduleMinutes reads an interval', () => {
  assert.equal(scheduleMinutes('30s'), 0.5);
  assert.equal(scheduleMinutes('15m'), 15);
  assert.equal(scheduleMinutes('2h'), 120);
  assert.equal(scheduleMinutes(''), null);
});

test('checkOrders refuses a per-minute writer (the 2026-10-05 outage)', () => {
  const problems = checkOrders([
    { name: 'beads-health', trigger: 'cooldown', interval: '30s' },
    { name: 'gate-sweep', trigger: 'cooldown', interval: '1m' },
    { name: 'cascade', trigger: 'event', on: 'bead.updated' },
    { name: 'quiet', trigger: 'cron', schedule: '0 8 * * 1-5' },
    { name: 'nudge-on-route', trigger: 'event' },
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /beads-health" fires every 0.5 minute/);
  assert.match(problems[1], /gate-sweep" fires every 1 minute/);
  assert.equal(MIN_SCHEDULE_MINUTES, 5);
});

test('checkOrders ignores a disabled order', () => {
  const problems = checkOrders([
    { name: 'off', trigger: 'cooldown', interval: '30s', enabled: false },
    { name: 'nudge-on-route', trigger: 'event' },
  ]);
  assert.deepEqual(problems, []);
});

test('checkOrders reports the missing wake order', () => {
  const problems = checkOrders([{ name: 'other', trigger: 'cron', schedule: '0 8 * * 1-5' }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /nudge-on-route" is absent/);
  assert.deepEqual(REQUIRED_ORDERS, ['nudge-on-route']);
});

test('countDoltErrors counts the write failures and honours a time mark', () => {
  const log = [
    '2026/10/05 04:20:00 gc: order exec: invalid connection',
    '2026/10/05 05:00:00 gc: write commit result indeterminate after connection loss',
    '2026/10/05 05:10:00 gc: [circuit-breaker] closed -> open',
    '2026/10/05 05:20:00 gc: all good',
  ].join('\n');
  assert.equal(countDoltErrors(log).length, 3);
  assert.equal(countDoltErrors(log, { since: '2026/10/05 05:00' }).length, 2);
  assert.equal(countDoltErrors(log, { since: '2026/10/05 06:00' }).length, 0);
});

test('checkSessions flags a stuck start', () => {
  const now = Date.parse('2026-10-05T06:00:00Z');
  const sessions = [
    { id: 'ga-fresh', state: 'start-pending', created_at: '2026-10-05T05:58:00Z' },
    { id: 'ga-stuck', state: 'start-pending', created_at: '2026-10-05T05:30:00Z' },
    { id: 'ga-asleep', state: 'asleep', created_at: '2026-10-05T05:30:00Z' },
  ];
  const problems = checkSessions(sessions, now);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ga-stuck" waits 30 minute/);
  assert.equal(MAX_START_PENDING_MINUTES, 10);
});

test('runHealth combines the three checks', () => {
  const result = runHealth({
    orders: [{ name: 'fast', trigger: 'cooldown', interval: '10s' }, { name: 'nudge-on-route', trigger: 'event' }],
    logText: '2026/10/05 05:00:00 invalid connection',
    sessions: [],
    since: '2026/10/05 04:00',
  });
  assert.equal(result.orderProblems.length, 1);
  assert.equal(result.doltErrors.length, 1);
  assert.deepEqual(result.sessionProblems, []);
  assert.match(result.report, /Store errors since 2026\/10\/05 04:00: 1/);
});

test('a healthy city produces an empty report', () => {
  const result = runHealth({
    orders: [{ name: 'nudge-on-route', trigger: 'event' }, { name: 'dog', trigger: 'cron', schedule: '0 */4 * * *' }],
    logText: '2026/10/05 05:00:00 gc: supervisor ready',
    sessions: [{ id: 'ga-ok', state: 'active' }],
  });
  assert.deepEqual(result.orderProblems, []);
  assert.deepEqual(result.doltErrors, []);
  assert.deepEqual(result.sessionProblems, []);
  assert.match(renderHealth({ orders: [], doltErrors: [], sessions: [] }), /^None\.$/m);
});

test('the hyphenated circuit-breaker form is counted too', () => {
  const log = '2026/10/05 05:10:00 gc: [circuit-breaker] closed -> open';
  assert.equal(countDoltErrors(log).length, 1);
});

test('logStamp writes the local format the supervisor uses', () => {
  const stamp = logStamp(new Date(2026, 9, 5, 6, 7));
  assert.equal(stamp, '2026/10/05 06:07');
  assert.match(stamp, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
});

test('a wrapped error counts once, with its own stamp', () => {
  const log = [
    '2026/10/05 05:00:00 gc: session reconciler failed:',
    '  write commit result indeterminate after connection loss',
    '  invalid connection',
    '2026/10/05 05:01:00 gc: supervisor ready',
  ].join('\n');
  assert.equal(countDoltErrors(log).length, 1);
  assert.equal(countDoltErrors(log, { since: '2026/10/05 05:00' }).length, 1);
  assert.equal(countDoltErrors(log, { since: '2026/10/05 05:01' }).length, 0);
});

test('a wrapped error before the mark is not counted', () => {
  const log = [
    '2026/10/05 04:00:00 gc: failed:',
    '  invalid connection',
    '2026/10/05 05:00:00 gc: fine',
  ].join('\n');
  assert.equal(countDoltErrors(log, { since: '2026/10/05 04:30' }).length, 0);
});

test('errorWindow reports the span of the counted errors', () => {
  const lines = [
    '2026/10/05 01:20:00 gc: invalid connection',
    '2026/10/05 03:00:00 gc: circuit-breaker open',
  ];
  assert.deepEqual(errorWindow(lines), { first: '2026/10/05 01:20', last: '2026/10/05 03:00' });
  assert.equal(errorWindow([]), null);
});

test('the report shows the error window', () => {
  const report = renderHealth({
    orders: [],
    doltErrors: ['2026/10/05 01:20:00 gc: invalid connection'],
    sessions: [],
    since: '2026/10/05 01:00',
  });
  assert.match(report, /Store errors since 2026\/10\/05 01:00: 1 \(2026\/10\/05 01:20 to 2026\/10\/05 01:20\)/);
});

test('the endpoint mirror passes when every rig matches the city', () => {
  const problems = checkEndpointMirror({ cityPort: '49943', rigs: [{ name: 'mergecrew', port: '49943' }] });
  assert.deepEqual(problems, []);
});

test('a missing rig port file is a problem (the 2026-10-05 write failure)', () => {
  const problems = checkEndpointMirror({ cityPort: '49943\n', rigs: [{ name: 'mergecrew', port: '' }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /rig "mergecrew" has no endpoint port file/);
});

test('a mismatch between the rig and the city is a problem', () => {
  const problems = checkEndpointMirror({ cityPort: '49943', rigs: [{ name: 'other', port: '49944' }] });
  assert.match(problems.join(' '), /points at port 49944, and the city serves 49943/);
});

test('a missing port file names the file and the value that fixes it', () => {
  const problems = checkEndpointMirror({
    cityPort: '49943',
    rigs: [{ name: 'mergecrew', port: '', path: '/home/haoye/projects/mergecrew' }],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\/home\/haoye\/projects\/mergecrew\/\.beads\/dolt-server\.port/);
  assert.match(problems[0], /write 49943 into .* to re-point it/);
});

test('a port mismatch carries the same fix', () => {
  const problems = checkEndpointMirror({
    cityPort: '49943',
    rigs: [{ name: 'mergecrew', port: '49944', path: '/home/haoye/projects/mergecrew' }],
  });
  assert.match(problems[0], /write 49943 into .*dolt-server\.port to re-point it/);
});

test('a city without a port file is a problem', () => {
  assert.match(checkEndpointMirror({ cityPort: '', rigs: [] }).join(' '), /the city has no endpoint port file/);
});

test('runHealth reports the mirror problems', () => {
  const result = runHealth({
    orders: [],
    logText: '',
    sessions: [],
    mirror: { cityPort: '49943', rigs: [{ name: 'r', port: '' }] },
  });
  assert.equal(result.mirrorProblems.length, 1);
  assert.match(result.report, /Endpoint mirror problems: 1/);
});
