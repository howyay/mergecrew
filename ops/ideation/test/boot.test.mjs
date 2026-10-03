/**
 * The deck is a JSON file that outlives the code that wrote it, and it is read by
 * a service that restarts independently. This boots the *real* server against a
 * state file in the old shape — the situation on 2026-10-03, when six cards
 * predated kinds, stages and the timeline — and asserts the restart brings them
 * to the swipe gate instead of leaving them as drafts nobody picks up.
 *
 * A unit test on the store cannot catch this: the failure is a missing call in
 * boot(), and it looks like "the deck is empty" rather than like an error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);

async function waitFor(label, check, { timeoutMs = 20_000, everyMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A check that throws is a check that is not ready yet: the first poll races
    // the listener, and turning that into a test failure would only measure luck.
    let value = null;
    try {
      value = await check();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

test('a restart on an older state file brings its drafts to the swipe gate', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'idea-boot-'));
  const stateFile = path.join(fixture, 'ideas.json');
  let child = null;
  try {
    await mkdir(path.join(fixture, 'apps/api'), { recursive: true });
    await writeFile(path.join(fixture, 'apps/api/handler.ts'), 'export const handler = () => {};\n', 'utf8');
    // A record from before the deck had kinds, stages or a timeline.
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-10-02T20:00:00.000Z',
          lastGeneration: null,
          ideas: [
            {
              id: 'idea-legacy1',
              fingerprint: 'disabled-check:x',
              title: 'Enable the parked check',
              source: 'disabled-check',
              status: 'pending',
              score: 68,
              band: 'should',
              effortHint: 'small',
              rationale: 'a check is commented out',
              evidence: ['ops/ci/checks.conf:13 pnpm -w typecheck'],
              createdAt: '2026-10-02T19:00:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    child = spawn(process.execPath, ['ops/ideation/server.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MERGECREW_REPO: fixture,
        IDEATION_STATE_FILE: stateFile,
        IDEATION_EXECUTION_DIR: path.join(fixture, 'execution'),
        IDEATION_HOST: '127.0.0.1',
        IDEATION_PORT: '0',
        IDEATION_INTERVAL_MINUTES: '600',
        IDEA_SOURCES: 'chores',
        IDEATION_SPECIFIER: 'heuristic',
        EXECUTOR: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });

    // The service prints the port it actually bound, which is how a `0` port is
    // usable from a test at all.
    const base = await waitFor('the service to announce its port', () => {
      const m = out.match(/ideation service on (http:\/\/127\.0\.0\.1:\d+)/);
      return m ? m[1] : null;
    });

    const idea = await waitFor('the legacy card to reach the swipe gate', async () => {
      const body = await fetch(`${base}/api/ideas`).then((r) => r.json());
      const found = (body.ideas ?? []).find((i) => i.id === 'idea-legacy1');
      return found?.stage === 'specified' ? found : null;
    });

    assert.equal(idea.kind, 'technical', 'a chore must not arrive on the deck as a user-facing feature');
    assert.equal(idea.stage, 'specified');
    assert.equal(idea.spec.specifiedBy, 'heuristic');
    assert.match(idea.spec.file, /ops\/ideation\/specs\/idea-legacy1\.md$/);
    assert.equal(typeof idea.triage?.priority, 'string');
    // The gate the UI filters on: pending, specified, not stale.
    assert.equal(idea.status, 'pending');
    assert.equal(idea.stale, false);
    assert.equal(existsSync(path.join(fixture, idea.spec.file)), true);
    assert.match(await readFile(path.join(fixture, idea.spec.file), 'utf8'), /## Acceptance criteria/);

    // The migration is persisted, not re-derived on every read.
    await waitFor('the migrated record to be written back', async () => {
      const saved = JSON.parse(await readFile(stateFile, 'utf8'));
      return saved.version === 2 && saved.ideas[0].stage === 'specified';
    });
  } finally {
    child?.kill('SIGTERM');
    await rm(fixture, { recursive: true, force: true });
  }
});
