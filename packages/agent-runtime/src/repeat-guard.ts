/**
 * Clutter control (#mcp-67d). The agent loop already caps *how many* tool
 * calls a step may make (`maxToolCallsPerStep`); this guard caps *how many
 * times in a row* it may make the same one. An agent that re-issues the
 * identical call is not making progress — it is looping, and every repeat
 * is another round-trip of tokens. Three identical consecutive calls is the
 * cheapest unambiguous signal, so that is the line we draw.
 *
 * The guard only sees signatures, never skills or args, so it is pure and
 * cheap to unit-test. It is deliberately *consecutive*-only: an agent that
 * legitimately re-reads one file, then edits another, then re-reads the
 * first, never trips it. Alternating loops are left to the tool-call budget.
 */

/** Consecutive identical tool calls tolerated before the step is failed. */
export const MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS = 3;

/**
 * Canonical signature for one tool call: the skill name plus a key-sorted,
 * recursively-stable serialization of its arguments. Two calls with the
 * same logical arguments but a different key order must produce the same
 * signature, or the guard would miss real loops on models that reorder keys.
 */
export function toolCallSignature(skillName: string, args: unknown): string {
  return `${skillName}\u0000${JSON.stringify(normalize(args))}`;
}

/**
 * Tracks consecutive identical signatures. Feed each tool call in order;
 * `observe` returns `true` the moment the run has repeated itself `limit`
 * times in a row.
 */
export class RepeatGuard {
  private last: string | null = null;
  private streak = 0;

  constructor(private readonly limit: number = MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS) {}

  observe(signature: string): boolean {
    if (signature === this.last) {
      this.streak += 1;
    } else {
      this.last = signature;
      this.streak = 1;
    }
    return this.streak >= this.limit;
  }
}

/** Recursively re-key objects in sorted order so JSON.stringify is stable. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
