# ADR-0016 status

Date: 2026-10-05. This page records the state of the migration. The pull request list is the source
of truth: every number below was read from the repository, not from memory.

## Acceptance criteria

| Criterion | State | Evidence |
| - | - | - |
| 1. Every work item lands as a pull request with visible checks and a review conclusion | Met | 21 pull requests. `#2` to `#21` each carry a passing `build` check. Each body is a packet with the scope, the check evidence, and a review conclusion. |
| 2. DEDUP-1 to DEDUP-6 each land as a reviewed pull request | Open | All six have open pull requests with green checks. The merge is the reviewer's decision. |
| 3. The frontend drives Gas City with an organization to rig map | Met | `#6` (client), `#8` (contract), `#13` (tenant map), `#14` (web page), `#20` (boundary enforcement). |
| 4. The Dolt error rate stays zero | Met | The health gate (`#16`) reports the error window and the count. Since the fix: 0. |

## DEDUP-1 to DEDUP-6, two slices each

| Item | Slice | Pull request | Tests | Live evidence |
| - | - | - | - | - |
| DEDUP-1, beads | Bridge: report the difference | #5 | 9 | Read 19 beads from the rig store |
| | Migration: plan and apply | #15 | 8 | Dry run planned 2 creates, 0 updates |
| DEDUP-2, formulas | Export the lifecycle templates | #7 | 10 | 5 formulas reach the city |
| | Formula gate | #17 | 14 | 5 of 5 compile, 0 problems |
| DEDUP-3, orders | Export the schedules | #10 | 8 | 1 order read by `gc order show` |
| | Order gate | #21 | 10 | 10 orders, 0 problems |
| DEDUP-4, sessions | Export the runner profiles | #3 | 11 | `gc agent list` shows the exported agent |
| | Session contract gate | #19 | 11 | Found 2 stuck items, then 0 |
| DEDUP-5, engine retirement | Inventory | #12 | 8 | 5 modules, 47 KB of source measured |
| | Batch executor | #18 | 8 | 2 modules, 31 files selectable |
| DEDUP-6, tenant map | The map | #13 | 8 | Rendered against the real rigs |
| | The client | #6 | 12 | HTTP read plus a live bead creation |
| | Boundary enforcement | #20 | typecheck | An unknown rig is a 404 |

## The gates

Each gate catches a failure that looks like success.

| Gate | Pull request | What it proves | Live result |
| - | - | - | - |
| Health | #16 | No store-write error, no too-fast order, no stuck session start | 0 errors in the window, 0 order problems |
| Formula | #17 | Every exported formula compiles into a sound graph | 5 of 5, 0 problems |
| Session contract | #19 | Every routed work item has a live session that can claim it | 0 routed, 0 stuck |
| Order | #21 | Every declared order reached the city and can fire | 10 orders, 0 problems |
| Live contract | #9 | The supervisor payload shapes match the contract page | 4 of 4 resources, "contract holds" |

## Supporting work

| Pull request | What it adds |
| - | - |
| #2 | ADR-0016: the decision, the dedup map, the Dolt root cause |
| #8 | The integration contract page |
| #9 | The live check that makes the contract executable |
| #11 | The packet generator, and a packet per branch |
| #14 | The organization page that reads the city |
| #1 | The first end-to-end run (the polecat branch) |

## Findings

| Bead | Finding | State |
| - | - | - |
| `me-kgy` | `pnpm --filter @mergecrew/api typecheck` is red for pre-existing reasons | Open. The errors are in uncommitted work. The new module adds none. |
| `me-3f0` | `apps/api` has jest but no TypeScript transform, so an API spec cannot run | Open |
| `me-ssq` | PR #4 needed a regenerated OpenAPI spec and SDK types | Closed. Regenerated on a Linux runner, because this workstation has no Prisma engine. |

## How to reproduce

```bash
# The city doors, from any directory
node ops/gc/city-client.mjs --city=gascity
node ops/gc/live-city-check.mjs

# The gates
node ops/gc/city-health.mjs  --city-dir=/home/haoye/gascity
node ops/gc/formula-gate.mjs --city-dir=/home/haoye/gascity
node ops/gc/session-gate.mjs --city-dir=/home/haoye/gascity
node ops/gc/order-gate.mjs   --city-dir=/home/haoye/gascity

# The migration tools (dry run unless --apply)
node ops/gc/beads-migration.mjs --from-json=issues.json
node ops/gc/retire-execute.mjs  --root=. --targets=apps/runner
```

## What remains

1. The merge. Every pull request is green and mergeable. The order is the reviewer's call.
2. The web app reads the city status only. The agent and session views are not built.
3. Two findings above are open, and both are pre-existing.
