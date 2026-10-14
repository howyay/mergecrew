import { describe, expect, it, vi } from 'vitest';

import type { Issue } from '@mergecrew/adapters-tracker';
import { reconcile, renderReport } from '../src/reconcile.js';
import type { Bead } from '../src/types.js';

function trackerOf(issues: Issue[]) {
  return { listIssues: vi.fn(async () => issues) };
}

function beadsOf(listRows: Bead[], created: Bead[] = []) {
  const create = vi.fn(async () => created.shift()!);
  return { list: vi.fn(async () => listRows), create };
}

const issueA: Issue = {
  id: '1',
  title: 'A',
  body: 'body-a',
  url: 'https://t.test/1',
  labels: ['bug'],
  createdAt: '2026-01-01T00:00:00Z',
};
const issueB: Issue = {
  id: '2',
  title: 'B',
  labels: [],
  createdAt: '2026-01-02T00:00:00Z',
};

describe('reconcile — dry-run (default)', () => {
  it('reports matched/missing/orphaned and creates nothing', async () => {
    const tracker = trackerOf([issueA, issueB]);
    const beads = beadsOf([
      { id: 'me-1', title: 'A', external_ref: 'https://t.test/1', labels: ['tracker-import'] },
      { id: 'me-9', title: 'stale export', labels: ['tracker-import'] },
    ]);
    const report = await reconcile(tracker, beads, {});
    expect(tracker.listIssues).toHaveBeenCalledWith({ status: undefined, max: undefined });
    expect(beads.create).not.toHaveBeenCalled();
    expect(report.matched).toEqual([{ issueId: '1', beadId: 'me-1', title: 'A' }]);
    expect(report.missing).toEqual([{ issueId: '2', title: 'B' }]);
    expect(report.orphanedBeads).toEqual([{ beadId: 'me-9', title: 'stale export' }]);
  });

  it('ignores beads without the tracker-import label', async () => {
    const tracker = trackerOf([issueA]);
    const beads = beadsOf([
      { id: 'me-2', title: 'A', external_ref: 'https://t.test/1', labels: [] },
      { id: 'me-3', title: 'A', external_ref: 'https://t.test/1', labels: ['tracker-import'] },
    ]);
    const report = await reconcile(tracker, beads, {});
    // the unlabeled same-ref bead is invisible to the diff
    expect(report.matched).toEqual([{ issueId: '1', beadId: 'me-3', title: 'A' }]);
    expect(report.orphanedBeads).toEqual([]);
  });
});

describe('reconcile — write mode', () => {
  it('creates beads only for missing issues, tagging the created id', async () => {
    const tracker = trackerOf([issueA, issueB]);
    const beads = beadsOf(
      [{ id: 'me-1', title: 'A', external_ref: 'https://t.test/1', labels: ['tracker-import'] }],
      [{ id: 'me-new', title: 'B' }],
    );
    const report = await reconcile(tracker, beads, { write: true });
    expect(beads.create).toHaveBeenCalledTimes(1);
    expect(beads.create).toHaveBeenCalledWith({
      title: 'B',
      description: '',
      labels: ['tracker-import'],
      externalRef: undefined,
    });
    expect(report.missing).toEqual([{ issueId: '2', title: 'B', createdBeadId: 'me-new' }]);
  });
});

describe('renderReport', () => {
  it('renders counts and rows', () => {
    const text = renderReport({
      matched: [{ issueId: '1', beadId: 'me-1', title: 'A' }],
      missing: [{ issueId: '2', title: 'B', createdBeadId: 'me-new' }],
      orphanedBeads: [{ beadId: 'me-9', title: 'stale' }],
    });
    expect(text).toContain('matched: 1');
    expect(text).toContain('= 1 <-> me-1 A');
    expect(text).toContain('missing (would create): 1');
    expect(text).toContain('+ 2 B -> created me-new');
    expect(text).toContain('orphaned beads (exported, issue gone): 1');
    expect(text).toContain('- me-9 stale');
  });
});