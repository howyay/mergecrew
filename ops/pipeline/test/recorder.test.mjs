/**
 * Tests for the headless-Chromium session recorder.
 *
 * The APNG encoder is tested by re-parsing what it wrote: an animation that
 * only looks right when read by its own author is not evidence of anything, so
 * the test builds its own PNGs, its own chunk reader, and its own CRC.
 *
 * The browser half runs against a real `node:http` fixture when chromium is
 * present, and reports itself skipped (never silently green) when it is not.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as zlib from 'node:zlib';

import { assembleApng, captureSession, recordDemo } from '../lib/recorder.mjs';

const CHROMIUM = process.env.CHROME_PATH ?? '/run/current-system/sw/bin/chromium';
const chromiumSkip = existsSync(CHROMIUM) ? false : `chromium not found at ${CHROMIUM} — set CHROME_PATH to run this test`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ---------------------------------------------------------------- *
 * Independent PNG tooling (deliberately not reusing lib internals)
 * ---------------------------------------------------------------- */

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

/** Minimal 8-bit RGB PNG, filter type 0 on every row. */
function tinyPng(width, height, [r, g, b]) {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Re-read a PNG/APNG from bytes: chunks with their stored CRC kept for checking. */
function readChunks(buf) {
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'file must start with the PNG signature');
  const chunks = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    const storedCrc = buf.readUInt32BE(offset + 8 + length);
    chunks.push({ type, data, storedCrc, offset });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  assert.equal(offset, buf.length, 'no trailing bytes after IEND');
  return chunks;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'recorder-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFrames(dir, specs) {
  const files = [];
  for (let i = 0; i < specs.length; i++) {
    const file = path.join(dir, `src-${i + 1}.png`);
    await writeFile(file, specs[i]);
    files.push(file);
  }
  return files;
}

function idatOf(png) {
  return readChunks(png).find((c) => c.type === 'IDAT').data;
}

function fctlFields(data) {
  return {
    sequence: data.readUInt32BE(0),
    width: data.readUInt32BE(4),
    height: data.readUInt32BE(8),
    xOffset: data.readUInt32BE(12),
    yOffset: data.readUInt32BE(16),
    delayNum: data.readUInt16BE(20),
    delayDen: data.readUInt16BE(22),
    disposeOp: data[24],
    blendOp: data[25],
  };
}

/* ---------------------------------------------------------------- *
 * assembleApng
 * ---------------------------------------------------------------- */

test('assembleApng writes a re-parseable APNG with correct CRCs and one fdAT per extra frame', async (t) => {
  const root = await fixture(t);
  const sources = [tinyPng(4, 3, [255, 0, 0]), tinyPng(4, 3, [0, 255, 0]), tinyPng(4, 3, [0, 0, 255])];
  const frames = await writeFrames(root, sources);
  const out = path.join(root, 'anim.png');

  const result = await assembleApng(frames, out, { delayMs: 250 });

  assert.equal(result.file, out);
  assert.equal(result.frames, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.delayMs, 250);
  assert.equal(result.width, 4);
  assert.equal(result.height, 3);
  assert.equal(result.requested, 3);
  assert.match(result.sampling, /all 3 frame\(s\) used/);

  const buf = await readFile(out);
  assert.equal(result.bytes, buf.length);

  const chunks = readChunks(buf);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND'],
  );

  for (const c of chunks) {
    const expected = crc32(Buffer.concat([Buffer.from(c.type, 'latin1'), c.data]));
    assert.equal(c.storedCrc, expected, `CRC of ${c.type} chunk at byte ${c.offset}`);
  }

  const actl = chunks.find((c) => c.type === 'acTL');
  assert.equal(actl.data.readUInt32BE(0), 3, 'acTL num_frames');
  assert.equal(actl.data.readUInt32BE(4), 0, 'acTL num_plays = loop forever');

  const fctls = chunks.filter((c) => c.type === 'fcTL').map((c) => fctlFields(c.data));
  // Sequence numbers are shared by fcTL and fdAT in emission order, so the
  // fcTLs of frames 0, 1 and 2 are 0, 1 and 3.
  assert.deepEqual(fctls.map((f) => f.sequence), [0, 1, 3]);
  for (const f of fctls) {
    assert.equal(f.width, 4);
    assert.equal(f.height, 3);
    assert.equal(f.xOffset, 0);
    assert.equal(f.yOffset, 0);
    assert.equal(f.delayNum, 250);
    assert.equal(f.delayDen, 1000);
    assert.equal(f.disposeOp, 0);
    assert.equal(f.blendOp, 0);
  }

  // Frame 0's image data is copied verbatim; later frames wrap it in fdAT with
  // their own sequence number in front.
  const source = sources.map(idatOf);
  assert.ok(chunks.find((c) => c.type === 'IDAT').data.equals(source[0]), 'frame 0 IDAT is the source image data');

  const fdats = chunks.filter((c) => c.type === 'fdAT');
  assert.equal(fdats.length, 2);
  fdats.forEach((c, i) => {
    assert.equal(c.data.readUInt32BE(0), [2, 4][i], 'fdAT sequence number continues after its fcTL');
    assert.ok(c.data.subarray(4).equals(source[i + 1]), `fdAT ${i + 1} payload is frame ${i + 2}'s image data`);
  });
  // The full sequence ledger has no gaps and no repeats.
  const ledger = chunks.filter((c) => c.type === 'fcTL' || c.type === 'fdAT').map((c) => c.data.readUInt32BE(0));
  assert.deepEqual(ledger, [0, 1, 2, 3, 4]);
});

test('assembleApng samples evenly when maxFrames is smaller than the frame list', async (t) => {
  const root = await fixture(t);
  const colours = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [0, 255, 255],
  ];
  const frames = await writeFrames(root, colours.map((c) => tinyPng(3, 3, c)));
  const out = path.join(root, 'sampled.png');

  const result = await assembleApng(frames, out, { maxFrames: 2 });

  assert.equal(result.frames, 2);
  assert.equal(result.skipped, 3);
  assert.equal(result.requested, 5);
  assert.match(result.sampling, /even sampling: kept 2 of 5/);

  const chunks = readChunks(await readFile(out));
  assert.equal(chunks.find((c) => c.type === 'acTL').data.readUInt32BE(0), 2);
  const first = idatOf(tinyPng(3, 3, colours[0]));
  const last = idatOf(tinyPng(3, 3, colours[4]));
  assert.ok(chunks.find((c) => c.type === 'IDAT').data.equals(first), 'first frame kept');
  assert.ok(chunks.find((c) => c.type === 'fdAT').data.subarray(4).equals(last), 'last frame kept');
});

test('assembleApng refuses frames whose IHDR differs, naming the frame and the field', async (t) => {
  const root = await fixture(t);
  const frames = await writeFrames(root, [tinyPng(4, 3, [1, 2, 3]), tinyPng(5, 3, [1, 2, 3])]);
  const out = path.join(root, 'mismatch.png');

  await assert.rejects(assembleApng(frames, out), (err) => {
    assert.match(err.message, /frame 2/);
    assert.match(err.message, /different width \(5 vs 4 in frame 1\)/);
    return true;
  });
  assert.equal(existsSync(out), false, 'a rejected assembly must not leave a half-written animation');
});

test('assembleApng rejects inputs it cannot honestly assemble', async (t) => {
  const root = await fixture(t);
  const good = await writeFrames(root, [tinyPng(2, 2, [9, 9, 9])]);

  await assert.rejects(assembleApng([], path.join(root, 'a.png')), /frames must be a non-empty array/);
  await assert.rejects(assembleApng(good, path.join(root, 'b.png'), { maxFrames: 0 }), /maxFrames must be a positive number/);
  await assert.rejects(assembleApng(good, path.join(root, 'c.png'), { delayMs: 70_000 }), /delayMs must be between 0 and 65535/);
  await assert.rejects(assembleApng([path.join(root, 'missing.png')], path.join(root, 'd.png')), /frame 1 unreadable/);

  const notPng = path.join(root, 'not.png');
  await writeFile(notPng, Buffer.from('definitely not a png'));
  await assert.rejects(assembleApng([notPng], path.join(root, 'e.png')), /not a PNG \(bad signature\)/);

  const headerOnly = path.join(root, 'header-only.png');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  await writeFile(headerOnly, Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]));
  await assert.rejects(assembleApng([headerOnly], path.join(root, 'f.png')), /no IDAT chunks/);
});

/* ---------------------------------------------------------------- *
 * Fixture server and the real browser
 * ---------------------------------------------------------------- */

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Recorder Fixture</title></head>
<body>
<main>
  <h1 id="count">0</h1>
  <button id="bump">bump</button>
</main>
<script>
  let n = 0;
  setInterval(() => { n += 1; document.getElementById('count').textContent = String(n); }, 100);
  document.getElementById('bump').addEventListener('click', () => { document.body.dataset.clicked = 'yes'; });
  setTimeout(() => { const el = document.createElement('p'); el.id = 'late'; el.textContent = 'arrived'; document.body.appendChild(el); }, 300);
</script>
</body></html>
`;

async function serveFixture(t) {
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(tinyPng(1, 1, [0, 0, 0]));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

/** A port nobody else in this suite is using. */
let nextPort = 9400 + Math.floor(Math.random() * 200);
const uniquePort = () => nextPort++;

test('captureSession records a real page, keeps going after a failing step, and reports honestly', { skip: chromiumSkip }, async (t) => {
  const root = await fixture(t);
  const url = await serveFixture(t);
  const outDir = path.join(root, 'session');

  const result = await captureSession({
    url,
    outDir,
    port: uniquePort(),
    timeoutMs: 30_000,
    steps: [
      { name: 'page has main', action: 'expect', selector: 'main' },
      { name: 'document title', action: 'eval', expression: 'document.title' },
      { name: 'title matches', action: 'expect', selector: 'title', text: 'Recorder Fixture' },
      { name: 'click the button', action: 'click', selector: '#bump' },
      { name: 'repaint', action: 'wait', ms: 400 },
      { name: 'late element arrives', action: 'waitFor', selector: '#late', timeoutMs: 5_000 },
      { name: 'page throws asynchronously', action: 'eval', expression: "setTimeout(() => { throw new Error('boom-from-page') }, 0); 'scheduled'" },
      { name: 'let the throw land', action: 'wait', ms: 300 },
      { name: 'missing element fails', action: 'expect', selector: '#nope' },
      { name: 'later steps still run', action: 'eval', expression: '1 + 2' },
    ],
  });

  assert.equal(result.outDir, outDir);
  assert.equal(result.framesDir, path.join(outDir, 'frames'));

  // Steps: a failure is recorded, it does not abort the run.
  assert.equal(result.steps.length, 10);
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'fail', 'pass'],
  );
  assert.equal(result.steps[1].evidence, 'Recorder Fixture', 'eval evidence is the stringified value');
  assert.match(result.steps[5].evidence, /#late appeared after \d+ms/);
  assert.match(result.steps[8].evidence, /expected #nope to exist, but it is not in the DOM/);
  assert.match(result.steps[9].evidence, /^3$/);
  assert.equal(result.ok, false, 'a failed step must make the session not ok');

  // Evidence on disk.
  assert.equal(result.title, 'Recorder Fixture');
  assert.ok(result.frames.length >= 2, `expected at least 2 screencast frames, got ${result.frames.length}`);
  const headers = [];
  for (const frame of result.frames) {
    assert.ok(path.isAbsolute(frame.file));
    const bytes = await readFile(frame.file);
    assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${frame.file} is a PNG`);
    assert.ok(Number.isFinite(frame.at));
    headers.push(readChunks(bytes).find((c) => c.type === 'IHDR').data);
  }
  // Every kept frame must be mixable: same IHDR, or no APNG can be built.
  for (const header of headers) assert.ok(header.equals(headers[0]), 'all kept frames share one IHDR');
  for (const dropped of result.droppedFrames) {
    // A dropped frame is one the surface produced in another format while it
    // was still settling; it must be reported with both formats, not silently
    // discarded, and it must not share the kept frames' format.
    assert.match(dropped.reason, /while the session settled into/);
    assert.equal(typeof dropped.format, 'string');
    assert.equal(dropped.settledFormat, `${headers[0].readUInt32BE(0)}x${headers[0].readUInt32BE(4)}/depth${headers[0][8]}/colour${headers[0][9]}`);
    assert.notEqual(dropped.format, dropped.settledFormat);
  }
  // The frame directory holds exactly the animation — a dropped frame is
  // deleted, not left behind for a reviewer to trip over.
  assert.deepEqual(
    (await readdir(result.framesDir)).sort(),
    result.frames.map((frame) => path.basename(frame.file)).sort(),
  );
  for (const step of result.steps) {
    assert.ok(step.screenshot, `step "${step.name}" kept a screenshot`);
    const shot = await readFile(step.screenshot);
    assert.ok(shot.subarray(0, 8).equals(PNG_SIGNATURE), `${step.screenshot} is a PNG`);
  }

  // Console errors are collected from the page, not from chromium's stderr.
  assert.ok(
    result.consoleErrors.some((e) => e.kind === 'exception' && e.text.includes('boom-from-page')),
    `expected the page exception in consoleErrors, got ${JSON.stringify(result.consoleErrors)}`,
  );
});

test('captureSession can assemble its frames into a demo a reviewer can open', { skip: chromiumSkip }, async (t) => {
  const root = await fixture(t);
  const url = await serveFixture(t);
  const outDir = path.join(root, 'demo');

  const demo = await recordDemo({
    url,
    outDir,
    port: uniquePort(),
    title: 'fixture demo',
    steps: [
      { name: 'page has main', action: 'expect', selector: 'main' },
      // Without a repaint there is only one frame, and one frame is not a demo:
      // the fixture animates, so waiting is what makes the recording reviewable.
      { name: 'let the page animate', action: 'wait', ms: 600 },
    ],
  });

  assert.equal(demo.ok, true);
  assert.equal(demo.apng, path.join(outDir, 'fixture-demo.png'));
  assert.equal(demo.demo, path.join(outDir, 'index.html'));
  assert.equal(demo.error, null);

  const chunks = readChunks(await readFile(demo.apng));
  assert.equal(chunks.find((c) => c.type === 'acTL').data.readUInt32BE(0), demo.frames.length);
  // Chromium splits a frame into several IDAT chunks, and each one becomes an
  // fdAT, so the expected count comes from the source frames, not from a guess.
  const sources = await Promise.all(demo.frames.map((f) => readFile(f.file)));
  const idatCounts = sources.map((buf) => readChunks(buf).filter((c) => c.type === 'IDAT').length);
  assert.equal(chunks.filter((c) => c.type === 'IDAT').length, idatCounts[0]);
  assert.equal(chunks.filter((c) => c.type === 'fdAT').length, idatCounts.slice(1).reduce((a, b) => a + b, 0));
  assert.ok(chunks.filter((c) => c.type === 'fdAT').length >= demo.frames.length - 1);

  const html = await readFile(demo.demo, 'utf8');
  assert.match(html, /page has main/);
  assert.match(html, /fixture-demo\.png/);
});

test('captureSession reports a missing browser instead of pretending to record', async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    captureSession({
      url: 'http://127.0.0.1:1/',
      outDir: path.join(root, 'nope'),
      chromiumPath: path.join(root, 'chromium-does-not-exist'),
      port: uniquePort(),
      timeoutMs: 3_000,
    }),
    (err) => {
      assert.equal(err.code, 'chromium-missing');
      assert.match(err.message, /chromium could not be started/);
      return true;
    },
  );
});
