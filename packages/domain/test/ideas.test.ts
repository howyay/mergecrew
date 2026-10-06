import { describe, expect, it } from 'vitest';
import {
  IDEA_DECISIONS,
  IDEA_STATUSES,
  PICKABLE_IDEA_STATUS,
  decideIdea,
  ideaDecisionAction,
  isIdeaDecidable,
  isIdeaDecision,
  isIdeaStatus,
  isPickableIdea,
} from '../src/ideas.js';

/**
 * The idea gate is the contract between the API (which records a human
 * decision) and the runner (which seeds work). If these two disagree, an idea
 * either runs without approval or never runs at all.
 */
describe('the idea status vocabulary', () => {
  it('names the four states an idea can be in', () => {
    expect(IDEA_STATUSES).toEqual(['queued', 'approved', 'rejected', 'picked_up']);
  });

  it('recognises the statuses it defines and nothing else', () => {
    expect(isIdeaStatus('queued')).toBe(true);
    expect(isIdeaStatus('approved')).toBe(true);
    expect(isIdeaStatus('in_review')).toBe(false);
    expect(isIdeaStatus('')).toBe(false);
  });

  it('only treats approved as pickable, so nothing else can seed a run', () => {
    expect(PICKABLE_IDEA_STATUS).toBe('approved');
    expect(isPickableIdea('approved')).toBe(true);
    for (const status of ['queued', 'rejected', 'picked_up', 'unknown']) {
      expect(isPickableIdea(status)).toBe(false);
    }
  });

  it('lets a decision act on a queued idea only', () => {
    expect(isIdeaDecidable('queued')).toBe(true);
    for (const status of ['approved', 'rejected', 'picked_up']) {
      expect(isIdeaDecidable(status)).toBe(false);
    }
  });

  it('accepts the two decisions and rejects anything else', () => {
    expect(IDEA_DECISIONS).toEqual(['approve', 'reject']);
    expect(isIdeaDecision('approve')).toBe(true);
    expect(isIdeaDecision('reject')).toBe(true);
    expect(isIdeaDecision('approved')).toBe(false);
  });
});

describe('decideIdea', () => {
  it('approves a queued idea into the pickable status', () => {
    expect(decideIdea('queued', 'approve')).toBe('approved');
  });

  it('rejects a queued idea into a status the runner ignores', () => {
    const status = decideIdea('queued', 'reject');
    expect(status).toBe('rejected');
    expect(isPickableIdea(status)).toBe(false);
  });

  it('refuses a second decision instead of overwriting the first', () => {
    expect(() => decideIdea('approved', 'reject')).toThrow(/past the human gate/);
    expect(() => decideIdea('rejected', 'approve')).toThrow(/past the human gate/);
    expect(() => decideIdea('picked_up', 'approve')).toThrow(/past the human gate/);
  });
});

describe('ideaDecisionAction', () => {
  it('records the decision under a stable audit action', () => {
    expect(ideaDecisionAction('approve')).toBe('idea.approved');
    expect(ideaDecisionAction('reject')).toBe('idea.rejected');
  });
});
