import { describe, expect, it } from 'vitest';

import type { Issue } from '@mergecrew/adapters-tracker';
import { beadMatchesIssue, beadToIssue, issueToBeadInput } from '../src/mapper.js';
import type { Bead } from '../src/types.js';

const issue: Issue = {
  id: '42',
  title: 'Fix login flake',
  body: 'Steps to repro…',
  status: 'open',
  url: 'https://github.com/acme/repo/issues/42',
  labels: ['bug', 'ci'],
  createdAt: '2026-10-05T12:43:54Z',
};

describe('issueToBeadInput', () => {
  it('maps title/body/url and tags tracker-import', () => {
    const input = issueToBeadInput(issue);
    expect(input.title).toBe('Fix login flake');
    expect(input.description).toBe('Steps to repro…');
    expect(input.externalRef).toBe('https://github.com/acme/repo/issues/42');
    expect(input.labels).toEqual(['tracker-import', 'bug', 'ci']);
  });

  it('defaults empty body and tolerates missing labels/url', () => {
    const input = issueToBeadInput({ id: '7', title: 't', labels: [], createdAt: '' });
    expect(input.description).toBe('');
    expect(input.externalRef).toBeUndefined();
    expect(input.labels).toEqual(['tracker-import']);
  });
});

describe('beadToIssue', () => {
  it('round-trips back to the tracker shape', () => {
    const bead: Bead = {
      id: 'me-abc',
      title: 'Fix login flake',
      description: 'Steps to repro…',
      status: 'open',
      external_ref: 'https://github.com/acme/repo/issues/42',
      labels: ['tracker-import', 'bug', 'ci'],
      created_at: '2026-10-05T12:43:54Z',
    };
    const back = beadToIssue(bead);
    // labels pass through verbatim — the bead keeps its tracker-import tag
    expect(back).toEqual({ ...issue, id: 'me-abc', labels: ['tracker-import', ...issue.labels] });
  });

  it('fills empty strings for unhydrated fields', () => {
    const back = beadToIssue({ id: 'me-x', title: 't' });
    expect(back.body).toBe('');
    expect(back.url).toBeUndefined();
    expect(back.labels).toEqual([]);
    expect(back.createdAt).toBe('');
  });
});

describe('beadMatchesIssue', () => {
  it('matches on external_ref when both sides have one', () => {
    const bead: Bead = { id: 'me-abc', title: 'Different title', external_ref: issue.url };
    expect(beadMatchesIssue(bead, issue)).toBe(true);
  });

  it('does not match a different external_ref even with equal titles', () => {
    const bead: Bead = { id: 'me-abc', title: issue.title, external_ref: 'https://other/1' };
    expect(beadMatchesIssue(bead, issue)).toBe(false);
  });

  it('falls back to exact title when either side lacks a ref', () => {
    expect(beadMatchesIssue({ id: 'b', title: issue.title }, issue)).toBe(true);
    expect(beadMatchesIssue({ id: 'b', title: 'other' }, { ...issue, url: undefined })).toBe(false);
  });
});
