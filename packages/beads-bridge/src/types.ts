/**
 * Shapes of `bd` CLI JSON output, as emitted by bd (beads) v0.x.
 *
 * Verified against the live CLI:
 * - `bd list/show/update/close --json` emit an ARRAY of Bead records.
 * - `bd create --json` emits a single Bead OBJECT.
 * - `bd list` rows carry `external_ref`/`metadata` only when hydrated
 *   (they appear on rows matched via `--external-ref`/`--external-contains`
 *   filters, and on `bd show`); treat them as optional everywhere.
 */

export interface Bead {
  id: string;
  title: string;
  description?: string;
  /** e.g. 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed' */
  status?: string;
  /** 0 (highest) .. 4 */
  priority?: number;
  issue_type?: string;
  /** Matching key set via `bd create/update --external-ref`. */
  external_ref?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
  notes?: string;
  /** RFC3339, e.g. "2026-10-05T12:43:54Z" */
  created_at?: string;
  updated_at?: string;
  dependency_count?: number;
  dependent_count?: number;
}

/** BeadsClient options. */
export interface BeadsClientOpts {
  /** Explicit `bd` binary path; defaults to PATH lookup. */
  bdPath?: string;
  /** Working directory the bd command runs in (defaults to process cwd). */
  cwd?: string;
  /** Extra env for the bd subprocess (merged over process env). */
  env?: Record<string, string>;
  /** Per-invocation timeout in ms (default 30_000). */
  timeoutMs?: number;
}
