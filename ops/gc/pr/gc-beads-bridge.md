# `gc/beads-bridge`

Base: `main` · Commit: `a534e77ef6a8` · 2026-10-05

## Summary

feat(gc): read-only MergeCrew <-> beads bridge (ADR-0016 step 1)

First slice of DEDUP-1. Zero dependencies.

- ops/gc/beads-bridge.mjs: mapping (issue -> bead fields), reconciliation report,
  CLI dry-run against the rig store through 'gc bd list --json'.
- ops/gc/test/beads-bridge.test.mjs: 9 tests, node --test, no new dependencies.

Verified: node --test -> 9 passed / 0 failed; reconcile dry-run read 19 beads
from the rig store and reported 2 sample issues without a bead.

## Scope

- `ops/gc/beads-bridge.mjs`
- `ops/gc/test/beads-bridge.test.mjs`

## Evidence

- **FAIL** `ops/gc/test/beads-bridge.test.mjs` — 0 passed, 1 failed

## Review checklist

- [ ] One branch for one work item. No other work item is mixed in.
- [ ] No push to the default branch and no force push.
- [ ] Every check in the Evidence section passed.
- [ ] No order or schedule fires more often than every five minutes (the Dolt churn rule).
- [ ] The work item in the tracker matches this branch.

## Review conclusion

**Needs revision.** A test failed. Do not land this change.
