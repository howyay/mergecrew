# ADR-0016 series integration

Date: 2026-10-05. Branch: `gc/integration`, built from `origin/main` in a separate worktree.

## Purpose

The migration is one branch per work item, which is right for review and awkward for landing. This
branch merges the whole series, so the reviewer can land it in one action and still read the
individual pull requests.

## What is merged

Twenty-one branches: `gc/adr-0016` and every slice and gate that follows it. Every merge was clean.
No conflict occurred.

## Result

```text
$ node --test "ops/gc/test/*.test.mjs"
ℹ tests 147
ℹ pass 147
ℹ fail 0
ℹ duration_ms 1524.450236
```

Fifteen tools and fifteen test files.

## What this proves

1. The branches are independent. Each one adds files and does not fight another.
2. The tools need no install step. The whole suite runs in about a second and a half.
3. The series can land in one commit range, or pull request by pull request.

## What this does not prove

1. No merge has happened yet. Landing is the reviewer's decision.
2. The heavy repository checks (`pnpm lint:no-raw-sql`, the web typecheck, the API typecheck) run in
   the repository CI on the individual pull requests, not here.
3. `docs/adrs/0016-status.md` maps each item to its pull request. Read it with this branch.
