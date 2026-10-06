/**
 * Browser scan for hydration mismatches and console errors.
 *
 *   node ops/ci/tools/hydration-scan.mjs [--port 9421] [--out report.json] [url ...]
 *
 * Why this exists: React reports a hydration mismatch (error #418) when the
 * HTML the server rendered disagrees with the HTML the browser renders. The
 * page still *looks* right — React throws the server markup away and re-renders
 * — so the only place the bug is visible is the console. In this app the usual
 * cause is a timestamp: the web container runs in UTC, the operator's browser
 * does not, so `toLocaleString()` renders one string on each side.
 *
 * Unit tests cannot catch that class: jsdom renders in one timezone and never
 * hydrates. A real browser over a running stack can, so that is what this does.
 * It walks a URL list, opens each one in headless Chromium over CDP, and fails
 * if any of them logs a React hydration error, a console error or an uncaught
 * exception. It also fails if the page renders (almost) no text, because a
 * blank page is trivially error-free.
 *
 * Needs a running web container (`docker compose ... up -d web`) and a Chromium
 * binary (`CHROME_PATH` to override). Deliberately not in ops/ci/checks.conf:
 * it depends on the stack being up, and the CI loop has to pass on a bare
 * checkout.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/chromium';

/** Default URLs: the pages an operator actually looks at. */
const DEFAULT_URLS = [
  'http://127.0.0.1:3100/orgs/demo',
  'http://127.0.0.1:3100/orgs/demo/ideas',
  'http://127.0.0.1:3100/orgs/demo/projects/vcs-probe/settings',
  'http://127.0.0.1:3100/orgs/demo/projects/demo-saas/settings',
];

/**
 * Console noise that is not the app's fault. Each entry is a regex tested
 * against the message text; anything not listed fails the scan.
 */
const IGNORED = [
  // Chromium's own DevTools banner, emitted when the port is open.
  /DevTools listening on ws:\/\//,
  /Download the React DevTools/,
];

const HYDRATION = /Minified React error #(418|423|425)|Hydration failed|did not match/i;

function parseArgs(argv) {
  const urls = [];
  let port = Number(process.env.HYDRATION_SCAN_PORT ?? 9421);
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') port = Number(argv[++i]);
    else if (a === '--out') out = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else urls.push(a);
  }
  return { urls: urls.length ? urls : DEFAULT_URLS, port, out };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Free port helper, so a stale scan never blocks a fresh one. */
async function freePort(start) {
  for (let p = start; p < start + 50; p++) {
    const free = await new Promise((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error(`no free port near ${start}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    return new Promise((res) => {
      const n = ++this.id;
      this.pending.set(n, res);
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

async function waitForDevtools(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).Browser ?? 'unknown';
    } catch {
      /* keep polling */
    }
  }
  throw new Error('chromium never exposed its debugging port');
}

async function scanUrl(cdp, url) {
  const errors = [];
  const hydration = [];
  const responses = [];

  const onEvent = (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const text = d?.exception?.description ?? d?.text ?? 'exception';
      errors.push(text.split('\n')[0]);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = msg.params.args
        .map((a) => a.value ?? a.description ?? a.preview?.description ?? '')
        .join(' ')
        .trim();
      if (text) errors.push(text);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(`${msg.params.entry.source}: ${msg.params.entry.text}`);
    } else if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      if (r.status >= 400) responses.push(`${r.status} ${r.url}`);
    }
  };
  cdp.on(onEvent);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Page.navigate', { url });
  // Hydration runs on load; give React time to finish and to report.
  await sleep(3500);

  const res = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const text = (document.body?.innerText ?? '').trim();
      return { title: document.title, chars: text.length, head: text.slice(0, 60) };
    })()`,
    returnByValue: true,
  });
  const page = res.result?.result?.value ?? { title: '', chars: 0, head: '' };

  const kept = [];
  for (const e of errors) {
    if (IGNORED.some((p) => p.test(e))) continue;
    if (HYDRATION.test(e)) hydration.push(e);
    kept.push(e);
  }
  return {
    url,
    title: page.title,
    textChars: page.chars,
    head: page.head,
    errors: kept,
    hydrationErrors: hydration,
    httpErrors: responses,
  };
}

async function main() {
  const { urls, port: wantedPort, out } = parseArgs(process.argv.slice(2));
  const port = await freePort(wantedPort);
  const profile = mkdtempSync(path.join(tmpdir(), 'hydration-scan-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  const results = [];
  try {
    const browser = await waitForDevtools(port);
    console.log(`chromium: ${browser} (port ${port})`);
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new`, { method: 'PUT' })
    ).json();
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);

    for (const url of urls) {
      const r = await scanUrl(cdp, url);
      results.push(r);
      const bad = r.errors.length > 0 || r.textChars < 200;
      console.log(
        `${bad ? 'FAIL' : 'ok  '} ${url}\n     title "${r.title}" text ${r.textChars} chars` +
          (r.httpErrors.length ? `\n     http: ${r.httpErrors.join(', ')}` : '') +
          (r.errors.length ? `\n     errors:\n${r.errors.map((e) => `       - ${e.slice(0, 240)}`).join('\n')}` : ''),
      );
    }
  } finally {
    cdp?.close();
    proc.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }

  const failed = results.filter((r) => r.errors.length > 0 || r.textChars < 200);
  const hydration = results.filter((r) => r.hydrationErrors.length > 0);
  if (out) {
    writeFileSync(out, JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2));
    console.log(`report: ${out}`);
  }
  if (hydration.length) {
    console.log(
      `\nhydration mismatch on ${hydration.length} page(s) — the server HTML and the browser HTML disagree. ` +
        'Usual cause: a timestamp formatted with the runtime zone/locale instead of an explicit one (see apps/web/src/lib/time.ts).',
    );
  }
  console.log(`\n${results.length - failed.length}/${results.length} page(s) clean`);
  process.exit(failed.length ? 1 : 0);
}

await main();
