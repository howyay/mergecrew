/**
 * Tests for issue creation.
 *
 * The load-bearing assertions here are the negative ones: no token and no forge
 * must mean `local` without a single network call, and an HTTP error must be
 * reported with the forge's own words. A test that only checked the happy path
 * would let a fabricated URL ship, which is the one failure this module exists
 * to prevent.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createIssue, issueTitle, resolveForge } from '../lib/issue.mjs';

const idea = () => ({
  id: 'idea-740f1748',
  title: '启用被注释掉的 CI 检查：pnpm --filter @mergecrew/domain test',
  source: 'disabled-check',
  evidence: ['ops/ci/checks.conf:12 pnpm --filter @mergecrew/domain test'],
  rationale: 'ops/ci/checks.conf 第 12 行把这条检查注释掉了。',
  effortHint: 'small',
  features: { impact: 22, confidence: 14, effort: 20, risk: 12 },
  score: 68,
  band: 'should',
});

const PRD =
  '# 启用被注释掉的 CI 检查：pnpm --filter @mergecrew/domain test\n\n## Summary\n\nBody.\n';

const githubForge = () => ({
  provider: 'github',
  remote: 'origin',
  url: 'https://github.com',
  owner: 'howyay',
  name: 'mergecrew',
  host: 'github.com',
  reason: 'github.com remote',
});

const forgejoForge = () => ({
  provider: 'forgejo',
  remote: 'origin',
  url: 'http://localhost:3000',
  owner: 'acme',
  name: 'widgets',
  host: 'localhost:3000',
  reason: 'non-github host',
});

/** Set env vars for one call, then restore exactly what was there before. */
const withEnv = async (vars, fn) => {
  const previous = new Map();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** A fetch stand-in that records every call and never really goes online. */
const recordingFetch = (respond) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  impl.calls = calls;
  return impl;
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const makeRepo = () => mkdtemp(path.join(tmpdir(), 'mergecrew-issue-'));

test('createIssue queues locally when no forge was detected, without any network call', async () => {
  const repo = await makeRepo();
  try {
    const fetchImpl = recordingFetch(() => {
      throw new Error('fetch must not be called when the forge is unknown');
    });
    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: {
        provider: 'none',
        url: null,
        owner: null,
        name: null,
        reason: 'no git remote: not a git repository',
      },
      repo,
      fetchImpl,
    });

    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(result.status, 'local');
    assert.equal(result.url, null);
    assert.equal(result.number, null);
    assert.equal(result.file, 'ops/pipeline/issues/idea-740f1748.md');
    assert.match(result.reason, /not a git repository/);

    const contents = await readFile(path.join(repo, result.file), 'utf8');
    assert.match(contents, /queued locally, NOT submitted to a forge/);
    assert.match(contents, /no forge detected: no git remote: not a git repository/);
    assert.ok(contents.includes(issueTitle(idea())), 'the local file is titled like the issue');
    assert.ok(contents.includes(PRD), 'the PRD travels with the ticket');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue queues locally when the token for the detected provider is missing', async () => {
  const repo = await makeRepo();
  try {
    await withEnv({ GITHUB_TOKEN: undefined, FORGEJO_TOKEN: undefined }, async () => {
      const fetchImpl = recordingFetch(() =>
        jsonResponse(201, { html_url: 'https://x', number: 1 }),
      );

      const absent = await createIssue({
        idea: idea(),
        prd: PRD,
        forge: githubForge(),
        repo,
        fetchImpl,
      });
      assert.equal(absent.status, 'local');
      assert.match(absent.reason, /set GITHUB_TOKEN or pass token/);
      assert.match(absent.reason, /no token for github/);

      // A blank CI secret is a missing token, not a credential.
      const blank = await createIssue({
        idea: idea(),
        prd: PRD,
        forge: githubForge(),
        repo,
        token: '   ',
        fetchImpl,
      });
      assert.equal(blank.status, 'local');
      assert.equal(fetchImpl.calls.length, 0);
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue falls back to the provider environment variable', async () => {
  const repo = await makeRepo();
  try {
    await withEnv({ GITHUB_TOKEN: 'env-token' }, async () => {
      const fetchImpl = recordingFetch(() =>
        jsonResponse(201, { html_url: 'https://github.com/howyay/mergecrew/issues/7', number: 7 }),
      );
      const result = await createIssue({
        idea: idea(),
        prd: PRD,
        forge: githubForge(),
        repo,
        fetchImpl,
      });
      assert.equal(result.status, 'created');
      assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer env-token');
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue posts to GitHub with the documented headers and body', async () => {
  const repo = await makeRepo();
  try {
    const fetchImpl = recordingFetch(() =>
      jsonResponse(201, { html_url: 'https://github.com/howyay/mergecrew/issues/12', number: 12 }),
    );
    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: githubForge(),
      repo,
      token: 'gh-token',
      fetchImpl,
    });

    assert.equal(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, 'https://api.github.com/repos/howyay/mergecrew/issues');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer gh-token');
    assert.equal(init.headers.accept, 'application/vnd.github+json');
    assert.equal(init.headers['x-github-api-version'], '2022-11-28');
    assert.equal(init.headers['user-agent'], 'mergecrew-pipeline');
    assert.deepEqual(JSON.parse(init.body), {
      title: issueTitle(idea()),
      body: PRD,
      labels: ['mergecrew', 'idea'],
    });

    assert.equal(result.status, 'created');
    assert.equal(result.url, 'https://github.com/howyay/mergecrew/issues/12');
    assert.equal(result.number, 12);
    assert.equal(result.provider, 'github');
    assert.deepEqual(result.request, { method: 'POST', url });
    assert.deepEqual(
      JSON.parse(JSON.stringify(result)),
      result,
      'the result is stored on the idea, so it must survive JSON',
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue resolves Forgejo label names to ids and creates the missing ones', async () => {
  const repo = await makeRepo();
  try {
    // Shaped after the real API, which is the only reason this test earns its
    // keep: sending label *names* to Forgejo returns
    //   422 {"message":"[]: json: cannot unmarshal string into Go struct field
    //        CreateIssueOption.labels of type int64"}
    // so ids (and every label that does not exist yet) must be resolved first.
    const fetchImpl = recordingFetch((url, init) => {
      if (url.endsWith('/labels') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, [{ id: 7, name: 'mergecrew' }]);
      }
      if (url.endsWith('/labels')) return jsonResponse(201, { id: 9, name: 'idea' });
      return jsonResponse(201, {
        html_url: 'http://localhost:3000/acme/widgets/issues/3',
        number: 3,
      });
    });

    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: forgejoForge(),
      repo,
      token: 'fj-token',
      fetchImpl,
    });

    assert.deepEqual(
      fetchImpl.calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`),
      [
        'GET http://localhost:3000/api/v1/repos/acme/widgets/labels',
        'POST http://localhost:3000/api/v1/repos/acme/widgets/labels',
        'POST http://localhost:3000/api/v1/repos/acme/widgets/issues',
      ],
      'existing labels are reused, missing ones are created, then the issue is filed',
    );

    const { url, init } = fetchImpl.calls[2];
    assert.equal(url, 'http://localhost:3000/api/v1/repos/acme/widgets/issues');
    assert.equal(init.headers.authorization, 'token fj-token');
    assert.equal(init.headers.accept, 'application/json');
    assert.equal(
      init.headers['x-github-api-version'],
      undefined,
      'no GitHub-only headers on Forgejo',
    );
    const body = JSON.parse(init.body);
    assert.deepEqual(body.labels, [7, 9], 'Forgejo takes label ids, not names');
    assert.ok(body.labels.every((l) => typeof l === 'number'));

    assert.equal(result.status, 'created');
    assert.equal(result.number, 3);
    assert.equal(result.provider, 'forgejo');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue fails loudly when a Forgejo label cannot be resolved', async () => {
  const repo = await makeRepo();
  try {
    const fetchImpl = recordingFetch((url, init) => {
      if (url.endsWith('/labels') && (init?.method ?? 'GET') === 'GET') return jsonResponse(200, []);
      if (url.endsWith('/labels')) {
        return jsonResponse(403, { message: 'token does not have permission to create labels' });
      }
      throw new Error('the issue must not be created when its labels could not be applied');
    });

    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: forgejoForge(),
      repo,
      token: 'fj-token',
      fetchImpl,
    });

    assert.equal(result.status, 'failed');
    assert.match(result.reason, /403/);
    assert.match(result.reason, /permission to create labels/);
    assert.equal(result.number, null, 'no issue number is invented');
    assert.equal(
      fetchImpl.calls.filter((c) => c.url.endsWith('/issues')).length,
      0,
      'no issue was created',
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('resolveForge defaults to the remote and honours ISSUE_TRACKER', () => {
  const detect = () => githubForge();

  assert.deepEqual(
    resolveForge({ detect, env: {} }),
    githubForge(),
    'unset ISSUE_TRACKER keeps the remote-derived forge',
  );
  assert.deepEqual(resolveForge({ detect, env: { ISSUE_TRACKER: 'auto' } }), githubForge());

  const forgejo = resolveForge({
    detect,
    env: { ISSUE_TRACKER: 'forgejo', FORGEJO_REPO: 'haoye/mergecrew' },
  });
  assert.equal(forgejo.provider, 'forgejo');
  assert.equal(forgejo.url, 'http://127.0.0.1:3000', 'loopback default');
  assert.equal(forgejo.host, '127.0.0.1:3000');
  assert.equal(forgejo.owner, 'haoye');
  assert.equal(forgejo.name, 'mergecrew');

  const explicit = resolveForge({
    detect,
    env: {
      ISSUE_TRACKER: 'forgejo',
      FORGEJO_URL: 'https://git.example.com/',
      FORGEJO_REPO: 'team/app',
    },
  });
  assert.equal(explicit.url, 'https://git.example.com/');
  assert.equal(explicit.host, 'git.example.com');

  const inherited = resolveForge({ detect, env: { ISSUE_TRACKER: 'forgejo' } });
  assert.equal(inherited.owner, 'howyay', 'falls back to the remote owner');
  assert.equal(inherited.name, 'mergecrew');

  const off = resolveForge({ detect, env: { ISSUE_TRACKER: 'none' } });
  assert.equal(off.provider, 'none');
  assert.match(off.reason, /ISSUE_TRACKER=none/);

  // A typo must not silently fall back to GitHub: that is how an idea gets
  // filed on the wrong forge with nobody noticing.
  const typo = resolveForge({ detect, env: { ISSUE_TRACKER: 'forgejoo' } });
  assert.equal(typo.provider, 'none');
  assert.match(typo.reason, /unknown ISSUE_TRACKER=forgejoo/);
});

test('createIssue derives a Forgejo base from the host when the remote carried no scheme', async () => {
  const repo = await makeRepo();
  try {
    // The labels are resolved before the issue, so the fake forge has to answer
    // the label lookup as well; only the issue call's URL is under assertion.
    const fetchImpl = recordingFetch((url) =>
      url.endsWith('/labels')
        ? jsonResponse(200, [
            { id: 1, name: 'mergecrew' },
            { id: 2, name: 'idea' },
          ])
        : jsonResponse(201, {
            html_url: 'https://git.example.com/team/project/issues/1',
            number: 1,
          }),
    );
    await createIssue({
      idea: idea(),
      prd: PRD,
      forge: {
        ...forgejoForge(),
        url: null,
        owner: 'team',
        name: 'project',
        host: 'git.example.com',
      },
      repo,
      token: 'fj-token',
      fetchImpl,
    });
    const issueCall = fetchImpl.calls.find((c) => c.url.endsWith('/issues'));
    assert.equal(issueCall.url, 'https://git.example.com/api/v1/repos/team/project/issues');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue reports an HTTP error with the response body and never claims success', async () => {
  const repo = await makeRepo();
  try {
    const fetchImpl = recordingFetch(() => jsonResponse(401, { message: 'Bad credentials' }));
    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: githubForge(),
      repo,
      token: 'stale',
      fetchImpl,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.status_code, 401);
    assert.match(result.reason, /Bad credentials/);
    assert.equal(result.url, undefined, 'no URL may be invented for a failed create');
    assert.equal(result.number, undefined);
    assert.equal(result.request.url, 'https://api.github.com/repos/howyay/mergecrew/issues');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue truncates a huge error body to 300 characters', async () => {
  const repo = await makeRepo();
  try {
    const fetchImpl = recordingFetch(() => jsonResponse(500, 'E'.repeat(500)));
    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: githubForge(),
      repo,
      token: 't',
      fetchImpl,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.status_code, 500);
    assert.equal(result.reason.length, 300);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue turns a thrown fetch into a failed result, not an exception', async () => {
  const repo = await makeRepo();
  try {
    const fetchImpl = recordingFetch(() => {
      throw new Error('fetch failed');
    });
    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: githubForge(),
      repo,
      token: 't',
      fetchImpl,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.status_code, null);
    assert.equal(result.reason, 'network error: fetch failed');
    assert.deepEqual(result.request, {
      method: 'POST',
      url: 'https://api.github.com/repos/howyay/mergecrew/issues',
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue aborts a hanging request after timeoutMs', async () => {
  const repo = await makeRepo();
  try {
    const impl = recordingFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: githubForge(),
      repo,
      token: 't',
      fetchImpl: impl,
      timeoutMs: 10,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /timeout: no response within 10ms \(request aborted\)/);
    assert.equal(
      impl.calls[0].init.signal.aborted,
      true,
      'the request must actually be aborted, not merely abandoned',
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue refuses to call a 2xx without a URL a created issue', async () => {
  const repo = await makeRepo();
  try {
    const fetchImpl = recordingFetch(() => jsonResponse(201, { id: 1 }));
    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: githubForge(),
      repo,
      token: 't',
      fetchImpl,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.status_code, 201);
    assert.match(result.reason, /2xx response without html_url/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('createIssue fails loudly when the forge cannot address a repository', async () => {
  const repo = await makeRepo();
  try {
    const fetchImpl = recordingFetch(() => jsonResponse(201, { html_url: 'https://x', number: 1 }));
    const result = await createIssue({
      idea: idea(),
      prd: PRD,
      forge: { ...githubForge(), owner: null, name: null },
      repo,
      token: 't',
      fetchImpl,
    });
    assert.equal(result.status, 'failed');
    assert.equal(fetchImpl.calls.length, 0, 'a URL that cannot be built must not be guessed');
    assert.match(result.reason, /cannot build an issue url: provider=github owner=\? name=\?/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('issueTitle is deterministic, prefixed on request and capped at 120 code points', () => {
  const base = issueTitle(idea());
  assert.equal(base, '[idea] 启用被注释掉的 CI 检查：pnpm --filter @mergecrew/domain test');
  assert.equal(issueTitle(idea()), base);
  assert.equal(issueTitle(idea(), { prefix: '' }), idea().title);

  const long = issueTitle({ title: 'x'.repeat(200) });
  assert.equal(long, `[idea] ${'x'.repeat(120)}`);

  // Emoji are two UTF-16 units each; slicing by units would cut one in half.
  const emoji = issueTitle({ title: '🙂'.repeat(130) });
  assert.equal(Array.from(emoji.replace('[idea] ', '')).length, 120);
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji),
    'no lone surrogate may reach the forge',
  );
});
