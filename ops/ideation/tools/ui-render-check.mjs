/**
 * Render check: does the swipe UI actually draw in a real browser?
 *
 * The HTTP tests assert the server responds; they cannot see whether the deck
 * renders, whether app.js throws, or whether a resource 404s. This drives
 * headless chromium over CDP against a running service and fails when the page
 * is blank, when the top card is missing, or when the console has errors.
 *
 *   node ops/ideation/tools/ui-render-check.mjs [url] [out.png] [port]
 *
 * Exits 0 only when the deck rendered and the console stayed clean. It is
 * deliberately NOT part of checks.conf: it needs chromium and a live server, so
 * it is a manual/pre-release gate rather than a per-commit one.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:7788/';
const out = process.argv[3] ?? '/tmp/mergecrew-swipe-ui.png';
const port = Number(process.argv[4] ?? 9333);
const CHROME = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/chromium';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exit(1);
};

const profile = await mkdtemp(path.join(tmpdir(), 'mergecrew-render-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let chromeErr = '';
chrome.stderr.on('data', (b) => {
  chromeErr += b.toString();
});
const cleanup = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', cleanup);

let version = null;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    await sleep(250);
  }
}
if (!version) fail(`chromium devtools endpoint never came up. stderr tail:\n${chromeErr.slice(-2000)}`);

let target;
try {
  target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
} catch {
  target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`)).json();
}
if (!target?.webSocketDebuggerUrl) fail(`could not open a tab: ${JSON.stringify(target).slice(0, 400)}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params?.exceptionDetails?.text ?? 'exception');
  } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
    consoleErrors.push(msg.params.entry.text);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });

let report = null;
const renderDeadline = Date.now() + 20_000;
while (Date.now() < renderDeadline) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(() => {
      const top = document.querySelector('.card.top h3');
      return JSON.stringify({
        title: document.title,
        cards: document.querySelectorAll('.card').length,
        topCard: top ? top.textContent : null,
        bodyText: document.body.innerText.length,
        ci: document.getElementById('ci-pill')?.textContent ?? null,
        generator: document.getElementById('gen-pill')?.textContent ?? null,
      });
    })()`,
    returnByValue: true,
  });
  report = JSON.parse(result.value);
  if (report.cards > 0) break;
  await sleep(300);
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const bytes = Buffer.from(shot.data, 'base64');
await writeFile(out, bytes);
ws.close();

console.log(
  JSON.stringify({ url, browser: version.Browser, ...report, consoleErrors, screenshot: out, bytes: bytes.length }, null, 1),
);

if (!report?.cards) fail(`${url} rendered no cards (body text ${report?.bodyText ?? 0} chars) — the deck never drew`);
if (!report.topCard) fail('no top card in the DOM');
if (consoleErrors.length) fail(`console reported ${consoleErrors.length} error(s): ${consoleErrors.join(' | ')}`);

// The screenshot must exist and be a real PNG, not a truncated write.
if (bytes.length < 5000 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(`screenshot looks wrong (${bytes.length} bytes)`);

cleanup();
console.log(`OK ${report.cards} card(s) rendered, console clean, screenshot ${out}`);
process.exit(0);
