// Tests for the MergeCrew -> Gas City client.
//
//   node --test ops/gc/test/city-client.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BASE_URL,
  DEFAULT_CITY,
  assertSingleRig,
  beadCreateArgs,
  createCityClient,
  items,
  parseJson,
  readUrl,
  slingArgs,
} from '../city-client.mjs';

test('readUrl builds the supervisor path', () => {
  assert.equal(readUrl('http://127.0.0.1:8372', 'gascity', 'status'), 'http://127.0.0.1:8372/v0/city/gascity/status');
  assert.equal(readUrl('http://127.0.0.1:8372/', 'gc', 'agents'), 'http://127.0.0.1:8372/v0/city/gc/agents');
});

test('beadCreateArgs builds a valid bd create call', () => {
  const args = beadCreateArgs({ title: 'T', description: 'D', priority: 1, labels: ['a', 'b'] });
  assert.deepEqual(args, ['create', '--title', 'T', '--type', 'task', '--priority', '1', '--description', 'D', '--label', 'a', '--label', 'b', '--json']);
  assert.throws(() => beadCreateArgs({}), /title is required/);
});

test('slingArgs requires a target and a bead', () => {
  assert.deepEqual(slingArgs('mergecrew/gastown.polecat', 'me-1'), ['sling', 'mergecrew/gastown.polecat', 'me-1']);
  assert.throws(() => slingArgs('', 'me-1'), /target is required/);
  assert.throws(() => slingArgs('x', ''), /bead is required/);
});

test('parseJson rejects empty input and non-JSON', () => {
  assert.deepEqual(parseJson('{"ok":true}'), { ok: true });
  assert.throws(() => parseJson('   '), /empty input/);
  assert.throws(() => parseJson('<html>'), /not JSON/);
});

test('assertSingleRig refuses a city without a rig', () => {
  assert.deepEqual(assertSingleRig([{ name: 'mergecrew' }], 'gascity'), ['mergecrew']);
  assert.throws(() => assertSingleRig([], 'gascity'), /has no rig/);
});

test('reads go to the HTTP API', async () => {
  const calls = [];
  const client = createCityClient({
    city: 'gascity',
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => '{"ok":true,"city_name":"gascity"}' };
    },
  });
  const status = await client.status();
  assert.equal(status.city_name, 'gascity');
  assert.deepEqual(calls, [`${DEFAULT_BASE_URL}/v0/city/gascity/status`]);
});

test('a failed read reports the HTTP status', async () => {
  const client = createCityClient({ fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'nope' }) });
  await assert.rejects(() => client.agents(), /HTTP 503/);
});

test('actions go to the gc CLI and are parsed', () => {
  const seen = [];
  const client = createCityClient({ exec: (args) => { seen.push(args); return '{"id":"me-9"}'; } });
  assert.deepEqual(client.createBead({ title: 'T' }), { id: 'me-9' });
  assert.deepEqual(seen[0], ['bd', ...beadCreateArgs({ title: 'T' })]);
});

test('an action without an exec function fails loudly', () => {
  const client = createCityClient({});
  assert.throws(() => client.orders(), /exec function is required/);
});

test('the default city and base URL are the local ones', () => {
  assert.equal(DEFAULT_CITY, 'gascity');
  assert.equal(DEFAULT_BASE_URL, 'http://127.0.0.1:8372');
});

test('items() accepts the supervisor envelope and a plain array', () => {
  assert.deepEqual(items({ items: [1, 2], total: 2 }), [1, 2]);
  assert.deepEqual(items([3]), [3]);
  assert.deepEqual(items({ agents: [4] }), [4]);
  assert.deepEqual(items(null), []);
});

test('a real supervisor envelope parses into a list', async () => {
  const client = createCityClient({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"items":[{"name":"gastown.mayor"}],"total":1}' }),
  });
  const response = await client.agents();
  assert.equal(response.total, 1);
  assert.deepEqual(items(response).map((a) => a.name), ['gastown.mayor']);
});
