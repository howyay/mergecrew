// Contract tests against the live Gas City supervisor.
//
//   node --test ops/gc/test/live-city.test.mjs
//
// The live test skips when the supervisor is not reachable, so a machine without Gas City can still
// run the suite. The pure tests always run.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS_KEYS,
  USAGE_KEYS,
  checkCity,
  checkListShape,
  missingKeys,
  readResource,
} from '../live-city-check.mjs';

test('missingKeys finds absent keys and tolerates a non-object', () => {
  assert.deepEqual(missingKeys({ a: 1, b: 2 }, ['a', 'b']), []);
  assert.deepEqual(missingKeys({ a: 1 }, ['a', 'b']), ['b']);
  assert.deepEqual(missingKeys(null, ['a']), ['a']);
});

test('checkListShape expects the supervisor envelope', () => {
  assert.deepEqual(checkListShape({ items: [], total: 0 }), []);
  assert.deepEqual(checkListShape({ total: 1 }), ['items is not an array']);
  assert.deepEqual(checkListShape({ items: [] }), ['total is not a number']);
  assert.deepEqual(checkListShape('nope'), ['the payload is not an object']);
});

test('readResource reports an unreachable supervisor instead of throwing', async () => {
  const result = await readResource({
    resource: 'status',
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8372');
    },
  });
  assert.equal(result.unreachable, true);
  assert.equal(result.status, 0);
  assert.match(result.error, /ECONNREFUSED/);
});

test('readResource parses a JSON body and keeps the raw text', async () => {
  const result = await readResource({
    resource: 'status',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"name":"gascity"}' }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.name, 'gascity');
  assert.equal(result.raw, '{"name":"gascity"}');
});

test('checkCity reports the contract and stops when unreachable', async () => {
  const report = await checkCity({
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(report.unreachable, true);
  assert.match(report.problems[0], /unreachable/);
  assert.deepEqual(report.results, []);
});

test('the contract key lists are not empty', () => {
  assert.ok(STATUS_KEYS.includes('version'));
  assert.ok(STATUS_KEYS.includes('agent_count'));
  assert.ok(USAGE_KEYS.includes('today'));
});

test('the live supervisor satisfies the contract', async (t) => {
  const report = await checkCity({});
  if (report.unreachable) {
    t.skip(`supervisor not reachable: ${report.problems[0]}`);
    return;
  }
  assert.deepEqual(
    report.problems,
    [],
    `contract problems: ${report.problems.join('; ')}`,
  );
  const status = report.results.find((r) => r.resource === 'status');
  assert.equal(status.http, 200);
});
