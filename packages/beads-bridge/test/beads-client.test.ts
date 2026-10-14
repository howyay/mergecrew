import { afterEach, describe, expect, it, vi } from 'vitest';

import { BeadsClient } from '../src/beads-client.js';

/**
 * Stubs the execa module so BeadsClient's `run` sees canned stdout and
 * records the argv it was called with — no real bd invocation.
 */
const execMock = vi.fn();
vi.mock('execa', () => ({ execa: (...a: unknown[]) => execMock(...a) }));

afterEach(() => {
  execMock.mockReset();
});

function expectArgv(expected: string[]) {
  expect(execMock).toHaveBeenCalledTimes(1);
  const [cmd, args] = execMock.mock.calls[0] as unknown as [string, string[]];
  expect(cmd).toBe('bd');
  expect(args).toEqual(expected);
}

describe('BeadsClient argv shaping', () => {
  it('list: status/externalRef/limit become flags; limit defaults to 0', async () => {
    execMock.mockResolvedValueOnce({ stdout: '[]' });
    const c = new BeadsClient();
    await c.list({ status: 'open', externalRef: 'https://x.test/1' });
    expectArgv(['list', '--json', '--limit', '0', '--status', 'open', '--external-ref', 'https://x.test/1']);
  });

  it('show returns the first row (bd show --json is an array)', async () => {
    execMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ id: 'me-1', title: 't' }]),
    });
    const c = new BeadsClient();
    await expect(c.show('me-1')).resolves.toEqual({ id: 'me-1', title: 't' });
    expectArgv(['show', 'me-1', '--json']);
  });

  it('create: single object result; labels joined; externalRef passed', async () => {
    execMock.mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'me-2', title: 'T' }) });
    const c = new BeadsClient();
    const bead = await c.create({
      title: 'T',
      description: 'd',
      labels: ['a', 'b'],
      priority: 1,
      externalRef: 'https://x.test/2',
    });
    expect(bead.id).toBe('me-2');
    expectArgv([
      'create', 'T', '--json', '-d', 'd', '--labels', 'a,b', '--priority', '1',
      '--external-ref', 'https://x.test/2',
    ]);
  });

  it('update: omits unset fields, repeats add-label per label', async () => {
    execMock.mockResolvedValueOnce({ stdout: '[]' });
    const c = new BeadsClient();
    await c.update('me-3', { title: 'n', addLabels: ['x', 'y'], priority: 0 });
    expectArgv(['update', 'me-3', '--json', '--title', 'n', '--add-label', 'x', '--add-label', 'y', '--priority', '0']);
  });

  it('close passes --reason before --json', async () => {
    execMock.mockResolvedValueOnce({ stdout: '[]' });
    const c = new BeadsClient();
    await c.close('me-4', 'done');
    expectArgv(['close', 'me-4', '--reason', 'done', '--json']);
  });

  it('parses stdout as JSON', async () => {
    execMock.mockResolvedValueOnce({ stdout: '[{"id":"me-5"}]' });
    const c = new BeadsClient();
    await expect(c.list()).resolves.toEqual([{ id: 'me-5' }]);
  });
});
