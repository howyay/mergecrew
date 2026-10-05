import { describe, expect, it } from 'vitest';
import { RepeatGuard, toolCallSignature } from '../src/repeat-guard.js';

describe('toolCallSignature', () => {
  it('ignores object key order', () => {
    const a = toolCallSignature('repo.write_file', { path: 'a.ts', content: 'x' });
    const b = toolCallSignature('repo.write_file', { content: 'x', path: 'a.ts' });
    expect(a).toBe(b);
  });

  it('normalizes nested key order', () => {
    const a = toolCallSignature('tracker.create_issue', { meta: { b: 1, a: 2 }, title: 't' });
    const b = toolCallSignature('tracker.create_issue', { title: 't', meta: { a: 2, b: 1 } });
    expect(a).toBe(b);
  });

  it('distinguishes different arguments', () => {
    expect(toolCallSignature('repo.read_file', { path: 'a.ts' })).not.toBe(
      toolCallSignature('repo.read_file', { path: 'b.ts' }),
    );
  });

  it('distinguishes different skills with identical args', () => {
    expect(toolCallSignature('repo.read_file', { path: 'a.ts' })).not.toBe(
      toolCallSignature('repo.delete_file', { path: 'a.ts' }),
    );
  });

  it('handles non-object args', () => {
    expect(toolCallSignature('skill', null)).toBe(toolCallSignature('skill', null));
    expect(toolCallSignature('skill', 'x')).not.toBe(toolCallSignature('skill', 'y'));
  });
});

describe('RepeatGuard', () => {
  it('trips on the third identical consecutive call', () => {
    const g = new RepeatGuard();
    const sig = toolCallSignature('repo.read_file', { path: 'a.ts' });
    expect(g.observe(sig)).toBe(false);
    expect(g.observe(sig)).toBe(false);
    expect(g.observe(sig)).toBe(true);
  });

  it('does not trip on alternating calls', () => {
    const g = new RepeatGuard();
    const a = toolCallSignature('repo.read_file', { path: 'a.ts' });
    const b = toolCallSignature('repo.read_file', { path: 'b.ts' });
    for (const sig of [a, b, a, b, a, b]) expect(g.observe(sig)).toBe(false);
  });

  it('resets the streak when a different call interleaves', () => {
    const g = new RepeatGuard();
    const a = toolCallSignature('repo.read_file', { path: 'a.ts' });
    const b = toolCallSignature('repo.read_file', { path: 'b.ts' });
    expect(g.observe(a)).toBe(false);
    expect(g.observe(a)).toBe(false);
    expect(g.observe(b)).toBe(false); // streak resets
    expect(g.observe(a)).toBe(false);
    expect(g.observe(a)).toBe(false);
    expect(g.observe(a)).toBe(true);
  });

  it('honors a custom limit', () => {
    const g = new RepeatGuard(2);
    const sig = toolCallSignature('build.run_unit_tests', {});
    expect(g.observe(sig)).toBe(false);
    expect(g.observe(sig)).toBe(true);
  });
});
