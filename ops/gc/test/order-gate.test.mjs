// Tests for the order gate.
//
//   node --test ops/gc/test/order-gate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRIGGERS,
  checkExpected,
  checkOrder,
  expectedFromDirectory,
  renderGate,
  runGate,
} from '../order-gate.mjs';

test('a cron order with a schedule, an action, and a state passes', () => {
  const problems = checkOrder({
    name: 'proj-demo-tick',
    trigger: 'cron',
    schedule: '0 8 * * 1-5',
    exec: 'node ops/pipeline/tick.mjs',
    enabled: true,
  });
  assert.deepEqual(problems, []);
});

test('a cooldown order needs an interval', () => {
  const problems = checkOrder({ name: 'x', trigger: 'cooldown', interval: '', exec: 'true', enabled: true });
  assert.match(problems.join(' '), /a cooldown order needs an interval/);
});

test('a cron order needs five fields', () => {
  assert.match(checkOrder({ name: 'x', trigger: 'cron', schedule: '0 8 * *', exec: 't', enabled: true }).join(' '), /five-field schedule/);
  assert.match(checkOrder({ name: 'x', trigger: 'cron', exec: 't', enabled: true }).join(' '), /five-field schedule/);
});

test('an unknown trigger is a problem', () => {
  const problems = checkOrder({ name: 'x', trigger: 'whenever', exec: 't', enabled: true });
  assert.match(problems.join(' '), /is not one of cron, cooldown, event, manual/);
  assert.deepEqual(TRIGGERS, ['cron', 'cooldown', 'event', 'manual']);
});

test('an order with no action is a problem', () => {
  assert.match(checkOrder({ name: 'x', trigger: 'event', enabled: true }).join(' '), /neither exec nor formula/);
  assert.deepEqual(checkOrder({ name: 'x', trigger: 'event', formula: 'mol-do-work', enabled: true }), []);
});

test('a missing enabled flag is a problem', () => {
  assert.match(checkOrder({ name: 'x', trigger: 'event', exec: 't' }).join(' '), /enabled must be a boolean/);
});

test('checkExpected reports a declared order the city does not hold', () => {
  assert.deepEqual(checkExpected(['a'], [{ name: 'a' }, { name: 'b' }]), []);
  assert.deepEqual(checkExpected(['a', 'gone'], [{ name: 'a' }]), ['gone: the order is absent from the city']);
});

test('expectedFromDirectory reads the toml names', () => {
  assert.deepEqual(expectedFromDirectory('/definitely/not/here'), []);
});

test('runGate combines the checks', () => {
  const result = runGate({
    orders: [
      { name: 'ok', trigger: 'cron', schedule: '0 8 * * *', exec: 't', enabled: true },
      { name: 'bad', trigger: 'cron', schedule: '* * * * *', exec: 't', enabled: true },
    ],
    expected: ['ok', 'gone'],
  });
  assert.equal(result.reports.length, 2);
  assert.deepEqual(result.absent, ['gone: the order is absent from the city']);
  assert.match(result.report, /Declared: 2 · in the city: 2 · problems: 1/);
  assert.match(result.report, /- ok · trigger cron · schedule 0 8 \* \* \*/);
});

test('the report states an absent order', () => {
  const report = renderGate({ expected: ['gone'], reports: [], absent: ['gone: the order is absent from the city'] });
  assert.match(report, /## Absent/);
  assert.match(report, /- gone: the order is absent from the city/);
});
