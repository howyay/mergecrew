# Gas City integration contract

Status: active. Date: 2026-10-05. Related: ADR-0016, `ops/gc/*`.

## 1. Purpose

This page is the contract between MergeCrew and Gas City. It states the read calls, the action
calls, the tenant rule, and the failure behaviour. Every payload shape below comes from a live run,
not from a guess.

## 2. Topology

| Item | Value |
| - | - |
| City directory | `/home/haoye/gascity` |
| City name | `gascity` |
| Rig | `mergecrew`, from `/home/haoye/projects/mergecrew` |
| Supervisor API | `http://127.0.0.1:8372` |
| Dashboard | the same supervisor, path `/` |
| Store | beads on Dolt, prefix `me` for the rig, `ga` for the city |

## 3. Read calls (HTTP)

The supervisor serves a read-only JSON API. Use it for reads. Do not shell out for a read.

| Call | Meaning | Verified shape |
| - | - | - |
| `GET /v0/city/<city>/status` | city state | `{name, path, version, uptime_sec, suspended, agent_count, rig_count, running, agents, rigs, work, mail}` |
| `GET /v0/city/<city>/agents` | agent list | `{items, total}` |
| `GET /v0/city/<city>/sessions` | session list | `{items, total}` |
| `GET /v0/city/<city>/usage` | token and cost record | `{available, recording, source, today, recent, recent_window_secs, observed_from, updated_at}` |

`today` holds `invocations`, `compute_facts`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_creation_tokens`, `wall_seconds`, `cost_usd_estimate`, and `unpriced` — the number of
invocations with no price on file.

A list call returns an envelope. Always read `items`. Some CLI calls return a bare array, so the
shared helper `items()` in `ops/gc/city-client.mjs` accepts both.

## 4. Action calls (CLI)

Use the CLI for a change. Add `--json` to every call and parse the result.

| Call | Meaning |
| - | - |
| `gc bd create --title <t> --type <k> --priority <n> --json` | create a work item in the rig |
| `gc bd show <id> --json` | read one work item |
| `gc sling <rig>/gastown.polecat <bead>` | route a work item to an agent |
| `gc order list --json` | list the scheduled orders |
| `gc formula list --json` | list the available formulas |
| `gc formula cook <name>` | instantiate a formula as real beads |
| `gc rig list --json` | list the rigs |
| `gc beads city use-managed` | repair a rig endpoint mirror after a move |
| `gc agent list --json` | agent config as gc reads it |

Verified agent keys: `name`, `qualified_name`, `scope`, `work_dir`, `suspended`, `pool`,
`work_query`, `sling_query`. Verified session keys: `id`, `name`, `template`, `provider`, `state`,
`title`, `rig`, `alias`, `agent_name`, `command`, `work_dir`, `session_name`.

## 5. Tenant rule

Gas City is single-operator. MergeCrew is multi-tenant. The map is the missing layer.

| Rule | Value |
| - | - |
| One organization | one rig |
| Reference organization | `mergecrew` keeps the rig `mergecrew` |
| Any other organization | rig `mc-<org-slug>` |
| One project | one work prefix inside the rig |
| Remote write | a signed grant that names the city. One grant per organization. Never reuse a grant |

`ops/gc/tenant-map.mjs` renders the map and reports a missing rig, a shared rig, and an unknown
organization. `CityService.tenant()` in the product exposes the same rule.

## 6. Product surface

The API module `apps/api/src/modules/city` exposes the reads. It reuses `RoleGuard` and
`RequireRole('admin')`, in the same way as the admin health endpoint.

| Route | Result |
| - | - |
| `GET /v1/orgs/:slug/admin/city/status` | city state; `?view=summary` keeps the nine fields the pages read and drops `agent_details` |
| `GET /v1/orgs/:slug/admin/city/agents` | agent list |
| `GET /v1/orgs/:slug/admin/city/sessions` | session list |
| `GET /v1/orgs/:slug/admin/city/tenant/:orgSlug` | the rig for an organization |
| `GET /v1/orgs/:slug/admin/city/projects` | every project of the organization bound to a rig, with a reason and a fix for the unmapped ones |
| `GET /v1/orgs/:slug/admin/city/usage` | today's invocations, tokens and wall time, with the city's own cost estimate |

### Cost and usage

The city counts tokens, wall time and invocations on the host it runs on. That makes its numbers a
**local estimate, not a provider bill**, and the product says so instead of presenting them as spend.
`CityService.usage()` reads `GET /v0/city/<city>/usage` and normalizes it through `projectUsage()`:

| Field | Rule |
| - | - |
| `source` | the city's own label, `local_estimate` on the reference city; anything non-string becomes `unknown` |
| `unpriced` | invocations the city could not price |
| `partial` | derived here as `unpriced > 0`: the estimate is a floor, not a total |
| counters | coerced through a finite-number guard, so a missing or malformed counter reads as `0` rather than `NaN` |
| `available` / `recording` | strict `=== true`, so an absent flag is never read as healthy |
| missing payload | `EMPTY_CITY_USAGE` — zeros, `source: unknown`, no timestamp |

The costs page shows two sources side by side and keeps them apart: the per-day ledger from the
application database (`/v1/orgs/:slug/costs`, written by the runner) and the city panel. A failed city
read never blanks the ledger: `403` reads as "needs the admin role", any other failure renders a note
and leaves the ledger rows in place. A zero estimate with `partial` set is reported as "none of the N
invocations has a price on file, not because nothing was spent".

### Project to rig binding

A project reaches the city through a rig, so the product has to answer which rig carries which
project. The rule lives in one place — `packages/domain/src/rigs.ts` — so the API, the pages, and the
`ops/gc` tools cannot drift apart. `CityService.projectRigs()` reads `GET /v0/city/<city>/rigs` once
and binds each project (organization-scoped, `deletedAt: null`, ordered by slug) in this order:

1. `CITY_PROJECT_RIGS`, an explicit override. JSON (`{"mergecrew":"mc-mergecrew"}`) or a
   `slug=rig,slug2=rig2` list. A key may be the project slug, the full repository name, or the bare
   repository name, all lowercased.
2. The rig `name` equal to the repository name (`howyay/mergecrew` → `mergecrew`).
3. The rig directory basename equal to the repository name.

A project with no match is reported, never dropped: `reason` says what was tried, and `fix` names the
action (`gc rig add <path>`) so the page can show it. An override that names a rig the city does not
hold is reported the same way instead of silently falling back to a weaker match.

The override is read from the environment, so it needs no migration. Persisting it per project is the
next cut, and it is recorded as a finding before this landed.

| Environment variable | Default | Meaning |
| - | - | - |
| `CITY_API_URL` | `http://127.0.0.1:8372` | supervisor address |
| `GC_CITY` | `gascity` | city name in the path |
| `CITY_API_TIMEOUT_MS` | `1500` | read timeout |
| `CITY_PROJECT_RIGS` | unset | explicit project → rig overrides, when the naming rule cannot find the rig |

The supervisor always answers with the whole status, `agent_details` included, and ignores query
parameters, so the `view=summary` projection happens in `CityService`: a keep-list of the nine fields
the pages read, which took the payload from 5,234 to 220 bytes on the reference city. The dropped block
is the agent list, so the saving grows with the agent count. A caller that omits `view` still gets the
full status.

| Environment variable | Default | Meaning |
| - | - | - |
| `CITY_API_URL` | `http://127.0.0.1:8372` | supervisor address |
| `GC_CITY` | `gascity` | city name in the path |
| `CITY_API_TIMEOUT_MS` | `1500` | read timeout |

## 7. Failure behaviour

A read fails with one message that names the address and the fix: "Gas City is not reachable at
`<url>`. Start the supervisor, or set CITY_API_URL." The failure is logged at warn level. A read
never blocks the product request path for more than `CITY_API_TIMEOUT_MS`.

## 7a. The rig endpoint mirror

A rig reads and writes through the city's store, which it finds in `<rig>/.beads/dolt-server.port`.
With `dolt.auto-start: false` that file is the only thing that names the endpoint, so when it goes
missing the rig resolves port 0 and every command in the rig directory fails:

```
$ cd ~/projects/mergecrew && bd list
Error: failed to open database: Dolt server unreachable at 127.0.0.1:0
```

The file went missing twice on 2026-10-05 (once before the write-failure incident, once after the
file-backed migration). The fix is one line, and it is the same line both times:

```bash
printf '%s\n' "$(cat ~/gascity/.beads/dolt-server.port)" > ~/projects/mergecrew/.beads/dolt-server.port
```

`ops/gc/city-health.mjs` checks the mirror for every rig and prints that fix with the file path, so a
missing or mismatched port file is caught by a gate instead of by a failed write:

```bash
node ops/gc/city-health.mjs --city-dir="$HOME/gascity"
# Endpoint mirror problems: 0
```

Do not answer this with `bd dolt start`: it starts a second server and points the rig at it, which is
the state the mirror rule exists to prevent.

## 7b. How the contract is enforced

`ops/gc/live-city-check.mjs` reads `status`, `agents`, `sessions`, and `usage`, then reports a
missing key, a bad list envelope, or an unreachable supervisor. `ops/gc/test/live-city.test.mjs`
runs it. The live test skips when the supervisor is down, so the suite still runs on a machine
without Gas City.

Run it before a release, and after a Gas City upgrade:

```bash
node ops/gc/live-city-check.mjs
# status: HTTP 200 · ok
# agents: HTTP 200 · ok
# sessions: HTTP 200 · ok
# usage: HTTP 200 · ok
# contract holds
```

## 8. Operating rules (learned on 2026-10-05)

1. An order that writes once per minute destroys the store. Fourteen such orders dropped the Dolt
   connection, and session metadata writes failed with them. Keep event-driven orders on. Keep
   timer orders off, or slow.
2. `min_active_sessions = 0` sends a pool worker to sleep. Set `1` for a worker that must stay warm.
3. Never run two Dolt servers on one data directory. Never `SIGKILL` the server.
4. `skills` in an agent config is deprecated. Record the skill intent as a comment.

## 9. What this page does not cover

1. No pull request exists yet for the ADR-0016 work. The keyring token is unreadable in a
   non-interactive shell.
2. The web app does not call the new endpoints yet. The API module is ready for it.
3. `pnpm --filter @mergecrew/api typecheck` is red for pre-existing reasons. See `me-kgy`.
