/**
 * Autonomous UAT — a spec in, a verdict plus reviewable artefacts out.
 *
 * This is the loop that decides whether an accepted idea actually shows up in
 * the running product. It is deliberately narrow: one idea, one URL, one
 * recorded session. What it buys is a *reviewable* verdict — screenshots, an
 * animation, and the console log — so a human can disagree with the machine.
 *
 * The verdict taxonomy is the important part:
 *   pass     — every step passed, the console stayed clean, and a real
 *              animation was assembled.
 *   fail     — the product misbehaved (a step failed, or the page logged an
 *              error). This is a statement about the change.
 *   blocked  — the run itself could not happen (no browser, no HTTP target, or
 *              frames that could not be assembled). This is a statement about
 *              the environment, and it never masquerades as either of the
 *              other two: a missing chromium is not a failing feature, and it
 *              is certainly not a passing one.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assembleApng, captureSession } from './recorder.mjs';

export const UAT_SPEC_VERSION = 1;

/** Steps the recorder understands; mirrored here so a bad spec fails loudly. */
const KNOWN_ACTIONS = new Set(['eval', 'click', 'wait', 'waitFor', 'expect']);

/** Default landmark asserted as the "the URL loaded and rendered" check. */
const DEFAULT_SELECTOR = 'main';

/**
 * Everything a green UAT run still does not establish. Kept next to the
 * verdict on purpose: the report is the artefact a human trusts, and an
 * unqualified "PASS" invites more confidence than one recorded session can pay
 * for.
 */
const DOES_NOT_PROVE = [
  'That the change works for real users — only the recorded steps ran, in one headless browser, at one viewport size, against one URL.',
  'That the feature is reachable the way a customer reaches it — no login, no navigation from the app shell, no empty/error state was exercised unless a step did it explicitly.',
  'That the idea’s cited evidence still holds — those lines are quoted from the idea, not re-derived by this run.',
  'That nothing is broken elsewhere — no other route, viewport, or interaction was visited, so a regression outside these steps stays invisible.',
  'That accessibility, performance, or backend correctness were checked — screenshots do not measure any of them.',
  'That the screenshots show the whole page lifetime — each one is a single moment, and each console error is only what the browser happened to log during this session.',
];

/** Join `url` with `base` when the caller passes a path instead of an origin. */
function resolveTarget(url, base) {
  const absolute = (value) => /^https?:\/\//i.test(String(value ?? ''));
  if (absolute(url)) return String(url);
  if (!base) {
    throw new Error(`buildUatSpec: url must be absolute (got ${JSON.stringify(url ?? null)}), or pass { base } to resolve it against`);
  }
  const origin = absolute(base) ? String(base) : `http://${String(base).replace(/^\/+/, '')}`;
  return new URL(url && String(url).trim() ? String(url) : '/', origin).toString();
}

/**
 * Assert that a selector matches a *visible* element. A missing landmark is
 * common enough that the error names it; `display:none` and a zero-size box are
 * separate messages because they have different causes.
 */
function visibilityProbe(selector) {
  const sel = JSON.stringify(selector);
  return `(() => {
  const el = document.querySelector(${sel});
  if (!el) throw new Error('no element matches ' + ${sel});
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    throw new Error(${sel} + ' is not visible (display=' + style.display + ', visibility=' + style.visibility + ', opacity=' + style.opacity + ')');
  }
  if (rect.width === 0 || rect.height === 0) {
    throw new Error(${sel} + ' has a zero-size box (' + rect.width + 'x' + rect.height + ')');
  }
  return 'visible ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ' at ' + Math.round(rect.left) + ',' + Math.round(rect.top);
})()`;
}

/** Keep only the fields a report needs, and never invent one that is absent. */
function ideaSummary(idea = {}) {
  return {
    id: idea.id ?? null,
    title: idea.title ?? null,
    source: idea.source ?? null,
    band: idea.band ?? null,
    score: idea.score ?? null,
    rationale: idea.rationale ?? null,
    // The idea's own evidence travels with the spec so the report can quote it
    // without the caller having to pass the idea a second time.
    evidence: Array.isArray(idea.evidence) ? idea.evidence.filter((e) => typeof e === 'string' && e.trim()) : [],
  };
}

/**
 * Human-readable acceptance lines for one idea.
 *
 * Wording is a contract here: these lines are read by a person deciding whether
 * to trust the run, so they say exactly what was and was not established. Only
 * strings the idea already carries (its source and its evidence) are echoed —
 * no path is invented, because an invented path is a claim nobody can check.
 */
export function acceptanceFor(idea = {}) {
  const lines = [];
  const title = idea.title ?? idea.id ?? 'the idea';
  lines.push(`The target URL reaches a rendered state a user can see — a visible \`<main>\` landmark, with no page-side exception while loading.`);
  lines.push(`No console errors or uncaught exceptions are logged during the recorded session.`);
  lines.push(`At least two screencast frames are captured, so the demo can be reviewed as an animation rather than a still.`);
  lines.push(`The change described by “${title}” is observable in the recorded steps.`);
  if (idea.source) {
    lines.push(`The signal that produced this idea (\`${idea.source}\`) is exercised by the recorded session.`);
  }
  const evidence = Array.isArray(idea.evidence) ? idea.evidence.filter((e) => typeof e === 'string' && e.trim()) : [];
  for (const line of evidence.slice(0, 4)) {
    lines.push(`Nothing observed by this run contradicts the cited evidence \`${line.trim()}\`.`);
  }
  return lines;
}

/**
 * Turn one accepted idea into an executable UAT spec.
 *
 * The first two steps are always present, because "the page rendered" and "the
 * page is actually visible" are the two things a demo silently lies about when
 * they are missing: a blank document still passes a screenshot review.
 *
 * @param {{id?: string, title?: string, source?: string, evidence?: string[], features?: object, score?: number, band?: string}} idea
 * @param {{url?: string, base?: string, selector?: string, steps?: object[]}} [options]
 *   `base` resolves a relative `url`; `selector` overrides the asserted
 *   landmark; `steps` are the caller's own screenshot-able steps, appended in
 *   order.
 */
export function buildUatSpec(idea, { url, base, selector = DEFAULT_SELECTOR, steps = [] } = {}) {
  const target = resolveTarget(url, base);
  const extra = (Array.isArray(steps) ? steps : []).map((step, i) => {
    if (!step || typeof step !== 'object') {
      throw new Error(`buildUatSpec: step ${i + 1} must be an object with an action`);
    }
    if (!KNOWN_ACTIONS.has(step.action)) {
      throw new Error(`buildUatSpec: step ${i + 1} has unknown action ${JSON.stringify(step.action ?? null)} (known: ${[...KNOWN_ACTIONS].join(', ')})`);
    }
    return {
      name: step.name ?? `${step.action} #${i + 1}`,
      action: step.action,
      ...(step.selector !== undefined ? { selector: step.selector } : {}),
      ...(step.expression !== undefined ? { expression: step.expression } : {}),
      ...(step.text !== undefined ? { text: step.text } : {}),
      ...(step.exists !== undefined ? { exists: step.exists } : {}),
      ...(step.ms !== undefined ? { ms: step.ms } : {}),
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    };
  });

  const renderStep = `target URL renders a visible <${selector}>`;
  return {
    version: UAT_SPEC_VERSION,
    id: `uat-${idea?.id ?? 'idea'}`,
    url: target,
    idea: ideaSummary(idea),
    acceptance: acceptanceFor(idea),
    checks: [
      {
        id: 'render',
        kind: 'step',
        step: renderStep,
        text: `The target URL renders a visible <${selector}> landmark.`,
      },
      {
        id: 'console-clean',
        kind: 'session',
        text: 'No console errors or uncaught exceptions are logged during the session.',
      },
      {
        id: 'demo-frames',
        kind: 'session',
        text: 'At least two screencast frames are captured and assembled into an animation.',
      },
    ],
    steps: [
      { name: renderStep, action: 'expect', selector, exists: true },
      { name: `<${selector}> is visible (non-zero box, not hidden)`, action: 'eval', expression: visibilityProbe(selector) },
      ...extra,
    ],
  };
}

/** Evaluate the spec's checks against what actually happened. Never guesses. */
function evaluateChecks({ spec, session, apng, recorded, apngError, blocked }) {
  const checks = spec?.checks ?? [];
  return checks.map((check) => {
    if (check.kind === 'step') {
      const step = session?.steps?.find((s) => s.name === check.step) ?? null;
      if (!step) return { id: check.id, text: check.text, status: 'skip', detail: 'the step this check names was not part of the run' };
      return {
        id: check.id,
        text: check.text,
        status: step.status === 'pass' ? 'pass' : 'fail',
        detail: step.evidence,
      };
    }
    if (check.id === 'console-clean') {
      if (!session) return { id: check.id, text: check.text, status: 'skip', detail: 'no session ran' };
      const errors = session.consoleErrors ?? [];
      return {
        id: check.id,
        text: check.text,
        status: errors.length === 0 ? 'pass' : 'fail',
        detail: errors.length === 0 ? '0 console errors' : `${errors.length} console error(s): ${errors.map((e) => e.text).join(' | ').slice(0, 300)}`,
      };
    }
    if (check.id === 'demo-frames') {
      if (!recorded) return { id: check.id, text: check.text, status: 'skip', detail: 'recording was disabled for this run' };
      if (blocked) return { id: check.id, text: check.text, status: 'skip', detail: 'no browser session ran' };
      if (apngError) return { id: check.id, text: check.text, status: 'fail', detail: `animation could not be assembled: ${apngError}` };
      const used = apng?.frames ?? 0;
      return {
        id: check.id,
        text: check.text,
        status: used >= 2 ? 'pass' : 'fail',
        detail: used >= 2 ? `${used} frame(s) assembled into ${path.basename(apng.file)}` : `only ${used} frame(s) assembled`,
      };
    }
    return { id: check.id, text: check.text, status: 'skip', detail: `unknown check kind: ${check.kind ?? 'none'}` };
  });
}

/**
 * Run one idea's UAT end to end.
 *
 * `capture` and `assemble` are injectable so the verdict logic can be tested
 * without a browser; both default to the real implementations. Everything
 * after `record` is forwarded to the recorder.
 *
 * @returns {Promise<{verdict: 'pass'|'fail'|'blocked', ok: boolean, reason: string|null, spec: object, report: string, demo: string|null, apng: object|null, steps: object[], consoleErrors: object[], durationMs: number, recorded: boolean, checkResults: object[]}>}
 *   `report` (uat.md) and `demo` (index.html player) are absolute paths;
 *   `apng` is the assembler result, whose `file` is the animation path.
 */
export async function runUat({
  idea,
  url,
  base,
  outDir,
  steps = [],
  record = true,
  capture = captureSession,
  assemble = assembleApng,
  log = () => {},
  ...recorderOpts
} = {}) {
  if (!outDir) throw new Error('runUat: outDir is required');
  const started = Date.now();
  await mkdir(outDir, { recursive: true });

  const spec = buildUatSpec(idea, { url, base, steps, selector: recorderOpts.selector ?? DEFAULT_SELECTOR });

  let session = null;
  let blockedReason = null;
  try {
    session = await capture({ url: spec.url, outDir, steps: spec.steps, log, ...recorderOpts });
  } catch (err) {
    // Starting the browser is the environment's job to get right. A failure
    // here says nothing about the change, so it is never reported as `fail`.
    blockedReason = err?.message ?? String(err);
    log(`uat: blocked — ${blockedReason}`);
  }

  let apng = null;
  let apngError = null;
  if (session && record) {
    try {
      apng = await assemble(session.frames, path.join(outDir, 'demo.png'), {
        delayMs: recorderOpts.delayMs ?? 120,
        maxFrames: recorderOpts.maxFrames ?? 400,
      });
    } catch (err) {
      apngError = err?.message ?? String(err);
      log(`uat: animation assembly failed — ${apngError}`);
    }
  }

  const failedSteps = session ? session.steps.filter((s) => s.status === 'fail') : [];
  const consoleErrors = session?.consoleErrors ?? [];
  const framesUsed = apng?.frames ?? session?.frames?.length ?? 0;

  let verdict;
  let reason = null;
  if (blockedReason) {
    verdict = 'blocked';
    reason = `browser session could not run: ${blockedReason}`;
  } else if (failedSteps.length > 0) {
    verdict = 'fail';
    reason = `${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.name).join(', ')}`;
  } else if (consoleErrors.length > 0) {
    verdict = 'fail';
    reason = `${consoleErrors.length} console error(s) logged during the session`;
  } else if (record && (!apng || framesUsed < 2)) {
    // Every step passed, but there is nothing a human can watch. Reporting this
    // as a pass would hand over an approval with no evidence behind it.
    verdict = 'blocked';
    reason = apngError
      ? `animation assembly failed: ${apngError}`
      : `recording produced ${framesUsed} frame(s); at least 2 are needed for a reviewable demo`;
  } else {
    verdict = 'pass';
  }

  const report = path.join(outDir, 'uat.md');
  const demo = path.join(outDir, 'index.html');
  const durationMs = Date.now() - started;
  const checkResults = evaluateChecks({ spec, session, apng, recorded: record, apngError, blocked: blockedReason !== null });

  const result = {
    verdict,
    ok: verdict === 'pass',
    reason,
    spec,
    report,
    demo,
    apng,
    steps: session?.steps ?? [],
    consoleErrors,
    droppedFrames: session?.droppedFrames ?? [],
    durationMs,
    recorded: record,
    checkResults,
    title: session?.title ?? '',
    pageUrl: session?.url ?? spec.url,
  };

  const html = reviewHtml(result);
  await writeAtomic(demo, html);
  await writeAtomic(report, uatMarkdown(result, { now: new Date() }));

  log(`uat: ${verdict}${reason ? ` — ${reason}` : ''} (${durationMs}ms, report ${report})`);
  return result;
}

async function writeAtomic(file, body) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, file);
}

/* ------------------------------------------------------------------ *
 * Report rendering
 * ------------------------------------------------------------------ */

/** Markdown table cell: pipes and newlines must not break the table. */
function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .slice(0, 400);
}

/**
 * Render a path relative to the report so links work in a plain markdown
 * viewer. Falls back to the absolute path when the two are unrelated.
 */
function linkPath(reportFile, target) {
  if (!target) return null;
  const base = reportFile ? path.dirname(reportFile) : null;
  if (!base) return target;
  const rel = path.relative(base, target);
  return rel.startsWith('..') ? target : rel;
}

const VERDICT_BADGE = { pass: '✅ PASS', fail: '❌ FAIL', blocked: '⛔ BLOCKED' };
const CHECK_BADGE = { pass: 'pass', fail: 'FAIL', skip: 'skipped' };

/**
 * The reviewable report. A human reads this to decide whether the machine's
 * verdict deserves to be trusted, so it carries the failures and the
 * limitations with the same prominence as the verdict.
 */
export function uatMarkdown(result, { idea, now = new Date() } = {}) {
  if (!result || typeof result !== 'object') throw new Error('uatMarkdown: result is required');
  const spec = result.spec ?? {};
  const subject = idea ?? spec.idea ?? {};
  const report = result.report ?? null;
  const lines = [];

  lines.push(`# UAT report — ${subject.title ?? spec.id ?? 'untitled idea'}`);
  lines.push('');
  lines.push(`**Verdict: ${VERDICT_BADGE[result.verdict] ?? result.verdict}**`);
  if (result.reason) lines.push('');
  if (result.reason) lines.push(`> ${result.reason}`);
  lines.push('');

  lines.push('## Run');
  lines.push('');
  lines.push(`- idea: \`${subject.id ?? 'unknown'}\`${subject.title ? ` — ${subject.title}` : ''}`);
  if (subject.source) lines.push(`- signal source: \`${subject.source}\``);
  if (subject.band || subject.score !== null && subject.score !== undefined) {
    lines.push(`- score/band: ${subject.score ?? '?'} (${subject.band ?? '?'})`);
  }
  lines.push(`- target URL: ${result.pageUrl ?? spec.url ?? '(none)'}`);
  if (result.title) lines.push(`- document title: ${result.title}`);
  lines.push(`- spec: version ${spec.version ?? '?'}, ${spec.steps?.length ?? 0} step(s)`);
  lines.push(`- duration: ${((result.durationMs ?? 0) / 1000).toFixed(1)}s`);
  lines.push(`- generated: ${now.toISOString()}`);
  if (report) lines.push(`- artefact root: \`${path.dirname(report)}\``);
  lines.push('');

  lines.push('## Checks');
  lines.push('');
  lines.push('| check | status | detail |');
  lines.push('| --- | --- | --- |');
  for (const check of result.checkResults ?? []) {
    lines.push(`| ${cell(check.text ?? check.id)} | ${CHECK_BADGE[check.status] ?? check.status} | ${cell(check.detail)} |`);
  }
  if (!(result.checkResults ?? []).length) lines.push('| (none) | skipped | no checks were declared |');
  lines.push('');

  lines.push('## Acceptance criteria stated for this idea');
  lines.push('');
  lines.push('These are the claims the run is meant to support. Only the checks above are machine-verified; the rest is a human judgement made from the steps and artefacts below.');
  lines.push('');
  for (const line of spec.acceptance ?? []) lines.push(`- ${line}`);
  lines.push('');

  lines.push('## Steps');
  lines.push('');
  lines.push('| # | step | action | status | evidence | screenshot |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  const stepList = result.steps ?? [];
  stepList.forEach((step, i) => {
    const shot = step.screenshot ? linkPath(report, step.screenshot) : null;
    lines.push(
      `| ${i + 1} | ${cell(step.name)} | \`${cell(step.action)}\` | ${step.status === 'pass' ? 'pass' : '**FAIL**'} | ${cell(step.evidence)} | ${shot ? `[\`${shot}\`](${shot})` : '—'} |`,
    );
  });
  if (!stepList.length) lines.push('| 1 | (no steps ran) | — | — | — | — |');
  lines.push('');

  lines.push('## Console errors');
  lines.push('');
  const errors = result.consoleErrors ?? [];
  if (errors.length === 0) {
    lines.push(result.verdict === 'blocked' ? 'Not observed — no browser session ran.' : 'None observed during the session.');
  } else {
    for (const err of errors) lines.push(`- \`${err.kind}\` ${err.text}${err.url ? ` (${err.url})` : ''}`);
  }
  lines.push('');

  lines.push('## Demo artefacts');
  lines.push('');
  if (result.apng) {
    const apngLink = linkPath(report, result.apng.file);
    lines.push(`- animation (APNG): [\`${apngLink}\`](${apngLink}) — ${result.apng.frames} frame(s), ${result.apng.skipped} dropped, ${result.apng.bytes} bytes, ${result.apng.width}×${result.apng.height}, ${result.apng.delayMs}ms/frame`);
    lines.push(`- sampling: ${result.apng.sampling ?? '(unspecified)'}`);
  } else if (result.recorded) {
    lines.push(`- animation: not assembled${result.reason ? ` (${result.reason})` : ''}`);
  } else {
    lines.push('- animation: not requested (`record: false`)');
  }
  const demoLink = linkPath(report, result.demo);
  lines.push(demoLink ? `- review player: [\`${demoLink}\`](${demoLink})` : '- review player: not written');
  const dropped = result.droppedFrames ?? [];
  if (dropped.length) {
    lines.push(`- dropped before the recording: ${dropped.length} screencast frame(s) — ${[...new Set(dropped.map((f) => f.reason))].join('; ')}`);
  }
  lines.push('');

  lines.push('## What this does NOT prove');
  lines.push('');
  for (const line of DOES_NOT_PROVE) lines.push(`- ${line}`);
  if (!result.recorded) lines.push('- No animation was recorded for this run, so nothing visual was reviewed at all.');
  if (result.verdict === 'blocked') lines.push('- A blocked verdict describes the environment, not the change: it is neither evidence for nor against the idea.');
  const evidence = Array.isArray(subject.evidence) ? subject.evidence.filter((e) => typeof e === 'string' && e.trim()) : [];
  if (evidence.length) {
    lines.push('');
    lines.push('Cited evidence lines that were quoted but not re-measured by this run:');
    lines.push('');
    for (const line of evidence.slice(0, 8)) lines.push(`- \`${line.trim()}\``);
  }
  lines.push('');

  return `${lines.join('\n')}`;
}

/** Standalone verdict-first review page (the `demo` artefact of a UAT run). */
function reviewHtml(result) {
  const dir = result.report ? path.dirname(result.report) : null;
  const rel = (p) => (dir && p ? linkPath(result.report, p) : p);
  const spec = result.spec ?? {};
  const subject = spec.idea ?? {};
  const badge = result.verdict === 'pass' ? 'ok' : 'bad';

  const checks = (result.checkResults ?? [])
    .map((c) => `<tr class="${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'bad' : ''}"><td>${escHtml(c.text)}</td><td>${escHtml(c.status)}</td><td>${escHtml(c.detail)}</td></tr>`)
    .join('');

  const steps = (result.steps ?? [])
    .map((step, i) => {
      const shot = step.screenshot ? rel(step.screenshot) : null;
      return `<li class="step ${step.status === 'pass' ? 'ok' : 'bad'}">
  <div><strong>${i + 1}. ${escHtml(step.name)}</strong> <code>${escHtml(step.action)}</code> <span class="pill ${step.status === 'pass' ? 'ok' : 'bad'}">${escHtml(step.status)}</span></div>
  <pre>${escHtml(step.evidence)}</pre>
  ${shot ? `<img src="${escHtml(shot)}" alt="step ${i + 1} screenshot">` : '<p class="muted">no screenshot</p>'}
</li>`;
    })
    .join('\n');

  const errors = (result.consoleErrors ?? []).length
    ? `<ul>${result.consoleErrors.map((e) => `<li><code>${escHtml(e.kind)}</code> ${escHtml(e.text)}</li>`).join('')}</ul>`
    : `<p class="muted">${result.verdict === 'blocked' ? 'no browser session ran' : 'none observed'}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>UAT ${escHtml(result.verdict)} — ${escHtml(subject.title ?? spec.id ?? 'idea')}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 24px; }
  h1 { margin: 0 0 2px; font-size: 22px; }
  .verdict { display: inline-block; padding: 3px 12px; border-radius: 14px; font-weight: 700; color: #fff; }
  .verdict.ok { background: #1a7f37; } .verdict.bad { background: #b3261e; }
  .pill { padding: 1px 8px; border-radius: 10px; font-size: 12px; color: #fff; }
  .pill.ok { background: #1a7f37; } .pill.bad { background: #b3261e; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; font-size: 14px; }
  tr.ok td:first-child { border-left: 4px solid #1a7f37; }
  tr.bad td:first-child { border-left: 4px solid #b3261e; }
  ul.steps { list-style: none; padding: 0; }
  li.step { border: 1px solid #ddd; border-left-width: 5px; border-radius: 6px; padding: 10px 14px; margin: 10px 0; }
  li.step.ok { border-left-color: #1a7f37; } li.step.bad { border-left-color: #b3261e; }
  pre { background: #f5f5f5; padding: 8px; border-radius: 4px; white-space: pre-wrap; font-size: 13px; }
  img { max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }
  .muted { color: #777; } a { color: inherit; }
  @media (prefers-color-scheme: dark) { pre { background: #22262b; } th, td, li.step, img { border-color: #3a3f45; } }
</style>
</head>
<body>
<h1>UAT — ${escHtml(subject.title ?? spec.id ?? 'idea')}</h1>
<p><span class="verdict ${badge}">${escHtml(result.verdict.toUpperCase())}</span>
 <span class="muted">${escHtml(subject.id ?? '')} · ${escHtml(result.pageUrl ?? spec.url ?? '')} · ${((result.durationMs ?? 0) / 1000).toFixed(1)}s</span></p>
${result.reason ? `<p class="bad"><strong>${escHtml(result.reason)}</strong></p>` : ''}
${result.apng ? `<p><img src="${escHtml(rel(result.apng.file))}" alt="recorded UAT animation"></p><p class="muted">${result.apng.frames} frame(s), ${result.apng.bytes} bytes — ${escHtml(result.apng.sampling ?? '')}</p>` : '<p class="muted">no animation</p>'}
<h2>Checks</h2>
<table><thead><tr><th>check</th><th>status</th><th>detail</th></tr></thead><tbody>${checks || '<tr><td colspan="3" class="muted">none</td></tr>'}</tbody></table>
<h2>Steps</h2>
<ul class="steps">${steps || '<li class="muted">no steps ran</li>'}</ul>
<h2>Console errors</h2>
${errors}
<p class="muted">Full report: <a href="uat.md">uat.md</a></p>
</body>
</html>
`;
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
