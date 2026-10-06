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
 * (`bead/{id}/close`, `mail/{id}/reply`, `session/{id}/respond`) that must never
 * be reachable from a container network. So this bridge listens on the host's
 * default-route address — the one `host.containers.internal` resolves to, see
 * `docs/03-infrastructure/08-gas-city-integration.md` — and forwards **only**
 * the read paths the product actually asks for.
 *
 * Usage:
 *   node ops/gc/city-bridge.mjs                    # bind auto, 8373 → 127.0.0.1:8372
 *   node ops/gc/city-bridge.mjs --check            # probe the supervisor once, exit 0/1
 *   node ops/gc/city-bridge.mjs --bind 10.0.0.119  # name the address explicitly
 *
 * Flags: --bind <auto|ADDR|0.0.0.0>  --port <n>  --target <url>  --city <name>
 *        --allow <a,b,...>  --check  --quiet  --verbose  --help
 *
 * Exit codes: 0 ok · 1 the supervisor did not answer (--check) · 2 bad usage.
 */
import http from 'node:http';
import dgram from 'node:dgram';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TARGET = 'http://127.0.0.1:8372';
export const DEFAULT_PORT = 8373;
export const DEFAULT_CITY = 'gascity';

/**
 * Exactly the resources `CityService` reads (apps/api/src/modules/city/city.service.ts):
 * `status`, `agents`, `sessions`, `usage`, `rigs`. Everything else the supervisor
 * serves — including every write route — is refused by the bridge.
 */
export const DEFAULT_ALLOW = ['status', 'agents', 'sessions', 'usage', 'rigs'];

/** `/v0/city/<city>/<resource>` → `{ city, resource }`, or null. */
export function readTarget(pathname, allow = DEFAULT_ALLOW) {
  const match = /^\/v0\/city\/([^/]+)\/([a-z0-9_-]+)$/.exec(pathname);
  if (!match) return null;
  const [, city, resource] = match;
  if (!allow.includes(resource)) return null;
  return { city, resource };
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

/** Headers worth forwarding: everything but hop-by-hop and the client's auth. */
function forwardHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name === 'host' || name === 'connection' || name === 'transfer-encoding') continue;
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
  log = () => {},
} = {}) {
  const upstream = new URL(target.endsWith('/') ? target.slice(0, -1) : target);
  const addresses = await bindAddresses(bind);

  const handle = (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'bridge'}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      log(`${405} ${req.method} ${url.pathname} (only reads are bridged)`);
      return reply(res, 405, 'city-bridge only forwards reads (GET/HEAD).');
    }
    const read = readTarget(url.pathname, allow);
    if (!read) {
      log(`403 ${req.method} ${url.pathname} (not on the read allowlist)`);
      return reply(
        res,
        403,
        `city-bridge forwards only ${allow.map((r) => `/v0/city/<city>/${r}`).join(', ')}.\n` +
          'Write routes stay on the host: reach them with the city CLI.',
      );
    }

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
      ` (reads: ${allow.join(', ')}; city ${city})`,
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

const USAGE = `city-bridge — read-only bridge to the host's Gas City supervisor

  node ops/gc/city-bridge.mjs [--bind auto] [--port 8373]
                             [--target http://127.0.0.1:8372] [--city gascity]
                             [--allow status,agents,sessions,usage,rigs]
                             [--check] [--quiet] [--verbose]

--bind auto  binds the host's default-route address plus 127.0.0.1, because that
             is the address a container reaches the host on
             (host.containers.internal → that address, verified on podman/pasta).
--check      probes the supervisor once and exits 0 (reachable) or 1 (not), so a
             unit or a gate can call it without starting a proxy.`;

function parseArgs(argv) {
  const options = {
    bind: 'auto',
    port: Number(process.env.CITY_BRIDGE_PORT ?? DEFAULT_PORT),
    target: process.env.CITY_BRIDGE_TARGET ?? DEFAULT_TARGET,
    city: process.env.CITY_BRIDGE_CITY ?? DEFAULT_CITY,
    allow: DEFAULT_ALLOW,
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
