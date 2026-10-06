/**
 * Tests for the UAT verdict machine.
 *
 * No browser here on purpose: the verdict is the part that must never lie, and
 * the cheapest way to prove that is to drive it with injected captures that
 * fail in each of the ways the real world fails — a missing browser, a dead
 * step, a noisy console, a page that never repainted. A test that needed
 * chromium could not check the blocked path at all.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { acceptanceFor, buildUatSpec, runUat, uatMarkdown } from '../lib/uat.mjs';

const IDEA = {
  id: 'idea-7',
  title: 'Dashboard shows the review queue',
  source: 'repo:apps/web/src/app/dashboard/page.tsx',
  rationale: 'Operators cannot see queued reviews from the dashboard.',
  evidence: ['apps/web/src/app/dashboard/page.tsx:42 — no <main> landmark and no queue list'],
  features: { impact: 4, confidence: 3, effort: 2, risk: 1 },
  score: 68,
  band: 'should',
};

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'uat-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A capture stub that echoes the spec's steps back as passing records. */
function captureStub({ consoleErrors = [], frameCount = 3, title = 'Stub Page', failStep = null, url } = {}) {
  const calls = [];
  const capture = async (options) => {
    calls.push(options);
    return {
      ok: failStep === null && consoleErrors.length === 0 && frameCount >= 2,
      url: options.url,
      title,
      steps: options.steps.map((step, i) => ({
        name: step.name,
        action: step.action,
        status: step.name === failStep ? 'fail' : 'pass',
        evidence: step.name === failStep ? `expected ${step.selector} to exist, but it is not in the DOM` : `${step.action} ok`,
        screenshot: path.join(options.outDir, 'steps', `${i + 1}-step.png`),
      })),
      frames: Array.from({ length: frameCount }, (_, i) => ({ file: path.join(options.outDir, 'frames', `frame-${i + 1}.png`), at: Date.now() })),
      durationMs: 12,
      consoleErrors,
      outDir: options.outDir,
      framesDir: path.join(options.outDir, 'frames'),
      ...(url ? { url } : {}),
    };
  };
  capture.calls = calls;
  return capture;
}

const assembleStub = async (frames, outFile) => ({ file: outFile, frames: frames.length, skipped: 0, delayMs: 120, bytes: 1234, width: 1280, height: 860, sampling: 'all frame(s) used' });

/* ---------------------------------------------------------------- *
 * buildUatSpec / acceptanceFor
 * ---------------------------------------------------------------- */

test('buildUatSpec always asserts a rendered page, a clean console, and the caller steps', () => {
  const spec = buildUatSpec(IDEA, { url: 'http://127.0.0.1:3000/dashboard', steps: [{ name: 'queue visible', action: 'expect', selector: '#queue' }] });

  assert.equal(spec.version, 1);
  assert.equal(spec.id, 'uat-idea-7');
  assert.equal(spec.url, 'http://127.0.0.1:3000/dashboard');
  assert.deepEqual(spec.idea, { id: 'idea-7', title: IDEA.title, source: IDEA.source, band: 'should', score: 68, rationale: IDEA.rationale, evidence: IDEA.evidence });

  // The two mandated steps come first: the page must exist and must be visible.
  assert.equal(spec.steps.length, 3);
  assert.deepEqual(spec.steps[0], { name: 'target URL renders a visible <main>', action: 'expect', selector: 'main', exists: true });
  assert.equal(spec.steps[1].action, 'eval');
  assert.match(spec.steps[1].expression, /querySelector\("main"\)/);
  assert.match(spec.steps[1].expression, /throw new Error/);
  assert.deepEqual(spec.steps[2], { name: 'queue visible', action: 'expect', selector: '#queue' });

  assert.deepEqual(spec.checks.map((c) => c.id), ['render', 'console-clean', 'demo-frames']);
  assert.equal(spec.checks[0].kind, 'step');
  assert.equal(spec.checks[0].step, 'target URL renders a visible <main>');
  assert.ok(spec.acceptance.length >= 4);
});

test('buildUatSpec resolves relative URLs against a base and rejects unknown actions', () => {
  assert.equal(buildUatSpec(IDEA, { url: '/dashboard', base: 'http://127.0.0.1:3000' }).url, 'http://127.0.0.1:3000/dashboard');
  assert.equal(buildUatSpec(IDEA, { base: '127.0.0.1:3000' }).url, 'http://127.0.0.1:3000/');
  assert.equal(buildUatSpec(IDEA, { url: 'https://example.test/x', base: 'http://127.0.0.1:3000' }).url, 'https://example.test/x');
  assert.throws(() => buildUatSpec(IDEA, { url: '/dashboard' }), /url must be absolute/);
  assert.throws(() => buildUatSpec(IDEA, { url: 'http://x.test/', steps: [{ action: 'scroll' }] }), /unknown action "scroll"/);
  assert.throws(() => buildUatSpec(IDEA, { url: 'http://x.test/', steps: ['click'] }), /step 1 must be an object/);
});

test('acceptanceFor cites only what the idea already says', () => {
  const lines = acceptanceFor(IDEA).join('\n');
  assert.match(lines, /Dashboard shows the review queue/);
  assert.match(lines, /repo:apps\/web\/src\/app\/dashboard\/page\.tsx/);
  assert.match(lines, /apps\/web\/src\/app\/dashboard\/page\.tsx:42/);
  assert.doesNotMatch(lines, /src\/never-touched\.ts/, 'no path may be invented');

  const bare = acceptanceFor({ id: 'idea-x' }).join('\n');
  assert.match(bare, /idea-x/);
  assert.doesNotMatch(bare, /repo:/);
});

/* ---------------------------------------------------------------- *
 * runUat verdicts
 * ---------------------------------------------------------------- */

test('runUat passes when every step passed, the console is clean, and frames were assembled', async (t) => {
  const root = await fixture(t);
  const outDir = path.join(root, 'pass');
  const capture = captureStub({ frameCount: 4 });

  const result = await runUat({ idea: IDEA, url: 'http://127.0.0.1:3000/dashboard', outDir, capture, assemble: assembleStub });

  assert.equal(result.verdict, 'pass');
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.recorded, true);
  assert.equal(result.apng.file, path.join(outDir, 'demo.png'));
  assert.equal(result.report, path.join(outDir, 'uat.md'));
  assert.equal(result.demo, path.join(outDir, 'index.html'));
  assert.deepEqual(result.checkResults.map((c) => c.status), ['pass', 'pass', 'pass']);

  // The recorder is handed the spec's own steps and URL — not a private copy.
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].url, 'http://127.0.0.1:3000/dashboard');
  assert.equal(capture.calls[0].steps.length, 2);

  const report = await readFile(result.report, 'utf8');
  assert.match(report, /\*\*Verdict: ✅ PASS\*\*/);
  assert.match(report, /## What this does NOT prove/);
  assert.match(report, /idea-7/);
  const html = await readFile(result.demo, 'utf8');
  assert.match(html, /PASS/);
  assert.match(html, /demo\.png/);
});

test('runUat fails on a failed step and never reports pass', async (t) => {
  const root = await fixture(t);
  const outDir = path.join(root, 'fail-step');
  const result = await runUat({
    idea: IDEA,
    url: 'http://127.0.0.1:3000/dashboard',
    outDir,
    capture: captureStub({ failStep: 'target URL renders a visible <main>' }),
    assemble: assembleStub,
  });

  assert.equal(result.verdict, 'fail');
  assert.equal(result.ok, false);
  assert.match(result.reason, /1 step\(s\) failed: target URL renders a visible <main>/);
  assert.equal(result.checkResults[0].status, 'fail');
  const report = await readFile(result.report, 'utf8');
  assert.match(report, /\*\*Verdict: ❌ FAIL\*\*/);
  assert.match(report, /\*\*FAIL\*\*/, 'the failing step is marked in the table');
});

test('runUat fails when the page logged console errors', async (t) => {
  const root = await fixture(t);
  const outDir = path.join(root, 'noisy');
  const result = await runUat({
    idea: IDEA,
    url: 'http://127.0.0.1:3000/dashboard',
    outDir,
    capture: captureStub({ consoleErrors: [{ kind: 'log', at: 1, text: 'Uncaught TypeError: queue is undefined', url: 'http://127.0.0.1:3000/app.js' }] }),
    assemble: assembleStub,
  });

  assert.equal(result.verdict, 'fail');
  assert.match(result.reason, /1 console error\(s\) logged/);
  assert.equal(result.checkResults[1].status, 'fail');
  const report = await readFile(result.report, 'utf8');
  assert.match(report, /Uncaught TypeError: queue is undefined/);
});

test('runUat reports blocked — not fail — when the browser cannot start', async (t) => {
  const root = await fixture(t);
  const outDir = path.join(root, 'blocked');
  const capture = async () => {
    const err = new Error('chromium could not be started: /run/current-system/sw/bin/chromium (spawn ENOENT)');
    err.code = 'chromium-missing';
    throw err;
  };

  const result = await runUat({ idea: IDEA, url: 'http://127.0.0.1:3000/dashboard', outDir, capture, assemble: assembleStub });

  assert.equal(result.verdict, 'blocked');
  assert.equal(result.ok, false);
  assert.match(result.reason, /spawn ENOENT/);
  assert.equal(result.apng, null);
  assert.deepEqual(result.steps, []);
  assert.deepEqual(result.checkResults.map((c) => c.status), ['skip', 'skip', 'skip']);

  const report = await readFile(result.report, 'utf8');
  assert.match(report, /\*\*Verdict: ⛔ BLOCKED\*\*/);
  assert.match(report, /describes the environment, not the change/);
});

test('runUat blocks a recording that produced no animation, and passes the same run with record:false', async (t) => {
  const root = await fixture(t);
  const outDir = path.join(root, 'frames');

  const blocked = await runUat({ idea: IDEA, url: 'http://x.test/', outDir, capture: captureStub({ frameCount: 0 }), assemble: assembleStub });
  assert.equal(blocked.verdict, 'blocked');
  assert.match(blocked.reason, /recording produced 0 frame\(s\); at least 2 are needed/);

  const still = await runUat({ idea: IDEA, url: 'http://x.test/', outDir: path.join(root, 'still'), record: false, capture: captureStub({ frameCount: 0 }), assemble: assembleStub });
  assert.equal(still.verdict, 'pass');
  assert.equal(still.apng, null);
  assert.equal(still.checkResults[2].status, 'skip');
});

test('runUat blocks when frames exist but cannot be assembled, keeping the real reason', async (t) => {
  const root = await fixture(t);
  const outDir = path.join(root, 'bad-assembly');
  const assemble = async () => {
    throw new Error('assembleApng: frame 2 (/tmp/x/frames/frame-000002.png) has a different width (1280 vs 1279 in frame 1)');
  };

  const result = await runUat({ idea: IDEA, url: 'http://x.test/', outDir, capture: captureStub(), assemble });
  assert.equal(result.verdict, 'blocked');
  assert.match(result.reason, /animation assembly failed: assembleApng: frame 2 .*different width/);
  assert.equal(result.checkResults[2].status, 'fail');
});

/* ---------------------------------------------------------------- *
 * uatMarkdown
 * ---------------------------------------------------------------- */

test('uatMarkdown renders verdict, steps, screenshots, artefacts and the limits of the run', async (t) => {
  const root = await fixture(t);
  const outDir = path.join(root, 'md');
  const result = await runUat({
    idea: IDEA,
    url: 'http://127.0.0.1:3000/dashboard',
    outDir,
    steps: [{ name: 'queue visible', action: 'expect', selector: '#queue' }],
    capture: captureStub(),
    assemble: assembleStub,
  });

  const md = uatMarkdown(result, { idea: IDEA, now: new Date('2026-01-02T03:04:05Z') });

  assert.match(md, /# UAT report — Dashboard shows the review queue/);
  assert.match(md, /2026-01-02T03:04:05\.000Z/);
  assert.match(md, /http:\/\/127\.0\.0\.1:3000\/dashboard/);
  assert.match(md, /## Checks/);
  assert.match(md, /## Steps/);
  assert.match(md, /queue visible/);
  assert.match(md, /steps\/1-step\.png/, 'screenshots are linked relative to the report');
  assert.match(md, /## Console errors/);
  assert.match(md, /## Demo artefacts/);
  assert.match(md, /demo\.png/);
  assert.match(md, /all frame\(s\) used/);
  assert.match(md, /## What this does NOT prove/);
  assert.match(md, /apps\/web\/src\/app\/dashboard\/page\.tsx:42 — no <main> landmark and no queue list/);

  // A pipe in evidence must not break the markdown table.
  const piped = uatMarkdown({ ...result, steps: [{ name: 'a | b', action: 'eval', status: 'pass', evidence: 'x | y', screenshot: null }] });
  assert.match(piped, /a \\\| b/);
  assert.match(piped, /x \\\| y/);

  assert.throws(() => uatMarkdown(null), /result is required/);
});

test('uatMarkdown works without an idea and without artefacts', () => {
  const md = uatMarkdown({
    verdict: 'blocked',
    reason: 'browser session could not run: spawn ENOENT',
    spec: buildUatSpec({ id: 'bare' }, { url: 'http://x.test/' }),
    report: null,
    demo: null,
    apng: null,
    steps: [],
    consoleErrors: [],
    durationMs: 0,
    recorded: true,
    checkResults: [],
  });

  assert.match(md, /⛔ BLOCKED/);
  assert.match(md, /spawn ENOENT/);
  assert.match(md, /no checks were declared/);
  assert.match(md, /no steps ran/);
  assert.match(md, /Not observed — no browser session ran/);
  assert.match(md, /animation: not assembled/);
  assert.doesNotMatch(md, /undefined/);
});

test('the report file that runUat writes is the same markdown uatMarkdown renders', async (t) => {
  const root = await fixture(t);
  const outDir = path.join(root, 'same');
  const result = await runUat({ idea: IDEA, url: 'http://x.test/', outDir, capture: captureStub(), assemble: assembleStub });
  const onDisk = await readFile(result.report, 'utf8');
  assert.equal(onDisk, uatMarkdown(result, { idea: IDEA, now: new Date(Date.parse(/(\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(onDisk)[1])) }));
  assert.equal(existsSync(path.join(outDir, 'uat.md.tmp')), false, 'no leftover temp file');
});
