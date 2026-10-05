// Tests for the MergeCrew Schedule -> Gas City order exporter.
//
//   node --test ops/gc/test/orders-export.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_MINUTE_STEP,
  checkCron,
  exportOrder,
  renderOrderToml,
  scheduleToOrder,
} from '../orders-export.mjs';

test('checkCron accepts a weekday morning schedule', () => {
  assert.equal(checkCron('0 8 * * 1-5'), '0 8 * * 1-5');
  assert.equal(checkCron('30 3 * * *'), '30 3 * * *');
  assert.equal(checkCron('*/15 * * * *'), '*/15 * * * *');
});

test('checkCron refuses a per-minute schedule (the Dolt churn rule)', () => {
  assert.throws(() => checkCron('* * * * *'), /fires every minute/);
  assert.throws(() => checkCron('*/1 * * * *'), /minimum step is 5 minutes/);
  assert.throws(() => checkCron('*/2 * * * *'), /minimum step is 5 minutes/);
  assert.throws(() => checkCron('0-2 * * * *'), /minimum step is 5 minutes/);
  assert.throws(() => checkCron('0,2 * * * *'), /less than 5 apart/);
  assert.equal(MIN_MINUTE_STEP, 5);
});

test('checkCron rejects a malformed expression', () => {
  assert.throws(() => checkCron('0 8 * *'), /expected 5 fields/);
  assert.throws(() => checkCron('every-minute please'), /expected 5 fields/);
});

test('scheduleToOrder maps the row and keeps the time zone visible', () => {
  const order = scheduleToOrder(
    { projectId: 'proj-1', cron: '0 8 * * 1-5', timezone: 'America/Los_Angeles', skipDates: ['2026-12-25'] },
    { name: 'proj-1-tick', exec: 'node ops/pipeline/tick.mjs' },
  );
  assert.equal(order.name, 'proj-1-tick');
  assert.equal(order.trigger, 'cron');
  assert.equal(order.cron, '0 8 * * 1-5');
  assert.equal(order.exec, 'node ops/pipeline/tick.mjs');
  assert.equal(order.enabled, true);
  assert.match(order.description, /America\/Los_Angeles/);
  assert.match(order.description, /2026-12-25/);
});

test('a disabled schedule is marked, not silently enabled', () => {
  const order = scheduleToOrder({ projectId: 'p', cron: '0 8 * * *', enabled: false }, { name: 'p-tick' });
  assert.equal(order.enabled, false);
  const toml = renderOrderToml(order);
  assert.match(toml, /^# Disabled in MergeCrew\./m);
  assert.doesNotMatch(toml, /enabled = true/);
});

test('the rendered order TOML has the order table and the cron', () => {
  const toml = exportOrder({ projectId: 'p', cron: '*/10 * * * *' }, { name: 'p-tick', exec: 'true' }).toml;
  assert.match(toml, /^\[order\]$/m);
  assert.match(toml, /^trigger = "cron"$/m);
  assert.match(toml, /^schedule = "\*\/10 \* \* \* \*"$/m);
  assert.match(toml, /^exec = "true"$/m);
  assert.match(toml, /^timeout = "1h"$/m);
});

test('a hostile exec string stays inside one TOML value', () => {
  const toml = renderOrderToml({
    description: 'say "hi"',
    trigger: 'cron',
    cron: '0 8 * * *',
    exec: 'echo "x" \\ y',
    timeout: '1h',
    enabled: true,
  });
  assert.match(toml, /^exec = "echo \\"x\\" \\\\ y"$/m);
  assert.match(toml, /^description = "say \\"hi\\""$/m);
});

test('scheduleToOrder refuses a per-minute schedule', () => {
  assert.throws(() => scheduleToOrder({ projectId: 'p', cron: '* * * * *' }), /fires every minute/);
});
