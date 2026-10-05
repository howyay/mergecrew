# ADR-0016 status

Date: 2026-10-05. This page records the state of the migration and of the product surface that
reads it. The series landed in `main` through #23 (merge commit `27f128b`); the surface slice
landed through #33 (merge commit `d7a94c1`). The pull request list is the source of truth:
every number below was read from the repository, not from memory.

## Acceptance criteria

| Criterion | State | Evidence |
| - | - | - |
| 1. Every work item lands as a pull request with visible checks and a review conclusion | Met | 33 pull requests. `#2` to `#33` each carry a passing `build` check, whose job runs the tooling suite (168 tests) and the API suite (19 tests); `#1`, the first end-to-end run, predates the wiring and is kept as history. Each body is a packet with the scope, the check evidence, and a review conclusion. |
| 2. DEDUP-1 to DEDUP-6 each land as a reviewed pull request | Met | Landed in `main` through #23 (merge commit `27f128b`). CI on `main`: success, with the tooling suite (166 tests) and the API suite (10 tests). |
| 3. The frontend drives Gas City with an organization to rig map | Met | `#6` (client), `#8` (contract), `#13` (tenant map), `#14` (web page), `#20` (boundary enforcement), and the surface slice `#29` to `#33`: the navigation entry, the city view, the landing summary, the status projection, and the gate that repairs a drifted mirror. |
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

## The product surface

The migration is only visible if the product shows it. This slice makes the city legible in the
interface and pays for the reads it makes, and the last row is the gate that caught a real
breakage while the slice was being written.

| Pull request | What it changes | Tests | Live evidence |
| - | - | - | - |
| #29 | The city service caches the rig list, so a page load does not re-read every agent per tenant check | 14 API | Three tenant reads cause one agent read |
| #30 | The city view: status, the organization to rig map, the agent list, the session list, each with its own empty state and its own error state, so one failing read does not blank the page. The sidebar gains the entry under Operations. | web typecheck | Route `ƒ /orgs/[slug]/city` in the build output |
| #31 | The organization page gains a one-line city summary inside the read it already makes | web typecheck | The summary joins the existing `Promise.all`, so it costs no extra round trip |
| #32 | `?view=summary` projects the status payload down to the fields the page reads. The supervisor ignores query parameters, so the projection lives in our service. | 19 API | 5,234 bytes to 220, a 95.8% cut, measured against the live city |
| #33 | The health gate names the file and the value that repairs a drifted rig mirror | 168 tooling | Repaired a real breakage: the rig directory could not reach Dolt at all |

The pages read from one place: `apps/web/src/lib/api.ts` for the session-bound request,
`Card`/`CardHead`/`CardBody`, `StatusDot` and `StatBadge` for the shapes, `relativeTime` for
every timestamp. The city view holds no formatting of its own.

## The gates

Each gate catches a failure that looks like success.

| Gate | Pull request | What it proves | Live result (2026-10-05) |
| - | - | - | - |
| Health | #16, #33 | No store-write error, no too-fast order, no stuck session start, and no drifted rig mirror. A drifted mirror now reports the file to write and the value to write into it. | 0 errors, 0 order problems, 0 session problems, 0 mirror problems |
| Formula | #17 | Every exported formula compiles into a sound graph | 5 of 5, 0 problems |
| Session contract | #19 | Every routed work item has a live session that can claim it | 0 routed, 0 stuck |
| Order | #21 | Every declared order reached the city and can fire | 10 orders in the city, 0 problems |
| Live contract | #9 | The supervisor payload shapes match the contract page | 4 of 4 resources, "contract holds" |

## The check that runs the checks

The suite grows with the work: 147 tests when the step was added, 166 after the migration slice,
168 after the mirror message. The step was verified in a real run, most recently on #33:

```text
# tests 168
# pass 167
# fail 0
# skipped 1
# duration_ms 552.374452
```

The one skip is the live supervisor check, which skips when no supervisor is reachable. The run:
<https://github.com/howyay/mergecrew/actions/runs/37380575361>.

The step is also in `#23`, so landing the series brings both the tools and the check that runs them.

## Supporting work

| Pull request | What it adds |
| - | - |
| #2 | ADR-0016: the decision, the dedup map, the Dolt root cause |
| #8 | The integration contract page |
| #9 | The live check that makes the contract executable |
| #11 | The packet generator, and a packet per branch |
| #14 | The organization page that reads the city |
| #22 | This status page |
| #23 | The series integration: 21 branches, 0 conflicts, 147 tests |
| #24 | The CI step that runs the tool suite |
| #25 | The agent and session lists on the organization page |
| #26 | The jest configuration, and the first API spec (10 tests) |
| #27 | The readiness check that names the blockers on this workstation in one command |
| #28 | This page, recording the landing |
| #1 | The first end-to-end run (the polecat branch) |

## Findings

| Bead | Finding | State |
| - | - | - |
| `me-kgy` | `pnpm --filter @mergecrew/api typecheck` is red for pre-existing reasons | Open. The errors are in uncommitted work. The new module adds none. |
| `me-3f0` | `apps/api` has jest but no TypeScript transform, so an API spec cannot run | Closed in #26. jest is configured, and the city spec runs in CI. |
| `me-pwi` | Store writes fail intermittently | Closed in #15. The writer retries a retryable failure once and prints it. A probe measured 5 of 5 writes succeeding. |
| `me-qep` | A rig mirror can drift, and writes fail while reads pass | Closed in #16, hardened in #33. The gate reads the city port and every rig port file, and now prints the repair. It caught the drift again on 2026-10-05, when the rig lost its port file and every command in it failed at `127.0.0.1:0`. |
| `me-ssq` | PR #4 needed a regenerated OpenAPI spec and SDK types | Closed. Regenerated on a Linux runner, because this workstation has no Prisma engine. |
| `me-glf` | `?view=summary` is absent from the generated OpenAPI spec | Open. The controller reads the query with a bare `@Query('view')`, so `docs/openapi.json` lists no parameters for the city routes and the SDK cannot express the projection. The fix is an `@ApiQuery` plus a regeneration on a Linux runner. |

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

## After the landing

The series merged into `main` as commit `27f128b`, and the surface slice followed through `d7a94c1`.

| Check on `main` | Result |
| - | - |
| Tooling suite | 168 tests, 167 passed, 1 skipped (the live check skips without a supervisor) |
| API suite | 19 passed |

## What remains

1. `me-kgy` is open and is a provisioning gap, not a code defect: the workstation has no generated Prisma client and fifteen packages have no `dist`. `ops/gc/local-readiness.mjs` names the blockers in one command.
2. `me-glf` is open: the status projection works and is documented, but the generated contract does not know about it yet.
3. The migration tools are the foundation. The product still reads and writes its own stores; moving a live path onto beads, formulas, or orders is the next slice, and it is now a change against `main`.
