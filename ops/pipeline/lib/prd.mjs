/**
 * PRD generation — from a human-accepted idea to a reviewable document.
 *
 * The review UI already produced the decision; this module produces the paper
 * trail that the QA stage and the forge issue are built from. Two rules shape
 * everything below:
 *
 *   1. Nothing is invented. Every path, command and acceptance criterion in the
 *      output is copied from the idea's own evidence or derived from its source
 *      and its rubric axes. An idea with no evidence produces a document that
 *      says so, not a plausible-looking one. This is the same rule the
 *      generator follows ("no invented file paths"), enforced one stage later.
 *   2. The output is deterministic given `now`. Regenerating the same idea must
 *      produce the same bytes, so a human diffing two PRDs sees only what
 *      actually changed in the idea (the same reasoning `ops/ci/ci-loop.mjs`
 *      applies to its checks fingerprint).
 *
 * No I/O happens in `buildPrd`/`acceptanceFor`: they are pure, so the pipeline
 * can regenerate a PRD to compare it against the one stored on disk.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// One source of truth for the rubric ceilings: the acceptance criteria quote
// these numbers, and duplicating them here would let the two drift apart.
import { RUBRIC } from '../../ideation/lib/scorer.mjs';

/** Default output directory for generated PRDs, repo-relative. */
export const PRD_DIR = 'ops/pipeline/prd';

/** The repo-wide gate. Typed literally because a glob is what the shell needs. */
const DEFAULT_VERIFY = ['node --test "ops/**/test/*.test.mjs"'];
/** The primitive CI loop: it always applies, even when specific commands exist. */
const CI_RUN = 'node ops/ci/ci-loop.mjs --once';

const str = (v) => (v == null ? '' : String(v).trim());

/** Evidence is kept byte-for-byte: a criterion quoting a mangled line is a lie. */
const evidenceLines = (idea) =>
  (Array.isArray(idea?.evidence) ? idea.evidence : [])
    .filter((e) => str(e) !== '')
    .map((e) => String(e));

/**
 * How each source turns into a concrete plan. Keyed by the `source` field the
 * generator writes, so an unknown source degrades to a generic instruction
 * instead of inventing a plan for work we do not understand.
 */
const CHANGE_BY_SOURCE = {
  'disabled-check':
    'Un-comment the check quoted in the evidence and make it pass, or delete the dead line. A commented-out check is a gate that no longer gates: it still reads like a gate in review, and nothing runs it.',
  'ci-failure':
    'Make the failing check pass again, then re-record the run so the state file stops reporting a red trunk. Restoring green is the whole deliverable — do not fold unrelated changes into it.',
  'ci-missing':
    'Produce a first recorded run so "never ran" stops being indistinguishable from "ran green". A missing record is not a passing record.',
  'deploy-hook':
    'Either provide the deploy hook the evidence names and make it do the real deploy, or document that shipping is manual. A hook that does not exist is not a deploy.',
  'untested-area':
    'Add tests for the files the evidence names. Each test must fail before the change and pass after it; a test that passes either way proves nothing.',
  backlog:
    'Resolve the backlog item quoted in the evidence, or delete the item if the decision is "no".',
  'fix-churn':
    'Fix the cause that keeps producing the commits quoted in the evidence, not the latest symptom.',
  'todo-cluster':
    'Resolve the TODO cluster the evidence names — implement it or delete the note so it stops being counted.',
  llm: 'Implement the change described by the evidence, and only that change.',
};

const DEFAULT_CHANGE =
  'Implement the smallest change that makes the evidence above stop being true. If the evidence does not name it, it is not in scope.';

/** One risk per source, plus the ones that apply to every idea. */
const RISK_BY_SOURCE = {
  'disabled-check':
    'Re-enabling a check that was commented out may simply fail: it was skipped for a reason. Find that reason first.',
  'ci-failure':
    'A red trunk blocks every other idea; the honest fix may be a revert rather than a repair.',
  'ci-missing': 'Adding a pipeline that is never watched recreates the problem in a new file.',
  'deploy-hook':
    'A hook that runs on every green build can ship more than intended; scope what it does before enabling it.',
  'untested-area':
    'A test written against current behaviour locks in that behaviour, bug included.',
  backlog: 'Backlog items age: the item may already be fixed or no longer wanted.',
  'fix-churn':
    'Churn can be a symptom of a design nobody owns, in which case a fix adds to the churn.',
  'todo-cluster':
    'A TODO cluster can be intentional documentation; deleting it removes information.',
  llm: 'This idea came from a model: its evidence was cited by a model and must be re-checked by hand before work starts.',
};

/**
 * Detect the forge behind a git remote.
 *
 * Ideas must be able to target either the main repository or a fork, so the
 * caller names the remote (`origin`, `upstream`, …) instead of relying on a
 * baked-in URL. The default implementation shells out to git; tests inject
 * `execImpl` so they never touch a real repository.
 *
 * @param {object} [options]
 * @param {string} [options.repo]  repository directory (defaults to the cwd)
 * @param {string} [options.remote='origin'] remote name to read
 * @param {(remote: string, repo?: string) => string | { status?: number, stdout?: string, stderr?: string }} [options.execImpl]
 *   injected command runner; return the URL, or a `spawnSync`-shaped result
 * @returns {{ provider: 'github'|'forgejo'|'none', remote: string, url: string|null, owner: string|null, name: string|null, host: string|null, reason: string }}
 *
 * Decisions worth knowing:
 *   - `github.com` always wins, even when `FORGEJO_URL` is set: a GitHub remote
 *     is not a Forgejo remote just because a Forgejo server exists somewhere.
 *   - `FORGEJO_URL` supplies the API base for any *other* host. Without it, a
 *     self-hosted forge discovered over `http(s)` uses that origin (plus a
 *     `/forgejo` or `/gitea` prefix when the remote URL carries one).
 *   - An SSH remote on a non-GitHub host yields `provider: 'forgejo'` with
 *     `url: null`: SSH tells us the git host and port, not the web/API origin,
 *     and guessing one would put a fabricated URL into the issue request.
 */
export function detectForge({ repo, remote = 'origin', execImpl } = {}) {
  const name = str(remote) || 'origin';
  const { url, reason: readReason } = readRemote(name, repo, execImpl);
  if (!url) return none(name, readReason);
  const parsed = parseRemote(url);
  if (parsed.provider === 'none') return none(name, parsed.reason, parsed.host);
  return { ...parsed, remote: name };
}

function none(remote, reason, host = null) {
  return { provider: 'none', remote, url: null, owner: null, name: null, host, reason };
}

/** Read the remote URL. A failure here is data, not an exception. */
function readRemote(remote, repo, execImpl) {
  const exec =
    execImpl ??
    ((r, cwd) =>
      spawnSync('git', ['remote', 'get-url', r], { cwd: cwd ?? process.cwd(), encoding: 'utf8' }));
  let out;
  try {
    out = exec(remote, repo);
  } catch (err) {
    return {
      url: null,
      reason: `git remote get-url ${remote} failed: ${err?.message ?? String(err)}`,
    };
  }
  if (out == null) return { url: null, reason: `git remote get-url ${remote} returned nothing` };
  if (typeof out === 'string') {
    const url = out.trim();
    return url ? { url, reason: '' } : { url: null, reason: `remote ${remote} has no url` };
  }
  if (typeof out.status === 'number' && out.status !== 0) {
    const detail = str(out.stderr) || str(out.error?.message) || `exit ${out.status}`;
    return { url: null, reason: `git remote get-url ${remote} failed: ${detail}` };
  }
  const url = str(out.stdout);
  return url ? { url, reason: '' } : { url: null, reason: `remote ${remote} has no url` };
}

/**
 * Parse one remote URL into a forge description. Anything that is not a remote
 * we can address over HTTP(S) comes back as `none` with the real reason.
 */
function parseRemote(raw) {
  const trimmed = str(raw);
  if (!trimmed) return { provider: 'none', reason: 'empty remote url' };

  let scheme;
  let host;
  let segments;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // URL form: https://host/owner/name.git, ssh://git@host:2222/owner/name.git
    let u;
    try {
      u = new URL(trimmed);
    } catch {
      return { provider: 'none', reason: `unparseable remote url: ${trimmed}` };
    }
    scheme = u.protocol.replace(':', '').toLowerCase();
    host = u.host;
    segments = u.pathname.split('/').filter(Boolean);
    if (scheme === 'file')
      return { provider: 'none', reason: `remote is a local path, not a forge: ${trimmed}` };
    if (!['http', 'https', 'ssh', 'git'].includes(scheme)) {
      return { provider: 'none', reason: `unsupported remote scheme: ${scheme}` };
    }
  } else if (
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return { provider: 'none', reason: `remote is a local path, not a forge: ${trimmed}` };
  } else {
    // scp form: git@host:owner/name.git
    const m = /^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/.exec(trimmed);
    if (!m) return { provider: 'none', reason: `unparseable remote url: ${trimmed}` };
    scheme = 'ssh';
    host = m[2];
    segments = m[3].split('/').filter(Boolean);
    // ssh://git@localhost:3000/o/n.git is spelled git@localhost:3000/o/n.git by
    // some clients; a leading all-digit segment there is a port, not an owner.
    if (segments.length >= 3 && /^\d+$/.test(segments[0])) {
      host = `${host}:${segments[0]}`;
      segments = segments.slice(1);
    }
  }

  if (!host) return { provider: 'none', reason: `remote url has no host: ${trimmed}` };
  segments = segments
    .map((s, i) => (i === segments.length - 1 ? s.replace(/\.git$/i, '') : s))
    .filter(Boolean);
  if (segments.length < 2) {
    return { provider: 'none', host, reason: `remote url has no owner/name: ${trimmed}` };
  }
  const owner = segments[segments.length - 2];
  const name = segments[segments.length - 1];
  const hostname = host.replace(/:\d+$/, '').toLowerCase();

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    return {
      provider: 'github',
      url: 'https://github.com',
      owner,
      name,
      host,
      reason: 'github.com remote',
    };
  }

  const override = str(process.env.FORGEJO_URL).replace(/\/+$/, '');
  if (override) {
    return {
      provider: 'forgejo',
      url: override,
      owner,
      name,
      host,
      reason: `FORGEJO_URL override for host ${host}`,
    };
  }
  if (scheme === 'http' || scheme === 'https') {
    // A forge mounted under a path (/forgejo, /gitea) keeps that prefix as its
    // API base; the last two segments are always owner/name.
    const mount = segments.slice(0, -2).findIndex((s) => /^(forgejo|gitea)$/i.test(s));
    const prefix = mount === -1 ? '' : `/${segments.slice(0, mount + 1).join('/')}`;
    return {
      provider: 'forgejo',
      url: `${scheme}://${host}${prefix}`,
      owner,
      name,
      host,
      reason: `self-hosted forge on ${host}${prefix}`,
    };
  }
  return {
    provider: 'forgejo',
    url: null,
    owner,
    name,
    host,
    reason: `self-hosted forge on ${host}, but the remote is ${scheme}: set FORGEJO_URL to reach its API`,
  };
}

/**
 * The machine-readable acceptance list the QA stage checks.
 *
 * Every entry traces to exactly one recorded input — one evidence line or one
 * rubric reason — so the QA stage can always answer "why is this a criterion?".
 * With no inputs the list is empty rather than padded: an idea nobody can check
 * must fail loudly downstream, not look approved here.
 *
 * @param {object} idea
 * @returns {string[]}
 */
export function acceptanceFor(idea) {
  const entries = [];
  for (const line of evidenceLines(idea)) entries.push(`Evidence resolved: ${line}`);
  for (const reason of rubricReasons(idea)) entries.push(`Rubric axis preserved: ${reason}`);
  return entries;
}

/** Stored `scoreReasons` when present, otherwise derived from the raw features. */
function rubricReasons(idea) {
  const stored = Array.isArray(idea?.scoreReasons)
    ? idea.scoreReasons
    : Array.isArray(idea?.reasons)
      ? idea.reasons
      : [];
  const reasons = stored.map((r) => str(r)).filter(Boolean);
  if (reasons.length) return reasons;
  const features = idea?.features;
  if (!features || typeof features !== 'object') return [];
  return Object.keys(RUBRIC)
    .filter((axis) => Number.isFinite(Number(features[axis])))
    .map((axis) => `${axis} ${Number(features[axis])}/${RUBRIC[axis]}`);
}

/**
 * Render the PRD for one accepted idea.
 *
 * @param {object} idea
 * @param {object} [options]
 * @param {string} [options.repo] target repository (recorded, not read)
 * @param {{ ci?: { head?: string, status?: string, finishedAt?: string, failedChecks?: string[] } }|null} [options.signals]
 * @param {Date|string} [options.now] generation timestamp
 * @param {string[]} [options.verifyCommands] idea-specific commands for `## Verification`
 * @returns {string} markdown
 */
export function buildPrd(
  idea,
  { repo, signals = null, now = new Date(), verifyCommands = [] } = {},
) {
  const generated = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(generated.getTime()))
    throw new TypeError(`buildPrd: invalid now: ${String(now)}`);

  const title = str(idea?.title) || `Idea ${str(idea?.id) || '(untitled)'}`;
  const criteria = acceptanceFor(idea);
  const source = str(idea?.source);
  const change = CHANGE_BY_SOURCE[source] ?? DEFAULT_CHANGE;
  const risk = RISK_BY_SOURCE[source];

  const sections = [
    `# ${title}`,
    '',
    '## Summary',
    '',
    summary(idea),
    '',
    '## Problem',
    '',
    str(idea?.rationale) || '(no rationale was recorded with this idea)',
    '',
    '## Evidence',
    '',
    evidenceSection(idea, signals),
    '',
    '## Proposed change',
    '',
    change,
    '',
    '## Acceptance criteria',
    '',
    criteria.length
      ? criteria.map((c) => `- [ ] ${c}`).join('\n')
      : '- [ ] (no evidence and no rubric scores were recorded — this idea cannot be called done)',
    '',
    '## Out of scope',
    '',
    outOfScope(idea),
    '',
    '## Risks',
    '',
    risks(risk),
    '',
    '## Verification',
    '',
    verification(verifyCommands),
    '',
    '---',
    '',
    metadata(idea, repo, generated.toISOString()),
    '',
  ];
  return sections.join('\n');
}

function summary(idea) {
  const facts = [];
  if (str(idea?.source)) facts.push(`source \`${str(idea.source)}\``);
  if (Number.isFinite(Number(idea?.score))) facts.push(`score ${Number(idea.score)}`);
  if (str(idea?.band)) facts.push(`band \`${str(idea.band)}\``);
  if (str(idea?.effortHint)) facts.push(`effort hint \`${str(idea.effortHint)}\``);
  const id = str(idea?.id) || '(no id)';
  return (
    `This PRD covers the idea \`${id}\`${facts.length ? ` (${facts.join(', ')})` : ''}, accepted in human review. ` +
    'The question here is therefore not whether to do the work but what exactly "done" means: everything below is limited ' +
    "to the evidence recorded with the idea, and every acceptance criterion traces back to one of those lines or to the idea's rubric scores."
  );
}

function evidenceSection(idea, signals) {
  const lines = evidenceLines(idea).map((l) => `- ${l}`);
  if (!lines.length) lines.push('- (none recorded — treat this idea as unverified)');
  const ci = signals?.ci;
  if (ci) {
    const head = str(ci.head);
    const bits = [];
    if (str(ci.status)) bits.push(`status ${str(ci.status)}`);
    if (str(ci.finishedAt)) bits.push(`finished ${str(ci.finishedAt)}`);
    if (head) lines.push(`- CI head \`${head}\`${bits.length ? ` (${bits.join(', ')})` : ''}`);
    else if (bits.length) lines.push(`- CI (${bits.join(', ')})`);
    for (const cmd of Array.isArray(ci.failedChecks) ? ci.failedChecks : []) {
      if (str(cmd)) lines.push(`- CI failing check: \`${str(cmd)}\``);
    }
  }
  return lines.join('\n');
}

function outOfScope(idea) {
  const named = evidenceLines(idea).length
    ? 'the files named in the evidence'
    : 'the idea description';
  return [
    `- Anything outside ${named}: no drive-by refactors, no unrelated cleanups.`,
    '- New dependencies, services or infrastructure.',
    '- Changing the pipeline that produced this idea (signals, scoring, review UI).',
  ].join('\n');
}

function risks(sourceRisk) {
  const lines = [
    '- The evidence may be stale. Re-run it before starting; if it no longer holds, reject the idea instead of implementing it.',
    '- Silencing the evidence (deleting the check, the note, or the record) would satisfy the letter of the criteria and none of their point.',
  ];
  if (sourceRisk) lines.splice(1, 0, `- ${sourceRisk}`);
  return lines.join('\n');
}

/**
 * The verification block.
 *
 * Idea-specific commands replace the default glob, but the primitive CI run is
 * always appended: it is the repository's own definition of "green", and a
 * change that never faced it is not verified no matter what else passed.
 */
function verification(verifyCommands) {
  const commands = (Array.isArray(verifyCommands) ? verifyCommands : [])
    .map((c) => str(c))
    .filter(Boolean);
  const block = [...new Set([...(commands.length ? commands : DEFAULT_VERIFY), CI_RUN])];
  return [
    'Run these on the resulting commit and paste the output into the review:',
    '',
    '```bash',
    ...block,
    '```',
  ].join('\n');
}

function metadata(idea, repo, generatedAt) {
  const score = Number.isFinite(Number(idea?.score)) ? String(Number(idea.score)) : '(unscored)';
  const band = str(idea?.band);
  const lines = [
    `- idea: \`${str(idea?.id) || '(no id)'}\``,
    `- source: \`${str(idea?.source) || '(unknown)'}\``,
    `- score: ${score}${band ? ` (band \`${band}\`)` : ''}`,
    `- generated: ${generatedAt}`,
  ];
  const target = str(repo) ? path.basename(path.resolve(str(repo))) : '';
  if (target) lines.push(`- target: \`${target}\``);
  return lines.join('\n');
}

/**
 * Write the PRD next to the pipeline state, atomically.
 *
 * A half-written PRD that a later stage reads as complete is worse than no PRD,
 * so the file appears in one `rename` — the same discipline `IdeaStore` uses.
 *
 * @returns {Promise<{ file: string, bytes: number }>} `file` is repo-relative with POSIX separators
 */
export async function writePrd({ repo, idea, prd, dir = PRD_DIR } = {}) {
  const id = str(idea?.id);
  if (!id) throw new Error('writePrd: idea.id is required');
  if (typeof prd !== 'string') throw new Error('writePrd: prd must be a string');
  const base = str(repo) || process.cwd();
  const target = path.isAbsolute(str(dir))
    ? path.join(str(dir), `${id}.md`)
    : path.join(base, str(dir), `${id}.md`);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, prd, 'utf8');
  await rename(tmp, target);
  return {
    file: path.relative(base, target).split(path.sep).join('/'),
    bytes: Buffer.byteLength(prd, 'utf8'),
  };
}
