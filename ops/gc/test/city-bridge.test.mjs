// Tests for the city bridge. Zero dependencies: node --test.
//
//   node --test ops/gc/test/city-bridge.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  DEFAULT_ALLOW,
  DEFAULT_WRITES,
  TOKEN_HEADER,
  bindAddresses,
  checkSupervisor,
  main,
  readTarget,
  startBridge,
  writeTarget,
} from '../city-bridge.mjs';

/** A fake supervisor that records what reached it, body included. */
async function fakeSupervisor(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body: '' };
    seen.push(entry);
    req.on('data', (chunk) => {
      entry.body += chunk;
    });
    req.on('end', () => {
      if (handler) return handler(req, res, entry);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'gascity', ok: true }));
    });
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
  assert.deepEqual(readTarget('/v0/city/gascity/mail'), { city: 'gascity', resource: 'mail' });
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
  assert.equal(DEFAULT_ALLOW.join(','), 'status,agents,sessions,usage,rigs,mail');
});

test('writeTarget carries the four mail writes and nothing wider', () => {
  assert.deepEqual(writeTarget('/v0/city/gascity/mail/gc-844/reply'), {
    city: 'gascity',
    id: 'gc-844',
    action: 'reply',
  });
  assert.deepEqual(writeTarget('/v0/city/gascity/mail/thread-82c85164a5c2/archive'), {
    city: 'gascity',
    id: 'thread-82c85164a5c2',
    action: 'archive',
  });
  assert.equal(DEFAULT_WRITES.join(','), 'mail/:id/reply,mail/:id/read,mail/:id/mark-unread,mail/:id/archive');
  // Anything outside the four: bead writes, session prompts, creating mail.
  assert.equal(writeTarget('/v0/city/gascity/mail/gc-1/close'), null);
  assert.equal(writeTarget('/v0/city/gascity/bead/bd-1/close'), null);
  assert.equal(writeTarget('/v0/city/gascity/session/gc-1/respond'), null);
  assert.equal(writeTarget('/v0/city/gascity/mail'), null);
  // A custom write allowlist is honoured, and it cannot widen the shape.
  assert.equal(writeTarget('/v0/city/gascity/mail/gc-1/read', ['mail/:id/read']).action, 'read');
  assert.equal(writeTarget('/v0/city/gascity/mail/gc-1/reply', ['mail/:id/read']), null);
  // An encoded or traversing id would travel through this proxy untouched, so it
  // is refused here rather than decoded by whoever reads the upstream request.
  assert.equal(writeTarget('/v0/city/gascity/mail/a%2Fb/reply'), null);
  assert.equal(writeTarget('/v0/city/gascity/mail/../admin/x/reply'), null);
  assert.equal(writeTarget('/v0/city/gascity/mail/gc-1/reply/extra'), null);
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

test('with no token the counters read and the mailbox stays shut', async () => {
  const upstream = await fakeSupervisor();
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: upstream.origin, token: '' });
  try {
    const ok = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/status`);
    assert.equal(ok.status, 200);

    const mail = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/mail`);
    assert.equal(mail.status, 403);
    assert.match(mail.text, /CITY_BRIDGE_TOKEN/, 'the refusal names the missing configuration');

    const reply = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/mail/gc-1/reply`, { method: 'POST' });
    assert.equal(reply.status, 403);

    assert.equal(upstream.seen.length, 1, 'only the unauthenticated status read may reach the supervisor');
    assert.equal(upstream.seen[0].url, '/v0/city/gascity/status');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('the mailbox opens for a caller holding the token, and only for one', async () => {
  const upstream = await fakeSupervisor((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{ id: 'gc-844' }], total: 1 }));
  });
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: upstream.origin, token: 'secret-token' });
  try {
    const bare = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/mail`);
    assert.equal(bare.status, 403, 'the mailbox is private, not open to the network');

    const wrong = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/mail`, {
      headers: { [TOKEN_HEADER]: 'not-the-token' },
    });
    assert.equal(wrong.status, 403);
    assert.equal(upstream.seen.length, 0, 'a refused read must never reach the supervisor');

    const right = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/mail`, {
      headers: { [TOKEN_HEADER]: 'secret-token' },
    });
    assert.equal(right.status, 200);
    assert.deepEqual(JSON.parse(right.text), { items: [{ id: 'gc-844' }], total: 1 });
    assert.equal(upstream.seen.length, 1);
    assert.equal(
      upstream.seen[0].headers[TOKEN_HEADER],
      undefined,
      'the token is checked here and does not travel on to the supervisor',
    );
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a reply travels with its body, its csrf header and its thread intact', async () => {
  const upstream = await fakeSupervisor((_req, res, entry) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'gc-900', reply_to: entry.url.split('/')[5], thread_id: 'thread-1' }));
  });
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: upstream.origin, token: 'secret-token' });
  try {
    const response = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/mail/gc-844/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: 'secret-token', 'x-gc-request': 'mergecrew' },
      body: JSON.stringify({ body: 'Handled — the backup is green again.' }),
    });
    assert.equal(response.status, 201);
    assert.equal(upstream.seen.length, 1);
    const seen = upstream.seen[0];
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v0/city/gascity/mail/gc-844/reply');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.headers['x-gc-request'], 'mergecrew', 'the supervisor needs the csrf header the caller sent');
    // The bridge token stays between the caller and the bridge, and the city
    // needs no bearer of its own, so neither reaches the supervisor.
    assert.equal(seen.headers[TOKEN_HEADER], undefined, 'the bridge token is not forwarded upstream');
    assert.equal(seen.headers['authorization'], undefined, 'the caller bearer is not forwarded upstream');
    assert.deepEqual(JSON.parse(seen.body), { body: 'Handled — the backup is green again.' });
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a write outside the four mail routes is refused even with the token', async () => {
  const upstream = await fakeSupervisor();
  const bridge = await startBridge({ bind: '127.0.0.1', port: 0, target: upstream.origin, token: 'secret-token' });
  try {
    const bead = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/bead/bd-1/close`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: 'secret-token' },
    });
    assert.equal(bead.status, 403);
    assert.match(bead.text, /writes only \/v0\/city\/<city>\/mail\/<id>\/reply/);

    const create = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/mail`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: 'secret-token' },
    });
    assert.equal(create.status, 405, 'the bridge carries answers to mail, never new mail');

    const put = await get(`http://127.0.0.1:${bridge.port}/v0/city/gascity/mail/gc-1/reply`, {
      method: 'PUT',
      headers: { [TOKEN_HEADER]: 'secret-token' },
    });
    assert.equal(put.status, 405);
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
