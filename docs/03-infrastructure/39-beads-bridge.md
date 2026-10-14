# Beads Bridge

> DEDUP-1 slice 1 (ADR-0016, non-destructive): expose the `bd` (beads)
> issue store to mergecrew as an ordinary package, with a read-first
> client, an issue↔bead mapping, and a dry-run reconciliation command.

## Package

`packages/beads-bridge` (`@mergecrew/beads-bridge`) — peer to
`packages/adapters-tracker`, which defines the mergecrew issue shape
(`Issue { id, title, body?, status?, url?, labels, createdAt }`).

## Components

### BeadsClient (src/beads-client.ts)

Thin wrapper over the `bd` CLI's JSON interface. Read-only plus minimal
writes:

| Method | bd command | Notes |
|---|---|---|
| `list(opts)` | `bd list --json [--status s] [--external-ref url] --limit N` | limit 0 = all |
| `show(id)` | `bd show id --json` | array → first row; null if absent |
| `create(input)` | `bd create title --json [-d d] [--labels a,b] [-p p] [--external-ref url]` | returns created bead |
| `update(id, input)` | `bd update id --json [--title t] [-d d] [--add-label l]… [-p p] [-s s]` | field-wise |
| `close(id, reason)` | `bd close id --reason r --json` | |

No `delete`, no dep mutation, no status surgery beyond close.

### Mapping (src/mapper.ts)

- `issueToBeadInput`: issue → `bd create` args. The issue's `url`
  becomes the bead's `external_ref` (identity key); the bead is tagged
  `tracker-import` plus the issue's own labels. Priority is not
  invented (beads keep bd's default P2); deps/metadata are bead-only
  concepts with no tracker-side counterpart in this shape.
- `beadToIssue`: bead → tracker `Issue` shape (for reading back).
- `beadMatchesIssue`: external_ref equality when both sides carry one,
  else exact-title fallback.

### Reconciliation (src/reconcile.ts, CLI: `beads-reconcile`)

Diff tracker issues against beads and print a report:

```
matched: 1
  = 1 <-> me-1 A
missing (orphaned beads count separately)
  + 2 B
orphaned beads (exported, issue gone): 0
```

- **Dry-run is the default** — nothing is written.
- `--write` creates beads for missing issues only (tagged
  `tracker-import`). Nothing is ever updated, closed, or deleted by
  the reconcile path.
- Only beads tagged `tracker-import` participate; everything else in
  the beads store is invisible to the diff.
- Orphans (beads whose tracker issue is gone) are reported, never
  touched.

```bash
pnpm --filter @mergecrew/beads-bridge build
node packages/beads-bridge/dist/bin.js \
  --tracker github-issues \
  --config '{"installationToken":"<token>","repoFullName":"owner/repo"}'
```

## Guarantees (slice 1)

- No existing table/schema changes; no dual writes.
- Write path is opt-in and create-only.
- Unit tests cover client argv shaping, mapping round-trips, and
  dry-run/write reconcile behavior (`pnpm --filter @mergecrew/beads-bridge test`).

## Not in scope (later slices)

Deleting the legacy issue storage, switching the live read/write path,
label/dep/priority sync back to the tracker.