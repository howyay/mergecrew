/**
 * Forge issues — from a PRD to a real ticket, or to an honest local queue.
 *
 * The pipeline runs unattended, so the failure that matters is not "the API
 * threw" but "nobody noticed that nothing was ever created". Every branch below
 * is built around that:
 *
 *   - a missing token or an undetected forge never touches the network: the
 *     issue is written next to the PRD and reported as `local`, with the reason;
 *   - an HTTP error is reported as `failed` with the real response body
 *     (truncated) and the request that produced it — never a URL or a number we
 *     did not receive, and never a thrown exception the caller forgets to catch;
 *   - the return value is JSON-serialisable because the caller persists it onto
 *     the idea, and `created` / `local` / `failed` must be distinguishable from
 *     that stored value alone.
 *
 * `createIssue` is the only writer here: it either creates a real issue or
 * leaves an explicit artifact that says it did not.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectForge as detectForgeImpl } from './prd.mjs';

/** Default output directory for locally queued issues, repo-relative. */
export const ISSUE_DIR = 'ops/pipeline/issues';

const USER_AGENT = 'mergecrew-pipeline';
const DEFAULT_TIMEOUT_MS = 20_000;
const REASON_LIMIT = 300;

const str = (v) => (v == null ? '' : String(v).trim());

/** Issue bodies are long; error bodies can be longer. Cap what gets stored. */
const truncate = (text) => String(text ?? '').slice(0, REASON_LIMIT);

const codePoints = (s) => Array.from(s);

/**
 * A stable issue title: the idea's title, prefixed for greppability.
 *
 * The prefix exists so a forge search for `[idea]` finds everything this
 * pipeline filed, including on repositories where the labels could not be
 * applied. Callers that want the bare title pass `prefix: ''`.
 *
 * @param {object} idea
 * @param {{ prefix?: string }} [options]
 * @returns {string} deterministic for a given idea
 */
export function issueTitle(idea, { prefix = '[idea]' } = {}) {
  // Code points, not UTF-16 units: a 120-unit slice can cut a surrogate pair in
  // half, which turns a title into a replacement character on the forge.
  const title = codePoints(str(idea?.title)).slice(0, 120).join('').trim();
  const p = str(prefix);
  return p ? `${p} ${title}`.trim() : title;
}

/**
 * Decide where an idea's issue should be filed.
 *
 * `remote`-derived detection is the default, but a repository can be hosted on
 * GitHub while its tickets belong somewhere else — including the common case
 * where the GitHub repository has issues turned off entirely, or where the
 * upstream is a mirror. `ISSUE_TRACKER` makes that explicit instead of
 * guessing, and the returned shape is exactly what `detectForge` returns, so
 * nothing downstream can tell the two apart:
 *
 *   ISSUE_TRACKER=auto    (default) whatever the git remote says
 *   ISSUE_TRACKER=forgejo self-hosted; FORGEJO_URL (default
 *                         http://127.0.0.1:3000) and optionally FORGEJO_REPO
 *                         (default: the remote's owner/name)
 *   ISSUE_TRACKER=github  force GitHub for a remote that is not on github.com
 *                         (then GITHUB_REPO=owner/repo is required)
 *   ISSUE_TRACKER=none    never leave the machine; always queue locally
 *
 * @param {{ repo?: string, remote?: string, env?: Record<string, string|undefined>, execImpl?: Function, detect?: Function }} [options]
 * @returns {{ provider: string, remote?: string, url: string|null, host: string|null, owner: string|null, name: string|null, reason?: string }}
 */
export function resolveForge({ repo, remote = 'origin', env = process.env, execImpl, detect } = {}) {
  const detected =
    typeof detect === 'function'
      ? detect({ repo, remote, execImpl })
      : detectForgeImpl({ repo, remote, execImpl });
  const want = str(env?.ISSUE_TRACKER).toLowerCase();
  if (!want || want === 'auto') return detected;
  if (want === 'none') {
    return {
      provider: 'none',
      url: null,
      host: null,
      owner: null,
      name: null,
      reason: `ISSUE_TRACKER=none (filing on ${detected.provider} is disabled)`,
    };
  }
  if (want === 'github') {
    if (detected.provider === 'github') return detected;
    const parts = splitRepo(str(env?.GITHUB_REPO) || `${str(detected.owner)}/${str(detected.name)}`);
    if (!parts) {
      return {
        provider: 'none',
        url: null,
        host: null,
        owner: null,
        name: null,
        reason:
          'ISSUE_TRACKER=github needs GITHUB_REPO as owner/repo when the remote is not on github.com',
      };
    }
    return {
      provider: 'github',
      remote: str(remote) || 'origin',
      url: 'https://api.github.com',
      host: 'api.github.com',
      owner: parts[0],
      name: parts[1],
      reason: 'ISSUE_TRACKER=github',
    };
  }
  if (want === 'forgejo') {
    const base = str(env?.FORGEJO_URL) || 'http://127.0.0.1:3000';
    const parts = splitRepo(str(env?.FORGEJO_REPO) || `${str(detected.owner)}/${str(detected.name)}`);
    if (!parts) {
      return {
        provider: 'none',
        url: null,
        host: null,
        owner: null,
        name: null,
        reason:
          'ISSUE_TRACKER=forgejo needs FORGEJO_REPO as owner/repo (the git remote has no usable owner/name)',
      };
    }
    return {
      provider: 'forgejo',
      remote: str(remote) || 'origin',
      url: base,
      host: hostOf(base),
      owner: parts[0],
      name: parts[1],
      reason: 'ISSUE_TRACKER=forgejo',
    };
  }
  return {
    provider: 'none',
    url: null,
    host: null,
    owner: null,
    name: null,
    reason: `unknown ISSUE_TRACKER=${want} (expected auto|github|forgejo|none)`,
  };
}

/** `owner/repo` -> `[owner, repo]`, or null when it is not a valid pair. */
function splitRepo(value) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(str(value));
  return m ? [m[1], m[2]] : null;
}

/**
 * Turn label names into the numeric ids Forgejo's issue API requires, creating
 * any label the repository does not have yet.
 *
 * Labels are not decoration here: `[idea]` in the title is the only marker that
 * survives when labels cannot be applied, so quietly dropping them would make a
 * successful create look like it was filed without them. A failure to resolve
 * labels is therefore reported as a `failed` issue rather than swallowed — the
 * caller can see exactly which request failed and why.
 *
 * @param {{ url: string, token: string, labels?: string[], fetchImpl: Function, timeoutMs: number, log?: Function, ideaId?: string }} options
 * @returns {Promise<number[]>}
 */
async function forgejoLabelIds({ url, token, labels, fetchImpl, timeoutMs, log = () => {}, ideaId = '' }) {
  const names = (Array.isArray(labels) ? labels : []).map((l) => str(l)).filter(Boolean);
  if (names.length === 0) return [];
  // `${base}/api/v1/repos/<owner>/<name>/issues` -> `${base}/api/v1/repos/<owner>/<name>/labels`
  const labelsUrl = url.replace(/\/issues$/, '/labels');
  const headers = headersFor('forgejo', token);

  const call = async (method, body) => {
    const res = await fetchImpl(labelsUrl, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = typeof res?.text === 'function' ? await res.text() : '';
    if (!res.ok) {
      throw new Error(`forgejo ${method} ${labelsUrl} failed: ${res.status} ${truncate(text)}`);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  const existing = await call('GET');
  const byName = new Map(
    (Array.isArray(existing) ? existing : [])
      .filter((l) => l && str(l.name))
      .map((l) => [str(l.name).toLowerCase(), l.id]),
  );

  const ids = [];
  for (const name of names) {
    let id = byName.get(name.toLowerCase());
    if (id === undefined) {
      const created = await call('POST', { name, color: '#0ea5e9' });
      id = created?.id;
      if (id === undefined) {
        throw new Error(`forgejo label "${name}" could not be created and does not exist`);
      }
      byName.set(name.toLowerCase(), id);
      log(`issue ${ideaId}: created label "${name}" on the tracker`);
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Create the issue, or queue it locally when it cannot be created.
 *
 * @param {object} options
 * @param {object} options.idea
 * @param {string} options.prd markdown body
 * @param {{ provider?: string, url?: string|null, host?: string|null, owner?: string|null, name?: string|null, reason?: string }} options.forge
 *   as returned by `detectForge`
 * @param {string} [options.repo] repository root; `dir` is resolved against it
 * @param {string} [options.token] defaults to `<PROVIDER>_TOKEN` (`GITHUB_TOKEN` / `FORGEJO_TOKEN`)
 * @param {Function} [options.fetchImpl]
 * @param {string[]} [options.labels]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.dir]
 * @param {Function} [options.log]
 * @returns {Promise<object>} one of
 *   `{ status: 'created', url, number, provider, request }`,
 *   `{ status: 'local',   url: null, number: null, file, reason }`,
 *   `{ status: 'failed',  status_code, reason, request }`
 */
export async function createIssue({
  idea,
  prd,
  forge,
  repo,
  token,
  fetchImpl = fetch,
  labels = ['mergecrew', 'idea'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dir = ISSUE_DIR,
  log = () => {},
} = {}) {
  const provider = str(forge?.provider) || 'none';
  const ideaId = str(idea?.id) || '(no id)';
  const body = typeof prd === 'string' ? prd : '';
  const title = issueTitle(idea);
  const envName = `${provider.toUpperCase()}_TOKEN`;
  // An explicitly passed null/undefined falls back to the environment; an empty
  // string does too, because a blank CI secret is a missing token, not a
  // credential, and must not produce a request with an empty auth header.
  const resolved = str(token) || str(process.env[envName]);

  if (provider === 'none' || !resolved) {
    const reason =
      provider === 'none'
        ? `no forge detected: ${str(forge?.reason) || 'forge.provider is none'}`
        : `no token for ${provider}: set ${envName} or pass token`;
    const file = await queueLocally({ repo, dir, idea, prd: body, title, provider, reason, forge });
    log(`issue ${ideaId}: queued locally (${reason})`);
    return { status: 'local', url: null, number: null, file, reason };
  }

  const method = 'POST';
  const url = issueUrl({ ...forge, provider });
  if (!url) {
    const reason =
      `cannot build an issue url: provider=${provider} owner=${str(forge?.owner) || '?'} ` +
      `name=${str(forge?.name) || '?'} url=${str(forge?.url) || 'null'}`;
    log(`issue ${ideaId}: failed (${reason})`);
    return { status: 'failed', status_code: null, reason, request: { method, url: null } };
  }

  const request = { method, url };
  const controller = new AbortController();
  const ms = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  // GitHub takes label names; Forgejo (like Gitea) takes label *ids* and answers
  // a name with a bare `cannot unmarshal string into ... labels of type int64`.
  // Resolve them first so the issue really carries its labels.
  let labelPayload;
  try {
    labelPayload =
      provider === 'forgejo'
        ? await forgejoLabelIds({
            url,
            token: resolved,
            labels,
            fetchImpl,
            timeoutMs: ms,
            log,
            ideaId,
          })
        : Array.isArray(labels)
        ? labels
        : [];
  } catch (error) {
    // Label resolution is part of filing: if the labels cannot be applied, the
    // issue is not created at all, and the reason must be the forge's own words
    // rather than a bare throw the caller has to guess at.
    const reason = error instanceof Error ? error.message : String(error);
    log(`issue ${ideaId}: failed (${reason})`);
    return { status: 'failed', status_code: null, url: null, number: null, reason, request };
  }
  const payload = { title, body, labels: labelPayload };
  const timer = setTimeout(() => controller.abort(), ms);

  let response;
  let raw = '';
  let parsed = null;
  try {
    response = await fetchImpl(url, {
      method,
      headers: headersFor(provider, resolved),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (typeof response?.text === 'function') raw = await response.text();
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    // A fake (or a proxy that only decoded JSON) may expose `json()` alone;
    // only reach for it when no body text was produced, because calling it
    // after `text()` on a real Response throws "body already used".
    if (parsed === null && !raw && typeof response?.json === 'function') {
      parsed = await response.json().catch(() => null);
      if (parsed !== null) raw = JSON.stringify(parsed);
    }
  } catch (err) {
    const reason =
      controller.signal.aborted || err?.name === 'AbortError'
        ? `timeout: no response within ${ms}ms (request aborted)`
        : `network error: ${err?.message ?? String(err)}`;
    log(`issue ${ideaId}: failed (${reason})`);
    return { status: 'failed', status_code: null, reason, request };
  } finally {
    clearTimeout(timer);
  }

  const statusCode = Number.isFinite(Number(response?.status)) ? Number(response.status) : null;
  const ok = statusCode === null ? response?.ok === true : statusCode >= 200 && statusCode < 300;

  if (!ok) {
    const reason = truncate(raw) || `HTTP ${statusCode ?? '?'} with an empty response body`;
    log(`issue ${ideaId}: failed (${statusCode ?? 'no status'}) ${reason}`);
    return { status: 'failed', status_code: statusCode, reason, request };
  }

  const createdUrl = str(parsed?.html_url) || str(parsed?.url);
  const number = Number.isFinite(Number(parsed?.number)) ? Number(parsed.number) : null;
  if (!createdUrl) {
    // A 2xx without a location is not an issue. Reporting `created` here would
    // hand the pipeline a ticket number nobody can open.
    const reason = `2xx response without html_url: ${truncate(raw) || '(empty body)'}`;
    log(`issue ${ideaId}: failed (${reason})`);
    return { status: 'failed', status_code: statusCode, reason, request };
  }

  log(`issue ${ideaId}: created ${createdUrl}`);
  return { status: 'created', url: createdUrl, number, provider, request };
}

/**
 * Build the create-issue endpoint.
 *
 * GitHub and Forgejo differ in both path and payload conventions:
 *   - GitHub: `POST https://api.github.com/repos/<owner>/<name>/issues`, and
 *     `labels` is an array of names. GitHub Enterprise keeps the same shape
 *     under `/api/v3`.
 *   - Forgejo/Gitea: `POST <base>/api/v1/repos/<owner>/<name>/issues`. Its API
 *     documents `labels` as numeric IDs, but it also accepts names and creates
 *     the label when it is missing, so this module sends the same string array
 *     as GitHub and lets the forge be the authority on what exists.
 *
 * Returns null when the forge object cannot address a repository; the caller
 * reports that as `failed` rather than posting somewhere invented.
 */
function issueUrl(forge) {
  const provider = str(forge?.provider);
  const owner = str(forge?.owner);
  const name = str(forge?.name);
  if (!owner || !name) return null;
  const explicit = str(forge?.url).replace(/\/+$/, '');
  const host = str(forge?.host);

  if (provider === 'github') {
    const hostname = (host || hostOf(explicit) || 'github.com').toLowerCase();
    if (hostname === 'github.com' || hostname === 'www.github.com') {
      return `https://api.github.com/repos/${owner}/${name}/issues`;
    }
    const base = explicit || `https://${host}`;
    return `${base}/api/v3/repos/${owner}/${name}/issues`;
  }

  // Forgejo/Gitea. Without an explicit base, fall back to the detected host —
  // plain HTTP only for a loopback host, because a local Forgejo on
  // localhost:3000 is http in practice and everything else is https.
  const base = explicit || defaultBase(host);
  if (!base) return null;
  return `${base}/api/v1/repos/${owner}/${name}/issues`;
}

function defaultBase(host) {
  if (!host) return '';
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
    ? `http://${host}`
    : `https://${host}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function headersFor(provider, token) {
  if (provider === 'github') {
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    };
  }
  return {
    authorization: `token ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  };
}

/**
 * Write the issue where a human will find it: title, why it is not on a forge,
 * and the PRD body. Atomic, like every other artifact in `ops/`.
 */
async function queueLocally({ repo, dir, idea, prd, title, provider, reason, forge }) {
  const id = str(idea?.id) || 'idea-unknown';
  const base = str(repo) || process.cwd();
  const target = path.isAbsolute(str(dir))
    ? path.join(str(dir), `${id}.md`)
    : path.join(base, str(dir), `${id}.md`);
  await mkdir(path.dirname(target), { recursive: true });

  const owner = str(forge?.owner);
  const name = str(forge?.name);
  const header = [
    '<!-- mergecrew pipeline: queued locally, NOT submitted to a forge -->',
    `# ${title}`,
    '',
    '- status: local (queued, no issue was created)',
    `- reason: ${reason}`,
    `- provider: ${provider}`,
    `- repository: ${owner && name ? `${owner}/${name}` : `(unknown, repo root ${path.basename(base)})`}`,
    `- idea: ${id}`,
    `- queued-at: ${new Date().toISOString()}`,
  ].join('\n');

  const contents = `${header}\n\n---\n\n${prd}\n`;
  const tmp = `${target}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, target);
  return path.relative(base, target).split(path.sep).join('/');
}
