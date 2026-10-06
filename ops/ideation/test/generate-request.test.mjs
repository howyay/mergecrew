/**
 * The web app's "Generate" button can only leave a file behind. If the service
 * never claims it, the button lies; if it claims without deleting, every sweep
 * runs a cycle forever. Both are cheap to get wrong and expensive to notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { takeGenerateRequest } from '../server.mjs';

test('a request file is claimed exactly once, then gone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ideation-request-'));
  const file = path.join(dir, 'generate.request');
  await writeFile(file, JSON.stringify({ at: '2026-10-03T00:00:00.000Z', requestedBy: 'a@b.c' }));

  const first = await takeGenerateRequest(file);
  assert.equal(first.requestedBy, 'a@b.c');
  assert.equal(await takeGenerateRequest(file), null, 'the second sweep must not run another cycle');
  await assert.rejects(() => readFile(file, 'utf8'), 'the request must be deleted, not replayed');

  await rm(dir, { recursive: true, force: true });
});

test('a missing or malformed request does not throw and does not pretend to be a request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ideation-request-'));
  const file = path.join(dir, 'generate.request');

  assert.equal(await takeGenerateRequest(file), null);

  await writeFile(file, 'not json at all');
  const malformed = await takeGenerateRequest(file);
  assert.equal(malformed.malformed, true);
  assert.equal(malformed.requestedBy, 'unknown');
  assert.equal(await takeGenerateRequest(file), null, 'a malformed request is still consumed');

  await rm(dir, { recursive: true, force: true });
});
