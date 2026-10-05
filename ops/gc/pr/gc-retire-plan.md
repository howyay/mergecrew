# `gc/retire-plan`

Base: `main` · Commit: `0eec156b4c5a` · 2026-10-05

## Summary

feat(gc): add the engine retirement inventory (ADR-0016 step 5)

First slice of DEDUP-5, plus the CI wiring for the ADR-0016 tools.

- ops/gc/retire-plan.mjs: measures each duplicated orchestration module
  (size, inbound imports, internal edges) and gives a consumer-first
  retirement order with the blockers named.
- ops/gc/test/retire-plan.test.mjs: 8 tests, node --test.
- ops/gc/retire-plan.md: the plan for the current tree.
- ops/ci/checks.conf: runs ops/gc/test in the repository check loop.

Verified on this branch: node --test ops/gc/test/retire-plan.test.mjs
-> 8 passed / 0 failed. The other ops/gc suites (beads bridge, lifecycle
exporter, orders exporter, agents exporter, tenant map, packet) live on
their own branches and join this line when they land.

## Scope

- `ops/ci/checks.conf`
- `ops/gc/retire-plan.md`
- `ops/gc/retire-plan.mjs`
- `ops/gc/test/retire-plan.test.mjs`

## Evidence

- **FAIL** `ops/gc/test/retire-plan.test.mjs` — 0 passed, 1 failed

## Review checklist

- [ ] One branch for one work item. No other work item is mixed in.
- [ ] No push to the default branch and no force push.
- [ ] Every check in the Evidence section passed.
- [ ] No order or schedule fires more often than every five minutes (the Dolt churn rule).
- [ ] The work item in the tracker matches this branch.

## Review conclusion

**Needs revision.** A test failed. Do not land this change.
