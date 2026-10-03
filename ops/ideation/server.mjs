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
import { resolveSources } from './lib/generator.mjs';
import { scoreIdea } from './lib/scorer.mjs';
import { runIdeationCycle } from './lib/pipeline.mjs';
import { specifierMode, specifyDue } from './lib/specifier.mjs';
import { IdeaStore } from './lib/store.mjs';
import { PRIORITIES, overrideTriage, queueOrder, triageIdea } from './lib/triage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.MERGECREW_REPO ?? path.resolve(HERE, '..', '..');
const HOST = process.env.IDEATION_HOST ?? '127.0.0.1';
const PORT = Number(process.env.IDEATION_PORT ?? 7788);
const INTERVAL_MS = Math.max(1, Number(process.env.IDEATION_INTERVAL_MINUTES ?? 360)) * 60_000;
// How often accepted-but-undispatched ideas are turned into task files.
const SWEEP_MS = Math.max(5, Number(process.env.IDEATION_DISPATCH_SWEEP_SECONDS ?? 15)) * 1000;
const GENERATOR = process.env.IDEA_GENERATOR ?? 'auto';
const LIMIT = Number(process.env.IDEA_LIMIT ?? 12);
// Which rule sets may propose ideas. The service ships product features by
// default; engineering chores are opt-in (IDEA_SOURCES=chores or all).
const SOURCES = resolveSources(process.env.IDEA_SOURCES ?? 'product');
// Stage 2 runs after generation: each new draft is generalized, verified
// against the code, specified and scored before it can reach the swipe gate.
const SPECIFIER = specifierMode();
const SPEC_PER_PASS = Math.max(1, Number(process.env.IDEATION_SPEC_LIMIT ?? 3));
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
  cycleInFlight = runIdeationCycle({ repo: REPO, store, mode: GENERATOR, limit: LIMIT, sources: SOURCES, log })
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

/**
 * Stage 2 for whatever is still a draft, then rank what is ready.
 *
 * Triage re-runs on every prepared card, because it depends on the score the
 * specification produced — ranking before specifying would order the queue by
 * a number the specifier is about to replace.
 */
async function prepare(reason) {
  if (SPECIFIER === 'off') return { specified: [], ranked: 0, skipped: 'specifier off' };
  const specified = await specifyDue(store, { repo: REPO, limit: SPEC_PER_PASS, log });
  const data = await store.read();
  let ranked = 0;
  for (const idea of data.ideas) {
    if (idea.status !== 'pending' || (idea.stage ?? 'draft') !== 'specified') continue;
    await store.setTriage(idea.id, triageIdea(idea));
    ranked += 1;
  }
  if (specified.length || ranked) {
    log(`prepare (${reason}): specified ${specified.filter((s) => s.ok).length}/${specified.length}, ranked ${ranked}`);
  }
  return { specified, ranked };
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
        sources: SOURCES,
        specifier: SPECIFIER,
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
        generator: GENERATOR,
        sources: SOURCES,
        specifier: SPECIFIER,
        executorEnabled: executorEnabled(),
        intervalMinutes: INTERVAL_MS / 60_000,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/ideas') {
      const ideas = await store.list();
      const status = url.searchParams.get('status');
      const stage = url.searchParams.get('stage');
      let filtered = status ? ideas.filter((i) => i.status === status) : ideas;
      if (stage) filtered = filtered.filter((i) => (i.stage ?? 'draft') === stage);
      // Queue order, not raw score: the deck's next card should be the next
      // thing to build, which is what triage decided.
      return json(res, 200, { ideas: queueOrder(filtered) });
    }

    if (req.method === 'GET' && url.pathname === '/api/timeline') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
      const events = await store.timeline({
        limit,
        status: url.searchParams.get('status') ?? undefined,
        kind: url.searchParams.get('kind') ?? undefined,
        id: url.searchParams.get('id') ?? undefined,
      });
      return json(res, 200, { events });
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const body = await readBody(req);
      const { id, decision, comment, by } = body;
      if (typeof id !== 'string' || !['accepted', 'rejected', 'pending'].includes(decision)) {
        return json(res, 400, { error: 'expected {id: string, decision: accepted|rejected|pending}' });
      }
      if (comment !== undefined && (typeof comment !== 'string' || comment.length > 2000)) {
        return json(res, 400, { error: 'comment must be a string of at most 2000 characters' });
      }
      const idea = await store.decide(id, decision, { comment, by: typeof by === 'string' && by ? by : 'human' });
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

    if (req.method === 'POST' && url.pathname === '/api/priority') {
      const body = await readBody(req);
      const { id, priority, reason, by } = body;
      if (typeof id !== 'string' || !PRIORITIES.includes(priority)) {
        return json(res, 400, { error: `expected {id: string, priority: ${PRIORITIES.join('|')}}` });
      }
      const idea = await store.get(id);
      if (!idea) return json(res, 404, { error: `unknown idea ${id}` });
      const triage = overrideTriage(idea, { priority, reason, by: typeof by === 'string' && by ? by : 'human' });
      const updated = await store.setTriage(id, triage);
      await store.recordEvent(id, { kind: 'priority', by: triage.override.by, detail: `${triage.override.automatic.priority ?? '?'} → ${priority}${triage.override.reason ? `: ${triage.override.reason}` : ''}` });
      return json(res, 200, { idea: await store.get(id) ?? updated });
    }

    // Stage 2's human door: a person asks for something by name.
    //
    // Ideas from /api/propose are not exempt from the machine gate: the
    // specifier still verifies them against the code and scores them, which is
    // how "the human asked for it" and "the human is right about it" stay
    // different claims.
    if (req.method === 'POST' && url.pathname === '/api/propose') {
      const body = await readBody(req);
      const { title, rationale, kind, persona, by, evidence, spec } = body;
      if (typeof title !== 'string' || !title.trim() || title.length > 160) {
        return json(res, 400, { error: 'expected {title: string (1-160 chars), rationale?, kind?, persona?, spec?}' });
      }
      const types = ['feature', 'technical', 'refactor'];
      if (kind !== undefined && !types.includes(kind)) {
        return json(res, 400, { error: `kind must be one of ${types.join('|')}` });
      }
      const who = typeof by === 'string' && by ? by : 'human';
      const features = { impact: 32, confidence: 10, effort: 13, risk: 12 };
      const pre = scoreIdea(features);
      const proposed = {
        source: 'human',
        title: title.trim(),
        rationale: typeof rationale === 'string' && rationale.trim() ? rationale.trim().slice(0, 1200) : `Proposed by ${who}.`,
        evidence: Array.isArray(evidence) && evidence.length ? evidence.slice(0, 8).map(String) : [`proposed by: ${who}`],
        effortHint: 'medium',
        kind: kind ?? 'feature',
        persona: typeof persona === 'string' && persona ? persona : null,
        features,
        // The same shape the generator produces, so every downstream stage sees
        // one kind of record: a pre-score the specifier is expected to replace.
        status: 'pending',
        stale: false,
        score: pre.score,
        band: pre.band,
        scoreReasons: pre.reasons,
      };
      const { added } = await store.addMany([{ ...proposed, proposedBy: who }], { by: who });
      const idea = added[0];
      if (spec && typeof spec === 'object' && typeof spec.markdown === 'string') {
        await store.setSpecification(idea.id, {
          spec: { ...spec, markdown: spec.markdown, specifiedBy: who, specifiedAt: new Date().toISOString() },
          verification: null,
          by: who,
        });
      }
      return json(res, 201, { idea: (await store.get(idea.id)) ?? idea });
    }

    // Generation and specification run together: a click that only produced
    // drafts would leave the swipe deck empty and the click looking broken.
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const result = await cycle('api');
      const prepared = await prepare('api');
      const { signals, addedIdeas, ...summary } = result;
      return json(res, result.error ? 500 : 200, {
        ...summary,
        addedTitles: (addedIdeas ?? []).map((i) => i.title),
        specified: prepared.specified.filter((s) => s.ok).length,
        ranked: prepared.ranked,
      });
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
    // Report the port actually bound, not the one requested: with IDEATION_PORT=0
    // the kernel picks, and a log line that says ":0" is a lie an operator (or a
    // test) cannot recover from.
    const bound = server.address().port;
    log(`ideation service on http://${HOST}:${bound} repo=${REPO} ideas=${stats.total} generator=${GENERATOR} sources=${SOURCES.join('+') || 'none'} specifier=${SPECIFIER} executor=${executorEnabled() ? 'on' : 'off'}`);
  });
  if (stats.total === 0) {
    await cycle('cold-start');
    await prepare('cold-start');
  } else {
    // Ideas that already exist still have to be brought up to the swipe gate: a
    // service that restarts and waits six hours to specify the drafts it is
    // holding looks broken from the deck. `prepare` is cheap and idempotent —
    // it only picks up drafts that are still un-specified.
    await prepare('boot');
  }
  // Decisions can arrive from another writer (the mergecrew web app renders the
  // same deck), so sweep the file for accepted-but-undispatched ideas often.
  const sweep = setInterval(() => {
    dispatchAccepted(store, { repo: REPO, stateDir: EXECUTION_DIR, log }).catch((err) =>
      log(`dispatch sweep failed: ${err?.message ?? err}`),
    );
    takeGenerateRequest()
      .then(async (asked) => {
        if (!asked) return null;
        await cycle('requested');
        return prepare('requested');
      })
      .catch((err) => log(`generate request failed: ${err?.message ?? err}`));
  }, SWEEP_MS);
  sweep.unref?.();
  const timer = setInterval(async () => {
    await reconcileExecutions(store, { stateDir: EXECUTION_DIR, log });
    await dispatchAccepted(store, { repo: REPO, stateDir: EXECUTION_DIR, log });
    await cycle('interval');
    await prepare('interval');
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

export { boot, server, store, cycle, prepare };
