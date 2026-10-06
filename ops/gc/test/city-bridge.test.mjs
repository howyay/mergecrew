// Tests for the city bridge. Zero dependencies: node --test.
//
//   node --test ops/gc/test/city-bridge.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  DEFAULT_ALLOW,
  bindAddresses,
  checkSupervisor,
  main,
  readTarget,
  startBridge,
} from '../city-bridge.mjs';

/** A fake supervisor that records what reached it. */
async function fakeSupervisor(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (handler) return handler(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'gascity', ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function get(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, text: await response.text() };
}

test('readTarget allows only the resources the API reads', () => {
  assert.deepEqual(readTarget('/v0/city/gascity/status'), { city: 'gascity', resource: 'status' });
  assert.deepEqual(readTarget('/v0/city/gascity/usage'), { city: 'gascity', resource: 'usage' });
  // Write routes and anything else the supervisor serves stay on the host.
  assert.equal(readTarget('/v0/city/gascity/bead/bd-1/close'), null);
  assert.equal(readTarget('/v0/city/gascity/beads'), null);
  assert.equal(readTarget('/v0/city/gascity/mail/1/reply'), null);
  assert.equal(readTarget('/v0/city/gascity/session/gc-1/respond'), null);
  assert.equal(readTarget('/healthz'), null);
  assert.equal(readTarget('/'), null);
  // A custom allowlist is honoured.
  assert.equal(readTarget('/v0/city/gascity/beads', ['beads']).resource, 'beads');
  assert.equal(readTarget('/v0/city/gascity/status', ['beads']), null);
  assert.equal(DEFAULT_ALLOW.join(','), 'status,agents,sessions,usage,rigs');
});

test('bindAddresses auto includes loopback, explicit addresses are taken as given', async () => {
  const auto = await bindAddresses('auto');
  assert.ok(auto.includes('127.0.0.1'), `auto should always include loopback, got ${auto.join(', ')}`);
  assert.deepEqual(await bindAddresses('10.0.0.119'), ['10.0.0.119']);
  assert.deepEqual(await bindAddresses('0.0.0.0'), ['0.0.0.0']);
});

test('the bridge forwards an allowed read and keeps the query string', async () => {
  const upstream = await fakeSupervisor();
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: upstream.origin });
  try {
    const response = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/status?view=summary`);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { name: 'gascity', ok: true });
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].method, 'GET');
    assert.equal(upstream.seen[0].url, '/v0/city/gascity/status?view=summary');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('the bridge refuses a write path without touching the supervisor', async () => {
  const upstream = await fakeSupervisor();
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: upstream.origin });
  try {
    const response = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/bead/bd-1/close`);
    assert.equal(response.status, 403);
    assert.match(response.text, /only \/v0\/city\/<city>\/status/);
    assert.equal(upstream.seen.length, 0, 'a refused path must never reach the supervisor');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('the bridge refuses a write method on an allowed path', async () => {
  const upstream = await fakeSupervisor();
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: upstream.origin });
  try {
    const response = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/status`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('the bridge reports 502 when the supervisor is down', async () => {
  const upstream = await fakeSupervisor();
  const origin = upstream.origin;
  await upstream.close();
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: origin });
  try {
    const response = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/status`);
    assert.equal(response.status, 502);
    assert.match(response.text, /did not answer/);
  } finally {
    await bridge.close();
  }
});

test('an upstream error status is passed through, not papered over', async () => {
  const upstream = await fakeSupervisor((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'suspended' }));
  });
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: upstream.origin });
  try {
    const response = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/usage`);
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.text), { error: 'suspended' });
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('checkSupervisor tells a live supervisor from a dead one', async () => {
  const upstream = await fakeSupervisor();
  const live = await checkSupervisor({ target: upstream.origin });
  assert.equal(live.ok, true);
  assert.equal(live.status, 200);
  assert.ok(live.bytes > 0);
  await upstream.close();

  const dead = await checkSupervisor({ target: upstream.origin, timeoutMs: 500 });
  assert.equal(dead.ok, false);
  assert.equal(dead.status, 0);
  assert.ok(dead.error);
});

test('--check exits 0 when the supervisor answers and 1 when it does not', async () => {
  const upstream = await fakeSupervisor();
  const live = await main(['--check', '--quiet', '--target', upstream.origin]);
  assert.equal(live, 0);
  const origin = upstream.origin;
  await upstream.close();
  const dead = await main(['--check', '--quiet', '--target', origin]);
  assert.equal(dead, 1);
});

test('bad usage is rejected instead of starting a half-configured bridge', async () => {
  await assert.rejects(() => main(['--port', 'nope']), /--port must be a port number/);
  await assert.rejects(() => main(['--allow', ' , ']), /--allow cannot be empty/);
  await assert.rejects(() => main(['--nope']), /unknown flag --nope/);
  assert.equal(await main(['--help']), 0);
});
