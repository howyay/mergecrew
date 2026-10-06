/**
 * Repo signals — the raw material the idea generator thinks about.
 *
 * Everything here is local and read-only: git history, TODO/FIXME density,
 * open backlog checkboxes, the product's own feature inventory, and the last
 * primitive-CI result. No network, no LLM, no writes. Signals are evidence:
 * every generated idea must cite at least one, otherwise the generator is
 * inventing work.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { scanProduct } from './product.mjs';

const pexec = promisify(execFile);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.pnpm-store',
  'coverage', '.cache', 'out', 'tmp', 'vendor',
]);
const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.sh', '.py', '.go', '.rs']);
const MAX_FILES = 6000;
const MAX_DEPTH = 7;

async function git(repo, args, timeout = 20_000) {
  try {
    const { stdout } = await pexec('git', ['-C', repo, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Bounded recursive walk. Returns code-file paths relative to `root`. */
async function walkCode(root) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && found.length < MAX_FILES) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (depth < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && CODE_EXT.has(path.extname(entry.name))) {
        found.push(path.relative(root, full));
      }
    }
  }
  return found;
}

/**
 * Marker detection is comment-aware on purpose.
 *
 * Precision beats recall here: a false cluster becomes a bogus work item a human
 * then has to swipe away, and that burns the one resource this tool needs —
 * trust. A naive `/\bTODO\b/` over the tree is badly wrong: this very repository
 * reported 12 "TODOs" that were mostly prose and test fixtures, of which only
 * one was real. So markers are read out of *comments only* (string literals are
 * skipped by `extractComments`) and a marker must open its comment:
 *   `// TODO: x`  `# FIXME(bob): y`  `* HACK: z`  `- TODO: bullet`
 * Prose such as `TODO/FIXME density,` or `1. write TODO: in comments` is not a
 * task, and neither is `"TODO: later"` inside a string literal.
 */
const MARKER_AT_COMMENT_START = /^[ \t]*(?:[*#>/;!<-]+[ \t]+)?(TODO|FIXME|HACK)(?:\(([^)]{0,40})\))?:[ \t]*(.*)$/;

const HASH_COMMENT_EXT = new Set(['.py', '.sh', '.bash', '.zsh', '.yml', '.yaml', '.toml', '.rb', '.pl', '.r', '.mk', '.conf', '.cfg', '.ini', '.properties']);
const HTML_COMMENT_EXT = new Set(['.html', '.htm', '.xml', '.md', '.mdx', '.vue', '.svelte']);

/** Does a single line open with an actionable marker? */
export function extractActionableMarker(line) {
  const m = MARKER_AT_COMMENT_START.exec(line);
  if (!m) return null;
  return { marker: m[1], owner: m[2] ?? null, text: (m[3] ?? '').trim().slice(0, 140) };
}

/**
 * Pull every comment out of a source file, skipping string literals so that
 * fixture data and prose inside strings cannot masquerade as work items.
 * Returns `{line, text}` entries where `line` is 1-based.
 */
export function extractComments(source, ext = '') {
  const hash = HASH_COMMENT_EXT.has(ext);
  const html = HTML_COMMENT_EXT.has(ext);
  const out = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  const advance = (to) => {
    const stop = Math.min(Math.max(to, i), n);
    for (let k = i; k < stop; k++) if (source[k] === '\n') line++;
    i = stop;
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      const startLine = line;
      const text = source.slice(i + 2, stop);
      advance(stop);
      out.push({ line: startLine, text });
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end;
      const startLine = line;
      const text = source.slice(i + 2, stop);
      advance(stop);
      advance(i + 2); // consume the closing */
      out.push({ line: startLine, text });
      continue;
    }
    if (html && source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end;
      const startLine = line;
      const text = source.slice(i + 4, stop);
      advance(stop);
      advance(i + 3);
      out.push({ line: startLine, text });
      continue;
    }
    if (hash && c === '#') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      const startLine = line;
      const text = source.slice(i + 1, stop);
      advance(stop);
      out.push({ line: startLine, text });
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const triple = ext === '.py' && source.startsWith(c.repeat(3), i);
      if (triple) {
        const quote = c.repeat(3);
        const end = source.indexOf(quote, i + 3);
        advance(end === -1 ? n : end + 3);
        continue;
      }
      advance(i + 1);
      while (i < n) {        if (source[i] === '\\') {
          advance(i + 2);
          continue;
        }
        if (source[i] === '\n') {
          // unterminated single-line string: bail out at the newline
          if (c !== '`') {
            advance(i + 1);
            break;
          }
          advance(i + 1);
          continue;
        }
        if (source[i] === c) {
          advance(i + 1);
          break;
        }
        advance(i + 1);
      }
      continue;
    }
    advance(i + 1);
  }
  return out;
}

/** All actionable markers in a source file, with the line each one sits on. */
export function findMarkers(source, ext = '') {
  const found = [];
  for (const comment of extractComments(source, ext)) {
    const lines = comment.text.split('\n');
    for (let offset = 0; offset < lines.length; offset++) {
      const m = extractActionableMarker(lines[offset]);
      if (!m) continue;
      found.push({ ...m, line: comment.line + offset });
    }
  }
  return found;
}

/** TODO / FIXME / HACK clusters, grouped by top-2 path segments. */
async function scanTodos(repo) {
  const files = await walkCode(repo);
  const clusters = new Map();
  let total = 0;

  for (const rel of files) {
    let body;
    try {
      const info = await stat(path.join(repo, rel));
      if (info.size > 512 * 1024) continue;
      body = await readFile(path.join(repo, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of findMarkers(body, path.extname(rel))) {
      total++;
      const parts = rel.split(path.sep);
      const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
      if (!clusters.has(dir)) clusters.set(dir, { dir, count: 0, samples: [] });
      const cluster = clusters.get(dir);
      cluster.count++;
      if (cluster.samples.length < 3) cluster.samples.push(`${rel}:${m.line} ${(m.text ?? '').trim().slice(0, 90)}`);
    }
  }

  return {
    filesScanned: files.length,
    total,
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

/** Open `- [ ]` items from the first backlog doc that has any. */
async function scanBacklog(repo) {
  const candidates = ['UX-BACKLOG.md', 'docs/04-roadmap.md', 'docs/00-product/00-roadmap.md', 'ROADMAP.md'];
  for (const rel of candidates) {
    let body;
    try {
      body = await readFile(path.join(repo, rel), 'utf8');
    } catch {
      continue;
    }
    const open = [];
    for (const line of body.split('\n')) {
      const m = /^\s*[-*]\s*\[ \]\s*(.+)$/.exec(line);
      if (m) open.push(m[1].trim().slice(0, 140));
    }
    if (open.length) return { file: rel, open: open.length, samples: open.slice(0, 5) };
  }
  return null;
}

async function scanCi(repo) {
  try {
    const raw = await readFile(path.join(repo, 'ops/ci/state/last-run.json'), 'utf8');
    const run = JSON.parse(raw);
    return {
      status: run.status,
      head: run.head,
      finishedAt: run.finishedAt,
      failedChecks: (run.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.cmd),
    };
  } catch {
    return null;
  }
}

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The CI/CD configuration itself is a signal: a commented-out check is a gate
 * that is not running, and an example deploy hook that was never enabled means
 * "continuous deployment" is still only continuous integration.
 *
 * Only commented lines that actually look like commands count — a `#` header
 * comment is documentation, not a disabled gate.
 */
const KNOWN_COMMANDS = new Set([
  'node', 'pnpm', 'npm', 'npx', 'yarn', 'bun', 'deno', 'make', 'sh', 'bash', 'zsh',
  'python', 'python3', 'pytest', 'go', 'cargo', 'tsc', 'turbo', 'vitest', 'jest',
  'eslint', 'prettier', 'docker', 'podman',
]);

function looksLikeCommand(body) {
  const first = body.split(/\s+/)[0] ?? '';
  return KNOWN_COMMANDS.has(first) || first.startsWith('./') || first.includes('/');
}

export async function scanCiConfig(repo, { checksFile = 'ops/ci/checks.conf' } = {}) {
  let raw;
  try {
    raw = await readFile(path.join(repo, checksFile), 'utf8');
  } catch {
    return null;
  }
  const disabledChecks = [];
  raw.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) return;
    const body = trimmed.replace(/^#+\s*/, '').replace(/\s+#.*$/, '').trim();
    if (body && looksLikeCommand(body)) disabledChecks.push({ line: idx + 1, command: body.slice(0, 160) });
  });
  return {
    file: checksFile,
    disabledChecks,
    deployHook: await exists(path.join(repo, 'ops/ci/deploy.sh')),
    deployExample: await exists(path.join(repo, 'ops/ci/deploy.sh.example')),
  };
}

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)|\.(?:test|spec)\./;
const OPS_SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh', '.py', '.go', '.rs']);

/**
 * `ops/*` areas that carry source code but no test of their own. Pure over the
 * walked file list so it is cheap to unit-test. Only `ops/` is considered: the
 * application packages have their own conventions and a wrong guess there is
 * worse than no idea at all.
 */
export function deriveUntestedAreas(files) {
  const areas = new Map();
  for (const rel of files) {
    const parts = rel.split('/');
    if (parts.length < 3 || parts[0] !== 'ops') continue;
    const area = `ops/${parts[1]}`;
    if (!areas.has(area)) areas.set(area, { dir: area, sourceFiles: [], tested: false });
    const entry = areas.get(area);
    if (TEST_PATH_RE.test(rel)) entry.tested = true;
    else if (OPS_SOURCE_EXT.has(path.extname(rel))) entry.sourceFiles.push(rel);
  }
  return [...areas.values()]
    .filter((a) => !a.tested && a.sourceFiles.length > 0)
    .map((a) => ({ dir: a.dir, sourceFiles: a.sourceFiles.sort().slice(0, 3), sourceCount: a.sourceFiles.length }))
    .sort((a, b) => b.sourceCount - a.sourceCount);
}

export async function collectSignals(repo) {
  const [head, branch, logSubjects, todos, backlog, ci, ciConfig, product] = await Promise.all([
    git(repo, ['rev-parse', 'HEAD']),
    git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repo, ['log', '-n', '60', '--pretty=%s']),
    scanTodos(repo),
    scanBacklog(repo),
    scanCi(repo),
    scanCiConfig(repo),
    scanProduct(repo),
  ]);

  const subjects = logSubjects ? logSubjects.split('\n') : [];
  const fixish = subjects.filter((s) => /^(fix|revert|hotfix|bugfix)\b/i.test(s));
  const untestedAreas = deriveUntestedAreas(await walkCode(repo));

  return {
    collectedAt: new Date().toISOString(),
    head: head || null,
    branch: branch || null,
    recentCommits: subjects.slice(0, 20),
    commitCount: subjects.length,
    fixishCommits: fixish.slice(0, 5),
    fixishRatio: subjects.length ? Number((fixish.length / subjects.length).toFixed(2)) : 0,
    todos,
    backlog,
    ci,
    ciConfig,
    untestedAreas,
    // The product's own feature inventory: the default source of ideas.
    product,
  };
}
