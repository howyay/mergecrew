# ADR-0016: Gas City is the orchestration substrate; MergeCrew is the product frontend

Status: Proposed. Date: 2026-10-05.
Supersedes parts of ADR-0010 and ADR-0013 (engine choice). Refines ADR-0014 (portable definition).

## Context

MergeCrew owns an orchestration stack: a durable workflow engine on Postgres + BullMQ, an agent
runtime, a runner agent, a scheduler, and its own issue store. Gas City provides the same class of
primitives as a platform: beads (work items), formulas (workflow definitions), orders (triggers),
agents and sessions (harness, model, transport, runtime), convoys, mail, hooks, a controller, and a
supervisor. This ADR removes the duplication and fixes the direction of the dependency.

The owner's framing is adopted: **MergeCrew is the more user-friendly frontend to Gas City.**

## Decision

1. Gas City is the **orchestration substrate**. Beads and formulas are the canonical work-item and
   workflow representations.
2. MergeCrew is the **product frontend**: tenancy, UX, tracker integration, deploy, and reporting.
   It drives Gas City through its CLI and its Service Protocol. It does not re-implement
   orchestration.
3. Duplicated orchestration in MergeCrew is retired, module by module, with evidence. The old
   engine keeps serving existing runs until the migration of a module is accepted.

## Deduplication map

| MergeCrew surface | Gas City primitive | Action | Notes |
| - | - | - | - |
| Own issue store (`issues`, dependencies) | **beads** (`bd`) | **replace** | One work-item model. Keep a read-through adapter for existing rows. |
| `LifecycleTemplate` / `WorkflowTemplate` v1 | **formulas** (v1 wisp, v2 graph) | **replace** | A formula is the portable definition. A city-local pack holds MergeCrew's workflows. |
| `Schedule` + BullMQ queue timers | **orders** | **replace** | `[orders]` and `[orders.overrides]` control cadence. |
| `apps/orchestrator` run engine | Gas City controller + sessions | **retire** | Keep a thin facade for the API contract. |
| `packages/agent-runtime` step loop | Gas City agent runtime + sessions | **retire** | Harness, model, transport, runtime become agent config. |
| `runner-agent` enrollment + long poll | Gas City remote city + Service Protocol | **replace** | Keep BYO-credential UX in the frontend. |
| `ApprovalRequest` human gate | formula gate / session interrupt | **map** | Keep the product approval record. The gate executes in Gas City. |
| `Changeset` + PR lifecycle | `gc github` + refinery merge queue | **map** | Merge mechanics move to Gas City. The review UX stays. |
| `RunPause` (`wakeAt`), rate-limit resume | orders + gate resume | **replace** | Runtime facts belong to the substrate. |
| Deploy adapters (Fly, GitHub Actions, docker) | (none) | **keep** | Gas City does not deploy. |
| Organizations, auth, MFA, API keys, secrets | (none) | **keep** | Gas City is single-operator. The frontend adds the tenant map. |
| SLO, eval, A/B eval, reporting | `gc costs`, `gc metrics`, `gc analyze` (partial) | **keep + ingest** | Reporting stays product-side; ingest substrate metrics. |
| Web app, swipe UI, PRD and approval views | Gas City dashboard (operator view) | **keep + link** | The product UI is the reason MergeCrew exists. Link to Gas City runs. |

## Consequences

- One workflow vocabulary (formula) and one work-item vocabulary (bead) across the product and the
  harnesses. This satisfies ADR-0014 with fewer adapters.
- The frontend must implement a **tenant map**: organization and project to city and rig, with a
  signed grant for remote writes (see the Gas City self-hosted-city runbook).
- MergeCrew loses control of run scheduling. The product API must read run state from Gas City.
- Dolt is load-sensitive on a shared host. Keep the write churn low: no per-minute order writers,
  and keep the beads backend off the Dolt path where the substrate allows it. See the operations
  note below.

## Operations note: Dolt stability (measured 2026-10-05)

Root cause of the write failures (`invalid connection`, `write commit result indeterminate`): the
order scheduler fired 14 orders per minute. Each one wrote a tracking bead and opened a short-lived
connection. Under host load the connection dropped, and the substrate correctly refused to retry an
indeterminate commit. Session metadata writes failed with it, so sessions could not start.

Applied fixes, all reversible:

1. `[orders.overrides]` in `city.toml` disables the 14 chatty orders. Measured error rate: 27 per
   hour at 23:00, 2 per hour at 02:00, **0 in the 5 minutes after the change**.
2. `GC_BEADS=file` and `GC_BEADS_BACKEND=file` keep the beads path off Dolt for the managed city.
3. `[dolt] auto-start = true`. Never start a second server by hand, and never `SIGKILL` it.
4. Ongoing: one order that writes per minute is one too many. Add an order only with a reason.

## PR endpoint (state 2026-10-05)

The rule is: one branch per work item, pushed, with visible checks and a review conclusion.

| Endpoint | State | Note |
| - | - | - |
| GitHub `howyay/mergecrew` | **blocked** | The keyring token is unreadable in non-interactive shells. `gh api` and `git push` fail. `gh auth login` or an exported `GH_TOKEN` fixes it. |
| Local Forgejo (127.0.0.1:3000, v15.0.6) | **found, not ready** | A system service with a `forgejo-runner`. No `mergecrew` repository exists. The process owner is not the current user, so no config file and no admin CLI are available. |
| Local branches | **ready** | `gc/beads-bridge` and `gc/formula-export` carry the first two migration slices. |

Decision: the local Forgejo is the preferred endpoint for the pull-request and check loop, because it
gives visible checks without a third-party token. It needs one setup action: create the `mergecrew`
repository and issue an access token. The GitHub path stays as the upstream mirror.

## Migration order

1. Beads as the work-item store (adapter in, writes out).
2. Formulas as the workflow definition (port the lifecycle templates).
3. Orders replace the scheduler.
4. Sessions replace the runner and the agent runtime.
5. Retire the old engine and its queues.
6. Retire `RunPause` and the duplicate approval plumbing.

Each step lands as a pull request with checks and a review conclusion.
