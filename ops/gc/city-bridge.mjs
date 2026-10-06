#!/usr/bin/env node
/**
 * city-bridge — let the containerised stack read the host's Gas City supervisor.
 *
 * The supervisor binds `127.0.0.1:8372`. Nothing inside a container can reach a
 * loopback address on the host, so every `/v1/orgs/:slug/admin/city/*` route
 * answers `500 Gas City is not reachable at http://127.0.0.1:8372`, and the Gas
 * City tab renders "unavailable" cards next to a perfectly healthy database.
 *
 * Rebinding the supervisor is not an option: it is where the operator's agents
 * live, it exposes no bind flag, and the same port serves write routes
 * (`bead/{id}/close`, `mail`, `session/{id}/respond`) that must never be
 * reachable from a container network. So this bridge listens on the host's
 * default-route address — the one `host.containers.internal` resolves to, see
 * `docs/03-infrastructure/08-gas-city-integration.md` — and forwards a short,
 * named list of paths.
 *
 * Two classes of path, and the difference matters:
 *
 *   reads   `status`, `agents`, `sessions`, `usage`, `rigs` — open to whoever can
 *           reach the bridge, which is what the product's city pages need.
 *   the mail `mail` (read) plus `mail/<id>/reply|read|mark-unread|archive`
 *           (write) — the agents' messages to a human. This bridge binds the
 *           host's LAN address, so these paths stay closed unless the caller
 *           presents `CITY_BRIDGE_TOKEN` in the `x-city-bridge-token` header.
 *           With no token configured the mailbox is closed, not open.
 *
 * Usage:
 *   node ops/gc/city-bridge.mjs                    # bind auto, 8373 → 127.0.0.1:8372
 *   node ops/gc/city-bridge.mjs --check            # probe the supervisor once, exit 0/1
 *   node ops/gc/city-bridge.mjs --bind 10.0.0.119  # name the address explicitly
 *   CITY_BRIDGE_TOKEN=… node ops/gc/city-bridge.mjs  # open the mailbox to the API
 *
 * Flags: --bind <auto|ADDR|0.0.0.0>  --port <n>  --target <url>  --city <name>
 *        --allow <a,b,...>  --writes <a,b,...>  --token <secret>
 *        --check  --quiet  --verbose  --help
 *
 * Exit codes: 0 ok · 1 the supervisor did not answer (--check) · 2 bad usage.
 */
import http from 'node:http';
import dgram from 'node:dgram';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TARGET = 'http://127.0.0.1:8372';
export const DEFAULT_PORT = 8373;
export const DEFAULT_CITY = 'gascity';

/** The header a caller presents to reach the mailbox. */
export const TOKEN_HEADER = 'x-city-bridge-token';

/**
 * Exactly the resources `CityService` reads (apps/api/src/modules/city/city.service.ts):
 * `status`, `agents`, `sessions`, `usage`, `rigs`, `mail`. Everything else the
 * supervisor serves — including every write route but the four mail ones below —
 * is refused by the bridge.
 */
export const DEFAULT_ALLOW = ['status', 'agents', 'sessions', 'usage', 'rigs', 'mail'];

/**
 * Reads that are somebody's private correspondence rather than a counter. The
 * mailbox holds what the city's agents said to a human, so it needs the token
 * even though it is a read.
 */
export const PRIVATE_READS = new Set(['mail']);

/**
 * The only writes this bridge will carry: answering a message, and putting it
 * away. There is deliberately no route to *create* mail, close a bead or answer
 * a session prompt — those stay on the host, where `gc` is.
 */
export const DEFAULT_WRITES = ['mail/:id/reply', 'mail/:id/read', 'mail/:id/mark-unread', 'mail/:id/archive'];

/** `/v0/city/<city>/<resource>` → `{ city, resource }`, or null. */
export function readTarget(pathname, allow = DEFAULT_ALLOW) {
  const match = /^\/v0\/city\/([^/]+)\/([a-z0-9_-]+)$/.exec(pathname);
  if (!match) return null;
  const [, city, resource] = match;
  if (!allow.includes(resource)) return null;
  return { city, resource };
}

/**
 * `/v0/city/<city>/mail/<id>/<action>` → `{ city, id, action }`, or null.
 *
 * The id is held to a conservative character set on purpose: an encoded slash in
 * an id would travel through this proxy untouched and be decoded by whatever
 * reads it next, which is exactly how a narrow allowlist stops being narrow.
 */
export function writeTarget(pathname, writes = DEFAULT_WRITES) {
  const match = /^\/v0\/city\/([^/]+)\/mail\/([A-Za-z0-9._-]{1,128})\/([a-z-]+)$/.exec(pathname);
  if (!match) return null;
  const [, city, id, action] = match;
  if (!writes.includes(`mail/:id/${action}`)) return null;
  return { city, id, action };
}

/** Constant-time token check. No configured token means nothing is accepted. */
function tokenAccepted(headers, secret) {
  if (!secret) return false;
  const raw = headers?.[TOKEN_HEADER];
  const given = Array.isArray(raw) ? raw[0] : raw;
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const HOST_ONLY_HINT = 'Everything else stays on the host: reach it with the city CLI.';

function readDenied(allow) {
  return `city-bridge forwards only ${allow.map((r) => `/v0/city/<city>/${r}`).join(', ')}.`;
}

function writeDenied(writes) {
  const listed = writes.map((w) => `/v0/city/<city>/${w.replace(':id', '<id>')}`).join(', ');
  return `city-bridge writes only ${listed}.`;
}

function closedDenied(resource, secret) {
  const why = secret
    ? `the caller did not present a matching ${TOKEN_HEADER} header.`
    : `the bridge has no CITY_BRIDGE_TOKEN, so ${resource} stays closed.`;
  return `${resource} is not open to the network: ${why}`;
}

/** The address containers reach the host on: the one the default route uses. */
export function defaultRouteAddress({ timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (value) => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    socket.once('error', () => {
      clearTimeout(timer);
      done(null);
    });
    try {
      // No packet is sent: connect() only selects the route, which is what we
      // want the local address of.
      socket.connect(53, '1.1.1.1', () => {
        clearTimeout(timer);
        const address = socket.address()?.address ?? null;
        done(address && address !== '0.0.0.0' ? address : null);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/** `auto` → the default-route address plus loopback, deduplicated. */
export async function bindAddresses(bind) {
  if (bind && bind !== 'auto') return [bind];
  const route = await defaultRouteAddress();
  return route ? [route, '127.0.0.1'] : ['127.0.0.1'];
}

/**
 * Headers worth forwarding: everything but hop-by-hop headers, the caller's
 * credentials — the bridge token is between the caller and this process, and the
 * supervisor needs no `authorization` — and the `host` it was addressed with.
 */
function forwardHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name === 'host' || name === 'connection' || name === 'transfer-encoding') continue;
    if (name === 'authorization' || name === TOKEN_HEADER) continue;
    if (name === 'content-length' && value === '0') continue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function reply(res, status, message) {
  const body = `${message}\n`;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Start the bridge. Returns `{ addresses, close() }`.
 *
 * Each bind address gets its own server so the log can name what is actually
 * listening — `auto` binds two (the container-facing one and loopback).
 */
export async function startBridge({
  bind = 'auto',
  port = DEFAULT_PORT,
  target = DEFAULT_TARGET,
  city = DEFAULT_CITY,
  allow = DEFAULT_ALLOW,
  writes = DEFAULT_WRITES,
  token = process.env.CITY_BRIDGE_TOKEN ?? '',
  log = () => {},
} = {}) {
  const upstream = new URL(target.endsWith('/') ? target.slice(0, -1) : target);
  const addresses = await bindAddresses(bind);
  const secret = String(token ?? '').trim();

  /** Pipe one accepted request upstream. The method and body are never rewritten. */
  const forward = (req, res, url) => {
    const request = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: forwardHeaders({ ...req.headers, host: upstream.host }),
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers));
        response.pipe(res);
        response.on('end', () => log(`${response.statusCode} ${req.method} ${url.pathname}`));
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error('the supervisor did not answer within 10s')));
    request.on('error', (err) => {
      log(`502 ${req.method} ${url.pathname} (${err.message})`);
      if (!res.headersSent) reply(res, 502, `the supervisor at ${upstream.origin} did not answer: ${err.message}`);
      else res.end();
    });
    req.pipe(request);
  };

  const handle = (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'bridge'}`);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const read = readTarget(url.pathname, allow);
      if (!read) {
        log(`403 ${req.method} ${url.pathname} (not on the read allowlist)`);
        return reply(res, 403, `${readDenied(allow)}\n${HOST_ONLY_HINT}`);
      }
      if (PRIVATE_READS.has(read.resource) && !tokenAccepted(req.headers, secret)) {
        log(`403 ${req.method} ${url.pathname} (private read, no token)`);
        return reply(res, 403, closedDenied(read.resource, secret));
      }
      return forward(req, res, url);
    }

    if (req.method === 'POST') {
      const write = writeTarget(url.pathname, writes);
      if (!write) {
        if (readTarget(url.pathname, allow)) {
          log(`405 POST ${url.pathname} (that path is a read)`);
          return reply(res, 405, 'city-bridge forwards reads (GET/HEAD) and the mailbox writes (POST).');
        }
        log(`403 POST ${url.pathname} (not on the write allowlist)`);
        return reply(res, 403, `${writeDenied(writes)}\n${HOST_ONLY_HINT}`);
      }
      if (!tokenAccepted(req.headers, secret)) {
        log(`403 POST ${url.pathname} (write, no token)`);
        return reply(res, 403, closedDenied(`mail/${write.action}`, secret));
      }
      return forward(req, res, url);
    }

    log(`405 ${req.method} ${url.pathname} (only reads and the mailbox writes)`);
    return reply(res, 405, 'city-bridge forwards reads (GET/HEAD) and the mailbox writes (POST).');
  };

  const servers = [];
  for (const address of addresses) {
    const server = http.createServer(handle);
    server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, resolve);
    });
    servers.push({ address, server, port: server.address().port });
  }
  log(
    `listening on ${servers.map(({ address, port: bound }) => `${address}:${bound}`).join(', ')} → ${upstream.origin}` +
      ` (reads: ${allow.join(', ')}; writes: ${writes.join(', ')}; city ${city};` +
      ` mailbox ${secret ? 'token-gated' : 'closed, no CITY_BRIDGE_TOKEN'})`,
  );

  return {
    addresses: servers.map(({ address }) => address),
    ports: servers.map(({ port: bound }) => bound),
    port: servers[0].port,
    async close() {
      await Promise.all(
        servers.map(
          ({ server }) =>
            new Promise((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections?.();
            }),
        ),
      );
    },
  };
}

/** One probe of `/v0/city/<city>/status` on the target. */
export async function checkSupervisor({ target = DEFAULT_TARGET, city = DEFAULT_CITY, timeoutMs = 5000 } = {}) {
  const base = target.endsWith('/') ? target.slice(0, -1) : target;
  const url = `${base}/v0/city/${encodeURIComponent(city)}/status`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    return { ok: response.ok, status: response.status, url, bytes: Buffer.byteLength(body), error: undefined };
  } catch (err) {
    return { ok: false, status: 0, url, bytes: 0, error: err?.message ?? String(err) };
  }
}

const USAGE = `city-bridge — bridge from the containerised stack to the host's Gas City supervisor

  node ops/gc/city-bridge.mjs [--bind auto] [--port 8373]
                             [--target http://127.0.0.1:8372] [--city gascity]
                             [--allow status,agents,sessions,usage,rigs,mail]
                             [--writes mail/:id/reply,mail/:id/read,mail/:id/mark-unread,mail/:id/archive]
                             [--token <secret>] [--check] [--quiet] [--verbose]

--bind auto  binds the host's default-route address plus 127.0.0.1, because that
             is the address a container reaches the host on
             (host.containers.internal → that address, verified on podman/pasta).
--token      the shared secret the mailbox needs. Reads of \`mail\` and all four
             mail writes are refused without it, and with no token configured the
             mailbox is closed rather than open. Also read from CITY_BRIDGE_TOKEN;
             never logged.
--check      probes the supervisor once and exits 0 (reachable) or 1 (not), so a
             unit or a gate can call it without starting a proxy.`;

function parseArgs(argv) {
  const options = {
    bind: 'auto',
    port: Number(process.env.CITY_BRIDGE_PORT ?? DEFAULT_PORT),
    target: process.env.CITY_BRIDGE_TARGET ?? DEFAULT_TARGET,
    city: process.env.CITY_BRIDGE_CITY ?? DEFAULT_CITY,
    allow: DEFAULT_ALLOW,
    writes: DEFAULT_WRITES,
    token: process.env.CITY_BRIDGE_TOKEN ?? '',
    check: false,
    quiet: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--bind':
        options.bind = value();
        break;
      case '--port':
        options.port = Number(value());
        break;
      case '--target':
        options.target = value();
        break;
      case '--city':
        options.city = value();
        break;
      case '--allow':
        options.allow = value()
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case '--writes':
        options.writes = value()
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case '--token':
        options.token = value();
        break;
      case '--check':
        options.check = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error(`--port must be a port number, got ${options.port}`);
  }
  if (options.allow.length === 0) throw new Error('--allow cannot be empty');
  if (options.writes.length === 0) throw new Error('--writes cannot be empty');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const log = (line) => {
    if (!options.quiet) console.log(`city-bridge: ${line}`);
  };

  if (options.check) {
    const probe = await checkSupervisor({ target: options.target, city: options.city });
    if (probe.ok) {
      log(`supervisor answered HTTP ${probe.status} (${probe.bytes} bytes) at ${probe.url}`);
      return 0;
    }
    log(`supervisor did NOT answer at ${probe.url}: ${probe.error ?? `HTTP ${probe.status}`}`);
    return 1;
  }

  const bridge = await startBridge({ ...options, log });
  const stop = async (signal) => {
    log(`${signal}: closing`);
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  return new Promise(() => {});
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => {
      if (typeof code === 'number') process.exit(code);
    })
    .catch((err) => {
      console.error(`city-bridge: ${err?.message ?? err}`);
      console.error(USAGE);
      process.exit(2);
    });
}
