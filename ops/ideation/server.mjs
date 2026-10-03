/**
 * Ideation HTTP service: generation timer + swipe API + static UI.
 *
 * Binds 127.0.0.1 by default (IDEATION_HOST to override). The only mutation
 * the UI can cause is a decision plus, for accepted ideas, a dispatcher call —
 * there is no "run arbitrary command" endpoint, on purpose.
 */
import { readFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchAccepted, dispatchIdea, executorEnabled, reconcileExecutions } from './lib/executor.mjs';
import { runIdeationCycle } from './lib/pipeline.mjs';
import { IdeaStore } from './lib/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.MERGECREW_REPO ?? path.resolve(HERE, '..', '..');
const HOST = process.env.IDEATION_HOST ?? '127.0.0.1';
const PORT = Number(process.env.IDEATION_PORT ?? 7788);
const INTERVAL_MS = Math.max(1, Number(process.env.IDEATION_INTERVAL_MINUTES ?? 360)) * 60_000;
// How often accepted-but-undispatched ideas are turned into task files.
const SWEEP_MS = Math.max(5, Number(process.env.IDEATION_DISPATCH_SWEEP_SECONDS ?? 15)) * 1000;
const GENERATOR = process.env.IDEA_GENERATOR ?? 'auto';
const LIMIT = Number(process.env.IDEA_LIMIT ?? 12);
// Overridable so tests can run the real server against a throwaway repo
// without touching this checkout's idea log.
const STATE_FILE = process.env.IDEATION_STATE_FILE ?? path.join(HERE, 'state/ideas.json');
const EXECUTION_DIR = process.env.IDEATION_EXECUTION_DIR ?? path.join(REPO, 'ops/execution');
const PUBLIC_DIR = path.join(HERE, 'public');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const store = new IdeaStore(STATE_FILE);

/**
 * The web app cannot collect repo signals, so its "Generate" button drops this
 * file and we claim it here. Claim first (unlink), then run: if the cycle
 * crashes, the request is already gone and cannot loop forever.
 */
const REQUEST_FILE =
  process.env.IDEATION_REQUEST_FILE ?? path.join(path.dirname(STATE_FILE), 'generate.request');

export async function takeGenerateRequest(file = REQUEST_FILE) {
  try {
    const raw = await readFile(file, 'utf8');
    await unlink(file);
    try {
      return JSON.parse(raw);
    } catch {
      return { at: null, requestedBy: 'unknown', malformed: true };
    }
  } catch {
    return null;
  }
}
const startedAt = Date.now();

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

/**
 * Browsers ask for /favicon.ico unprompted. Answering with a 404 puts a red
 * error in every devtools console and makes a healthy page look broken, so
 * serve the real icon where asked and return an empty 204 otherwise.
 */
const FAVICON_ALIASES = new Set(['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']);

function json(res, code, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req, limitBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function ciSnapshot() {
  try {
    const run = JSON.parse(await readFile(path.join(REPO, 'ops/ci/state/last-run.json'), 'utf8'));
    return {
      status: run.status,
      head: run.head,
      finishedAt: run.finishedAt,
      failed: (run.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.cmd),
      deploy: run.deploy?.status ?? null,
    };
  } catch {
    return null;
  }
}

let cycleInFlight = null;
function cycle(reason) {
  if (cycleInFlight) return cycleInFlight;
  cycleInFlight = runIdeationCycle({ repo: REPO, store, mode: GENERATOR, limit: LIMIT, log })
    .catch((err) => {
      log(`ideation cycle failed: ${err?.stack ?? err}`);
      return { error: String(err?.message ?? err) };
    })
    .finally(() => {
      cycleInFlight = null;
    });
  log(`ideation cycle requested (${reason})`);
  return cycleInFlight;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    // Runner outcome files land while the service is up. Reconcile before any
    // read of the deck, so a refresh shows the real execution status instead of
    // a stale "queued" — regardless of which endpoint the UI happens to call.
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
      await reconcileExecutions(store, { stateDir: EXECUTION_DIR, log });
      await dispatchAccepted(store, { repo: REPO, stateDir: EXECUTION_DIR, log });
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      const stats = await store.stats();
      return json(res, 200, {
        ok: true,
        service: 'mergecrew-ideation',
        pid: process.pid,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        repo: REPO,
        generator: GENERATOR,
        executorEnabled: executorEnabled(),
        ideas: stats.total,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const data = await store.read();
      return json(res, 200, {
        stats: await store.stats(),
        lastGeneration: data.lastGeneration,
        ci: await ciSnapshot(),
        executorEnabled: executorEnabled(),
        intervalMinutes: INTERVAL_MS / 60_000,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/ideas') {
      const ideas = await store.list();
      const status = url.searchParams.get('status');
      const filtered = status ? ideas.filter((i) => i.status === status) : ideas;
      filtered.sort((a, b) => b.score - a.score || String(a.createdAt).localeCompare(String(b.createdAt)));
      return json(res, 200, { ideas: filtered });
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const body = await readBody(req);
      const { id, decision } = body;
      if (typeof id !== 'string' || !['accepted', 'rejected', 'pending'].includes(decision)) {
        return json(res, 400, { error: 'expected {id: string, decision: accepted|rejected|pending}' });
      }
      const idea = await store.decide(id, decision);
      if (!idea) return json(res, 404, { error: `unknown idea ${id}` });

      let dispatched = null;
      if (decision === 'accepted') {
        dispatched = await dispatchIdea(idea, { repo: REPO, stateDir: EXECUTION_DIR, log });
        await store.setExecution(id, dispatched);
      }
      if (decision === 'pending') await store.setExecution(id, { status: 'none', reason: 'decision undone' });
      const updated = await store.get(id);
      return json(res, 200, { idea: updated, dispatched });
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const result = await cycle('api');
      const { signals, addedIdeas, ...summary } = result;
      return json(res, result.error ? 500 : 200, { ...summary, addedTitles: (addedIdeas ?? []).map((i) => i.title) });
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const body = await readFile(path.join(PUBLIC_DIR, file));
      res.writeHead(200, { 'content-type': type, 'content-length': body.length });
      return res.end(body);
    }

    // Browsers probe these unprompted; the icon itself lives at /favicon.svg.
    if (req.method === 'GET' && FAVICON_ALIASES.has(url.pathname)) {
      res.writeHead(204);
      return res.end();
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    log(`request failed ${req.method} ${url.pathname}: ${err?.stack ?? err}`);
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

async function boot() {
  const stats = await store.stats();
  await reconcileExecutions(store, { stateDir: EXECUTION_DIR, log });
  server.listen(PORT, HOST, () => {
    log(`ideation service on http://${HOST}:${PORT} repo=${REPO} ideas=${stats.total} generator=${GENERATOR} executor=${executorEnabled() ? 'on' : 'off'}`);
  });
  if (stats.total === 0) await cycle('cold-start');
  // Decisions can arrive from another writer (the mergecrew web app renders the
  // same deck), so sweep the file for accepted-but-undispatched ideas often.
  const sweep = setInterval(() => {
    dispatchAccepted(store, { repo: REPO, stateDir: EXECUTION_DIR, log }).catch((err) =>
      log(`dispatch sweep failed: ${err?.message ?? err}`),
    );
    takeGenerateRequest()
      .then((asked) => (asked ? cycle('requested') : null))
      .catch((err) => log(`generate request failed: ${err?.message ?? err}`));
  }, SWEEP_MS);
  sweep.unref?.();
  const timer = setInterval(async () => {
    await reconcileExecutions(store, { stateDir: EXECUTION_DIR, log });
    await dispatchAccepted(store, { repo: REPO, stateDir: EXECUTION_DIR, log });
    await cycle('interval');
  }, INTERVAL_MS);
  timer.unref?.();
  const shutdown = () => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  boot().catch((err) => {
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

export { boot, server, store, cycle };
