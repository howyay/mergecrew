/**
 * Session recorder + APNG assembler.
 *
 * The demo video a human watches before approving a change has to be produced
 * on a machine that may have nothing installed but node and chromium. That is
 * the whole reason this file exists in the shape it does: no `puppeteer`, no
 * `ffmpeg`, no `pngjs`. Chromium is driven over the DevTools protocol with the
 * built-in `fetch`/`WebSocket`, and the animation is assembled as an APNG — a
 * plain PNG chunk stream, which is the one animated format a browser plays
 * without help.
 *
 * Two deliberate honesty rules:
 *   - A step that fails never aborts the session (the rest of the demo is still
 *     evidence), but it does make `ok` false.
 *   - A recording with fewer than two frames is reported as not-ok. One frame is
 *     a screenshot; calling it a video would be a lie.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as zlib from 'node:zlib';

const DEFAULT_CHROMIUM = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/chromium';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Step actions this recorder understands; anything else is an explicit failure. */
const KNOWN_ACTIONS = new Set(['eval', 'click', 'wait', 'waitFor', 'expect']);

/** Turn a step name into a filename-safe slug. */
function slug(value) {
  return (
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'step'
  );
}

/** Readable rendering of a `Runtime.evaluate` result for the evidence string. */
function stringifyValue(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** `Runtime.evaluate` error text, when the page expression threw. */
function exceptionText(exceptionDetails) {
  const d = exceptionDetails ?? {};
  return (
    d.exception?.description ??
    d.exception?.value ??
    d.text ??
    `evaluate failed (line ${d.lineNumber ?? '?'})`
  );
}

/* ------------------------------------------------------------------ *
 * CRC32 — `zlib.crc32` when the runtime has it, a table otherwise.
 * A PNG chunk without a correct CRC is not a PNG chunk.
 * ------------------------------------------------------------------ */
let crcTable = null;
function crc32Fallback(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : crc32Fallback;

/** One PNG chunk: length, type, data, CRC over type+data. */
function pngChunk(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** IHDR fields, in file order, so a mismatch can name the offending field. */
const IHDR_FIELDS = ['width', 'height', 'bitDepth', 'colorType', 'compression', 'filter', 'interlace'];

function parseIhdr(data) {
  return {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colorType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  };
}

/** Split a PNG into chunks. Tolerant of nothing: a bad file is an error, not a guess. */
function parsePng(buf, label) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label}: not a PNG (bad signature)`);
  }
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buf.length) throw new Error(`${label}: truncated ${type} chunk at byte ${offset}`);
    chunks.push({ type, data: buf.subarray(start, end) });
    offset = end + 4;
    if (type === 'IEND') break;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) throw new Error(`${label}: missing or malformed IHDR`);
  const idat = chunks.filter((c) => c.type === 'IDAT');
  if (idat.length === 0) throw new Error(`${label}: no IDAT chunks (no image data)`);
  return { ihdr: ihdr.data, header: parseIhdr(ihdr.data), idat };
}

/** Evenly spaced indices that always keep the first and the last frame. */
function sampleIndices(total, maxFrames) {
  if (total <= maxFrames) return Array.from({ length: total }, (_, i) => i);
  return Array.from({ length: maxFrames }, (_, i) => Math.round((i * (total - 1)) / (maxFrames - 1)));
}

/**
 * Assemble an APNG from PNG frames captured by the same browser at the same
 * size.
 *
 * This is legitimate precisely because every frame has an identical IHDR:
 * APNG's `fdAT` chunks are the frame's compressed image data, so a frame can be
 * copied verbatim instead of being decoded and re-encoded. When an IHDR differs
 * the copy would silently produce a corrupt animation, so the mismatch is a
 * hard error naming the frame and the field — never a partial file.
 *
 * @param {Array<string|{file: string}>} frames PNG paths, or `{file}` records.
 * @param {string} outFile destination `.png` (written atomically).
 * @param {{delayMs?: number, maxFrames?: number}} [options]
 * @returns {Promise<{file: string, frames: number, skipped: number, delayMs: number, bytes: number, width: number, height: number, requested: number, sampling: string}>}
 */
export async function assembleApng(frames, outFile, { delayMs = 120, maxFrames = 400 } = {}) {
  const list = (Array.isArray(frames) ? frames : []).map((f) => (typeof f === 'string' ? f : f?.file));
  if (list.length === 0 || list.some((f) => typeof f !== 'string' || !f)) {
    throw new Error('assembleApng: frames must be a non-empty array of PNG paths (or {file} records)');
  }
  if (!Number.isFinite(maxFrames) || maxFrames < 1) {
    throw new Error(`assembleApng: maxFrames must be a positive number, got ${maxFrames}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 65535) {
    throw new Error(`assembleApng: delayMs must be between 0 and 65535 (fcTL delay_num is 16-bit), got ${delayMs}`);
  }

  const indices = sampleIndices(list.length, Math.floor(maxFrames));
  const kept = indices.map((i) => list[i]);
  const skipped = list.length - kept.length;

  const parsed = [];
  for (const index of indices) {
    const file = list[index];
    let buf;
    try {
      buf = await readFile(file);
    } catch (err) {
      throw new Error(`assembleApng: frame ${index + 1} unreadable (${file}): ${err?.message ?? err}`);
    }
    parsed.push({ index, file, ...parsePng(buf, `assembleApng: frame ${index + 1} (${file})`) });
  }

  const first = parsed[0];
  for (const frame of parsed.slice(1)) {
    if (Buffer.compare(frame.ihdr, first.ihdr) === 0) continue;
    const field = IHDR_FIELDS.find((name) => frame.header[name] !== first.header[name]) ?? 'IHDR bytes';
    throw new Error(
      `assembleApng: frame ${frame.index + 1} (${frame.file}) has a different ${field} ` +
        `(${frame.header[field]} vs ${first.header[field]} in frame ${first.index + 1}) — ` +
        'all frames must come from the same browser size and pixel format',
    );
  }

  const width = first.header.width;
  const height = first.header.height;
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', first.ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(kept.length, 0);
  actl.writeUInt32BE(0, 4); // num_plays = 0 → loop forever
  parts.push(pngChunk('acTL', actl));

  let sequence = 0;
  for (let i = 0; i < parsed.length; i++) {
    const frame = parsed[i];
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(sequence++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt32BE(0, 12); // x_offset
    fctl.writeUInt32BE(0, 16); // y_offset
    fctl.writeUInt16BE(Math.round(delayMs), 20); // delay_num, 1/1000 s units
    fctl.writeUInt16BE(1000, 22); // delay_den
    fctl[24] = 0; // dispose_op = NONE (every frame is a full-size key frame)
    fctl[25] = 0; // blend_op = SOURCE
    parts.push(pngChunk('fcTL', fctl));

    if (i === 0) {
      // Frame 0 carries the still image: its IDAT chunks are copied verbatim.
      for (const idat of frame.idat) parts.push(pngChunk('IDAT', idat.data));
    } else {
      // Later frames are animation data: sequence number + the same payload.
      for (const idat of frame.idat) {
        const fdat = Buffer.alloc(4 + idat.data.length);
        fdat.writeUInt32BE(sequence++, 0);
        idat.data.copy(fdat, 4);
        parts.push(pngChunk('fdAT', fdat));
      }
    }
  }
  parts.push(pngChunk('IEND', Buffer.alloc(0)));

  const out = Buffer.concat(parts);
  await mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  await writeFile(tmp, out);
  await rename(tmp, outFile);

  const sampling =
    skipped === 0
      ? `all ${kept.length} frame(s) used`
      : `even sampling: kept ${kept.length} of ${list.length} frame(s) (first and last kept, every ~${(list.length / kept.length).toFixed(1)}th frame)`;

  return {
    file: outFile,
    frames: kept.length,
    skipped,
    delayMs,
    bytes: out.length,
    width,
    height,
    requested: list.length,
    sampling,
  };
}

/* ------------------------------------------------------------------ *
 * CDP plumbing
 * ------------------------------------------------------------------ */

/**
 * Minimal CDP client. A promise per command, plus one event callback — enough
 * for a recorder, and small enough to audit in one sitting.
 */
async function openCdp(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  let closed = false;

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error(`CDP socket already closed, cannot send ${method}`));
        return;
      }
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        reject(new Error(`CDP send ${method} failed: ${err?.message ?? err}`));
      }
    });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message ?? 'CDP error'} (${JSON.stringify(msg.error)})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) onEvent(msg);
  });

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      ws.removeEventListener('open', onOpen);
      reject(new Error(`CDP WebSocket connection to ${wsUrl} failed`));
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });

  return {
    send,
    close() {
      closed = true;
      for (const { reject, method } of pending.values()) {
        reject(new Error(`CDP socket closed before ${method} completed`));
      }
      pending.clear();
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Record a browser session to PNG frames and step evidence.
 *
 * Failure classification matters to the caller: everything that goes wrong
 * while starting the browser (missing binary, no CDP endpoint, no page target)
 * throws — that is an environment problem. Everything that goes wrong inside a
 * step is recorded on that step instead, because a failing step is exactly what
 * the person reviewing the demo needs to see.
 *
 * @returns {Promise<{ok: boolean, url: string, title: string, steps: object[], frames: {file: string, at: number}[], droppedFrames: {at: number, format: string, settledFormat?: string, reason: string}[], durationMs: number, consoleErrors: object[], outDir: string, framesDir: string}>}
 *   `frames` holds absolute paths, in capture order, of the frames that share
 *   one pixel format — the only frames an APNG can mix. `droppedFrames`
 *   records the ones the settling surface produced in another format, so a
 *   short recording is explainable rather than mysterious.
 */
export async function captureSession({
  url,
  outDir,
  steps = [],
  port = 9333,
  chromiumPath = DEFAULT_CHROMIUM,
  viewport = { width: 1280, height: 860 },
  timeoutMs = 30_000,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  if (!url) throw new Error('captureSession: url is required');
  if (!outDir) throw new Error('captureSession: outDir is required');

  const started = Date.now();
  const framesDir = path.join(outDir, 'frames');
  const stepsDir = path.join(outDir, 'steps');
  const profileDir = path.join(outDir, 'profile');
  await mkdir(framesDir, { recursive: true });
  await mkdir(stepsDir, { recursive: true });

  const consoleErrors = [];
  const captured = [];
  const frames = [];
  const droppedFrames = [];
  const frameWrites = [];
  const stepRecords = [];
  let title = '';
  let browserAlive = false;
  let child = null;
  let cdp = null;

  // A recorder that leaves a headless browser behind leaks a process per run.
  const killBrowser = () => {
    if (!child || !browserAlive) return;
    browserAlive = false;
    try {
      process.kill(-child.pid, 'SIGKILL'); // the whole process group
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  };
  const exitGuard = () => killBrowser();
  process.on('exit', exitGuard);

  try {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--no-first-run',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${viewport.width},${viewport.height}`,
    ];
    log(`capture: launching ${chromiumPath} on port ${port}`);
    let stderrTail = '';
    let launchError = null;
    child = spawn(chromiumPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    browserAlive = true;
    child.on('error', (err) => {
      launchError = err;
      browserAlive = false;
    });
    child.stderr?.on('data', (buf) => {
      stderrTail = `${stderrTail}${buf.toString()}`.slice(-2000);
    });
    child.stdout?.on('data', () => {});

    const base = `http://127.0.0.1:${port}`;
    let version = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (launchError) {
        const err = new Error(`chromium could not be started: ${chromiumPath} (${launchError.message})`);
        err.code = 'chromium-missing';
        throw err;
      }
      if (!browserAlive) {
        throw new Error(`chromium exited before the DevTools endpoint was ready (stderr: ${stderrTail.trim() || 'empty'})`);
      }
      try {
        const res = await fetchImpl(`${base}/json/version`);
        if (res.ok) {
          version = await res.json();
          break;
        }
      } catch {
        /* not listening yet */
      }
      await sleep(200);
    }
    if (!version?.webSocketDebuggerUrl) {
      throw new Error(`DevTools endpoint did not answer on ${base}/json/version within ${timeoutMs}ms`);
    }
    log(`capture: ${version.Browser ?? 'chromium'} ready`);

    // `/json/new` takes the URL from the query string. Some Chromium builds
    // create the target without ever committing the navigation (the target
    // reports the right `url` while the document stays `about:blank`), so the
    // committed URL is verified below rather than trusted.
    const newRes = await fetchImpl(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!newRes.ok) {
      throw new Error(`could not open a page target: PUT /json/new returned ${newRes.status}`);
    }
    const target = await newRes.json();
    if (!target?.webSocketDebuggerUrl) {
      throw new Error('could not open a page target: /json/new returned no webSocketDebuggerUrl');
    }

    cdp = await openCdp(target.webSocketDebuggerUrl, (msg) => {
      if (msg.method === 'Page.screencastFrame') {
        const { data, sessionId } = msg.params ?? {};
        const at = Date.now();
        const buf = Buffer.from(data ?? '', 'base64');
        // The captured surface is not stable for the first frames of a session:
        // it can still be the pre-emulation size (1280x739 for a 1280x860
        // request) or carry an alpha channel before the page paints opaque. All
        // frames are written, then reduced to one pixel format below — an
        // animation may not mix IHDRs, and a frame nobody can play is not
        // evidence.
        const key =
          buf.length > 25
            ? `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}/depth${buf[24]}/colour${buf[25]}`
            : 'unreadable';
        const file = path.join(framesDir, `frame-${String(captured.length + 1).padStart(6, '0')}.png`);
        captured.push({ file, at, key });
        frameWrites.push(writeFile(file, buf).catch((err) => log(`capture: frame write failed: ${err?.message ?? err}`)));
        // Without the ack the browser stops sending frames.
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push({
          kind: 'exception',
          at: Date.now(),
          text: exceptionText(msg.params?.exceptionDetails),
        });
        return;
      }
      if (msg.method === 'Log.entryAdded') {
        const entry = msg.params?.entry ?? {};
        if (entry.level === 'error') {
          consoleErrors.push({
            kind: 'log',
            at: Date.now(),
            text: String(entry.text ?? ''),
            source: entry.source ?? null,
            url: entry.url ?? null,
          });
        }
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const currentUrl = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    if (String(currentUrl?.result?.value ?? '') !== url) {
      log(`capture: committing navigation to ${url}`);
      await cdp.send('Page.navigate', { url });
    }

    await cdp.send('Page.startScreencast', {
      format: 'png',
      quality: 90,
      everyNthFrame: 1,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
    });

    // The page may still be loading; give it the load event, but never make the
    // whole session hinge on it — a page that never fires it is still recordable.
    const loadDeadline = Date.now() + Math.min(timeoutMs, 15_000);
    let ready = false;
    while (Date.now() < loadDeadline) {
      const state = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (state?.result?.value === 'complete') {
        ready = true;
        break;
      }
      await sleep(100);
    }
    log(`capture: page ${ready ? 'loaded' : 'did not reach readyState=complete'}`);

    /** Run one `Runtime.evaluate`, turning a page-side throw into a step failure. */
    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (res?.exceptionDetails) throw new Error(exceptionText(res.exceptionDetails));
      return res?.result?.value;
    };

    const domProbe = (selector) =>
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? { exists: true, text: el.textContent } : { exists: false, text: null }; })()`;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] ?? {};
      const name = step.name ?? `${step.action ?? 'step'} #${i + 1}`;
      const action = step.action;
      const screenshot = path.join(stepsDir, `${String(i + 1).padStart(2, '0')}-${slug(name)}.png`);
      let status = 'pass';
      let evidence = '';

      try {
        if (!KNOWN_ACTIONS.has(action)) {
          throw new Error(`unknown action: ${JSON.stringify(action ?? null)} (known: ${[...KNOWN_ACTIONS].join(', ')})`);
        }
        if (action === 'wait') {
          const ms = Math.max(0, Number(step.ms ?? 0));
          await sleep(ms);
          evidence = `waited ${ms}ms`;
        } else if (action === 'eval') {
          const value = await evaluate(String(step.expression ?? ''));
          evidence = stringifyValue(value);
        } else if (action === 'click') {
          const selector = String(step.selector ?? '');
          const value = await evaluate(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
              `if (!el) throw new Error('click target not found: ' + ${JSON.stringify(selector)}); el.click(); return 'clicked ' + ${JSON.stringify(selector)}; })()`,
          );
          evidence = stringifyValue(value);
        } else if (action === 'waitFor') {
          const selector = String(step.selector ?? '');
          const budget = Math.max(0, Number(step.timeoutMs ?? timeoutMs));
          const startedWait = Date.now();
          let found = false;
          while (Date.now() - startedWait <= budget) {
            const probe = await evaluate(domProbe(selector));
            if (probe?.exists) {
              found = true;
              break;
            }
            await sleep(100);
          }
          if (!found) throw new Error(`waitFor timed out after ${budget}ms: no element matches ${selector}`);
          evidence = `${selector} appeared after ${Date.now() - startedWait}ms`;
        } else if (action === 'expect') {
          const selector = String(step.selector ?? '');
          const want = step.exists !== false;
          const probe = await evaluate(domProbe(selector));
          const exists = Boolean(probe?.exists);
          if (exists !== want) {
            throw new Error(want ? `expected ${selector} to exist, but it is not in the DOM` : `expected ${selector} to be absent, but it exists`);
          }
          if (step.text !== undefined) {
            const text = String(probe?.text ?? '');
            if (!text.includes(String(step.text))) {
              throw new Error(`expected ${selector} text to contain ${JSON.stringify(String(step.text))}, got ${JSON.stringify(text.slice(0, 200))}`);
            }
            evidence = `${selector} exists and its text contains ${JSON.stringify(String(step.text))}`;
          } else {
            evidence = want ? `${selector} exists` : `${selector} is absent`;
          }
        }
      } catch (err) {
        status = 'fail';
        evidence = err?.message ?? String(err);
      }

      let screenshotPath = null;
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(screenshot, Buffer.from(shot?.data ?? '', 'base64'));
        screenshotPath = screenshot;
      } catch (err) {
        evidence = `${evidence} [screenshot failed: ${err?.message ?? err}]`;
      }

      stepRecords.push({ name, action, status, evidence, screenshot: screenshotPath });
      log(`capture: ${status} ${name}${status === 'fail' ? ` — ${evidence}` : ''}`);
    }

    if (cdp) {
      const t = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }).catch(() => null);
      title = String(t?.result?.value ?? '');
    }

    await Promise.allSettled(frameWrites);

    // The captured surface takes a moment to settle: the first frames of a
    // session can still be rasterised before the emulated viewport is applied,
    // or before the page paints opaque, so one session can hand back frames in
    // two pixel formats (1280x739 vs 1280x860, colourType 6 vs 2). An APNG may
    // not mix IHDRs — the assembler refuses such a set — so the recording is
    // reduced to one format. The emulated viewport wins when at least two
    // frames reached it (that is the size the steps were written against);
    // otherwise the largest group wins, ties going to the group that appeared
    // later, so a session whose surface never grew still yields a playable
    // animation. The discarded frames are deleted from `frames/` and reported
    // in `droppedFrames`; they are never quietly ignored.
    const wanted = `${viewport.width}x${viewport.height}/`;
    const rank = (group) => (group.key.startsWith(wanted) && group.frames.length >= 2 ? 1 : 0);
    const groups = new Map();
    for (const frame of captured) {
      const group = groups.get(frame.key) ?? { key: frame.key, frames: [], last: 0 };
      group.frames.push(frame);
      group.last = frame.at;
      groups.set(frame.key, group);
    }
    const settled =
      groups.size > 1
        ? [...groups.values()].sort((a, b) => rank(b) - rank(a) || b.frames.length - a.frames.length || b.last - a.last)[0]
        : null;
    for (const frame of captured) {
      if (settled && frame.key !== settled.key) {
        droppedFrames.push({
          at: frame.at,
          format: frame.key,
          settledFormat: settled.key,
          reason: `frame arrived as ${frame.key} while the session settled into ${settled.key}`,
        });
        log(`capture: dropped a ${frame.key} screencast frame (session settled into ${settled.key})`);
        await rm(frame.file, { force: true }).catch(() => {});
        continue;
      }
      frames.push({ file: frame.file, at: frame.at });
    }

    const reason =
      stepRecords.some((s) => s.status === 'fail')
        ? `${stepRecords.filter((s) => s.status === 'fail').length} step(s) failed`
        : frames.length < 2
          ? `only ${frames.length} screencast frame(s) kept${droppedFrames.length ? ` (${droppedFrames.length} dropped: the captured surface kept changing size or pixel format)` : ''} — a page that never repaints has no animation to review`
          : null;
    const ok = reason === null;
    if (!ok) log(`capture: not ok — ${reason}`);

    return {
      ok,
      url,
      title,
      steps: stepRecords,
      frames,
      droppedFrames,
      durationMs: Date.now() - started,
      consoleErrors,
      outDir,
      framesDir,
    };
  } finally {
    try {
      if (cdp) await cdp.send('Page.stopScreencast');
    } catch {
      /* browser may already be gone */
    }
    await Promise.allSettled(frameWrites);
    cdp?.close();
    killBrowser();
    process.removeListener('exit', exitGuard);
  }
}

/** HTML-escape a value for the review page. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Standalone review page: the animation, the steps, and the console errors.
 * Self-contained on purpose — a reviewer opens the file, they do not start a
 * server to look at a demo.
 */
function renderReviewHtml({ title, url, outDir, session, apng, apngFile, error }) {
  const rel = (p) => path.relative(outDir, p) || path.basename(p);
  const stepRows = session.steps
    .map((step, i) => {
      const shot = step.screenshot ? rel(step.screenshot) : null;
      return `<li class="step ${esc(step.status)}">
  <div class="step-head"><span class="badge ${esc(step.status)}">${esc(step.status)}</span> <strong>${i + 1}. ${esc(step.name)}</strong> <code>${esc(step.action)}</code></div>
  <pre class="evidence">${esc(step.evidence)}</pre>
  ${shot ? `<img class="shot" src="${esc(shot)}" alt="step ${i + 1} screenshot">` : '<p class="muted">no screenshot</p>'}
</li>`;
    })
    .join('\n');

  const errors = session.consoleErrors.length
    ? `<ul>${session.consoleErrors.map((e) => `<li><code>${esc(e.kind)}</code> ${esc(e.text)}</li>`).join('')}</ul>`
    : '<p class="muted">none</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} — session review</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .meta { color: #666; margin: 0 0 16px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 700; }
  .badge.pass, .ok { background: #1a7f37; color: #fff; }
  .badge.fail, .failed { background: #b3261e; color: #fff; }
  .badge.ok { background: #1a7f37; }
  video, img.animation { max-width: 100%; border: 1px solid #ccc; border-radius: 6px; }
  ul.steps { list-style: none; padding: 0; }
  li.step { border: 1px solid #ddd; border-left-width: 5px; border-radius: 6px; padding: 10px 14px; margin: 10px 0; }
  li.step.pass { border-left-color: #1a7f37; }
  li.step.fail { border-left-color: #b3261e; }
  pre.evidence { background: #f5f5f5; padding: 8px; border-radius: 4px; white-space: pre-wrap; margin: 8px 0; font-size: 13px; }
  img.shot { max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }
  .muted { color: #777; }
  code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
  @media (prefers-color-scheme: dark) {
    pre.evidence, code { background: #22262b; }
    li.step, img.shot, img.animation { border-color: #3a3f45; }
    .meta, .muted { color: #9aa0a6; }
  }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="meta"><span class="badge ${session.ok && !error ? 'ok' : 'fail'}">${session.ok && !error ? 'ok' : 'not ok'}</span>
 target <a href="${esc(url)}">${esc(url)}</a> · ${session.frames.length} frame(s) · ${(session.durationMs / 1000).toFixed(1)}s ·
 ${esc(session.consoleErrors.length)} console error(s)</p>
${error ? `<p class="failed"><strong>demo assembly failed:</strong> ${esc(error)}</p>` : ''}
${apngFile && !error ? `<p><img class="animation" src="${esc(rel(apngFile))}" alt="recorded session animation (APNG)"></p>` : '<p class="muted">no animation assembled</p>'}
${apng ? `<p class="muted">${apng.frames} frames used, ${apng.skipped} dropped, ${apng.bytes} bytes, ${apng.width}×${apng.height}, ${apng.delayMs}ms/frame — ${esc(apng.sampling)}</p>` : ''}
<h2>Steps</h2>
<ul class="steps">
${stepRows || '<li class="muted">no steps were supplied</li>'}
</ul>
<h2>Console errors</h2>
${errors}
</body>
</html>
`;
}

/**
 * Record a demo and package it for review in one call: session → APNG →
 * standalone HTML player.
 *
 * An assembler failure is reported, not thrown: the frames and step evidence
 * are still valid artefacts, and the caller gets the real reason string instead
 * of a stack trace that hides which part broke.
 *
 * @returns {Promise<{ok: boolean, demo: string|null, apng: string|null, frames: {file: string, at: number}[], droppedFrames: object[], steps: object[], consoleErrors: object[], html: string|null, session: object|null, error: string|null}>}
 *   `demo` and `html` are the same player path (kept as two names because both
 *   are used by callers); `apng` is the animation path.
 */
export async function recordDemo({ url, outDir, steps = [], title = 'demo', ...opts }) {
  const session = await captureSession({ url, outDir, steps, ...opts });
  const apngFile = path.join(outDir, `${slug(title)}.png`);
  const htmlFile = path.join(outDir, 'index.html');
  let apng = null;
  let error = null;

  try {
    apng = await assembleApng(session.frames, apngFile, {
      delayMs: opts.delayMs ?? 120,
      maxFrames: opts.maxFrames ?? 400,
    });
  } catch (err) {
    error = err?.message ?? String(err);
  }

  const html = renderReviewHtml({ title, url, outDir, session, apng, apngFile: apng ? apngFile : null, error });
  await mkdir(outDir, { recursive: true });
  const tmp = `${htmlFile}.tmp`;
  await writeFile(tmp, html, 'utf8');
  await rename(tmp, htmlFile);

  return {
    ok: session.ok && !error,
    demo: htmlFile,
    html: htmlFile,
    apng: apng ? apngFile : null,
    frames: session.frames,
    droppedFrames: session.droppedFrames,
    steps: session.steps,
    consoleErrors: session.consoleErrors,
    session,
    error,
  };
}
