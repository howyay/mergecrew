# API surface

The Mergecrew API is a NestJS HTTP service at `apps/api`, fronted by the Next.js BFF for browser traffic. The same API serves machine-to-machine calls (V2 public API) once we expose it.

## Conventions

- REST over HTTPS, JSON.
- Versioning: URL prefix `/v1`. Public V2 API will be `/v1` as well (we cut a `/v2` only on breaking changes).
- All resources scoped under `/orgs/:org_slug/...`.
- All requests require auth (session cookie or `Authorization: Bearer <token>`).
- Errors use a normalized shape:

```json
{
  "error": {
    "code": "GATE_REQUIRED",
    "message": "Production promotion requires approval.",
    "details": { "requiredRole": "operator" }
  }
}
```

## Auth

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/auth/session` | GET | Current session info (user, orgs, current org). |
| `/v1/auth/exchange` | POST | Exchange external auth (GitHub OAuth callback handled in BFF) for a Mergecrew session. |

GitHub *App* installation:

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/integrations/github/install` | GET | Redirects to GitHub App install. |

## Organizations

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs` | GET / POST | List user's orgs / create new org. |
| `/v1/orgs/:slug` | GET | Org detail. |
| `/v1/orgs/:slug/members` | GET | List members. |
| `/v1/orgs/:slug/audit-log` | GET | Paged audit entries. |

## Projects

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/projects` | GET / POST | List / create project. |
| `/v1/orgs/:slug/projects/:projectSlug` | GET / PATCH | Detail / update. |
| `/v1/orgs/:slug/projects/:projectSlug/connect-repo` | POST / DELETE | Connect / disconnect a GitHub repo. |
| `/v1/orgs/:slug/projects/:projectSlug/secrets` | GET / POST | List / create project secrets. |
| `/v1/orgs/:slug/projects/:projectSlug/secrets/:name` | DELETE | Delete a project secret. |
| `/v1/orgs/:slug/projects/:projectSlug/deploy-targets` | GET / POST | List / configure deploy targets. |
| `/v1/orgs/:slug/projects/:projectSlug/tracker` | GET / PATCH / DELETE | Get / set / clear the project's issue-tracker integration. |
| `/v1/orgs/:slug/projects/:projectSlug/tracker/test` | POST | Smoke-test a tracker config. |

## Lifecycle (per project)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/projects/:projectSlug/lifecycle` | GET / PUT | Get / replace the parsed lifecycle. |
| `/v1/orgs/:slug/projects/:projectSlug/lifecycle/versions` | GET | Versioned history. |
| `/v1/orgs/:slug/projects/:projectSlug/lifecycle/apply-template` | POST | Apply an org template to this project. |
| `/v1/orgs/:slug/projects/:projectSlug/lifecycle/agents/:ref` | PUT / DELETE | Upsert / remove a per-project agent override. |
| `/v1/orgs/:slug/projects/:projectSlug/lifecycle/workflows/:id` | PUT / DELETE | Upsert / remove a workflow node. |
| `/v1/orgs/:slug/projects/:projectSlug/lifecycle/custom-skills/:name` | PUT / DELETE | Upsert / remove a custom skill. |
| `/v1/orgs/:slug/projects/:projectSlug/lifecycle/human-gates` | PUT | Replace the gate policy. |

## Lifecycle templates (per org)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/lifecycle-templates` | GET | List org-level lifecycle templates. |
| `/v1/orgs/:slug/lifecycle-templates/:name` | GET / PUT / DELETE | Get / upsert / delete a template. |
| `/v1/orgs/:slug/lifecycle-templates/:name/agents/:ref` | PUT / DELETE | Upsert / remove a template agent. |
| `/v1/orgs/:slug/lifecycle-templates/:name/workflows/:id` | PUT / DELETE | Upsert / remove a template workflow. |
| `/v1/orgs/:slug/lifecycle-templates/:name/custom-skills/:skill` | PUT / DELETE | Upsert / remove a template custom skill. |
| `/v1/orgs/:slug/lifecycle-templates/:name/human-gates` | PUT | Replace the template's gate policy. |

## Stock lifecycle templates (global catalog)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/lifecycle-templates/stock` | GET | The stock templates a new project can start from, each with the Gas City formula it exports to. |
| `/v1/lifecycle-templates/stock/:id` | GET | One template with `sourceYaml`, `parsed`, `formula`, the `compiler` requirement, and the formula's step chain. |

## Skills and tools (global catalog)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/skills` | GET | Global stock-skill catalog (read-only). |
| `/v1/tools` | GET | Per-agent-kind tool surface: the skills an agent kind actually sees after read-only filtering and wire-name sanitization. |

## Gas City (admin reads)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/admin/city/status` | GET | City state; `?view=summary` keeps the fields the pages read. |
| `/v1/orgs/:slug/admin/city/agents` | GET | Agent list. |
| `/v1/orgs/:slug/admin/city/sessions` | GET | Session list. |
| `/v1/orgs/:slug/admin/city/tenant/:orgSlug` | GET | The rig an organization maps to. |
| `/v1/orgs/:slug/admin/city/projects` | GET | Every project bound to its rig, with a reason and a fix for the unmapped ones. |
| `/v1/orgs/:slug/admin/city/usage` | GET | Today's invocations, tokens and wall time with the city's own cost estimate, labelled as an estimate. |

## Runs

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/projects/:projectSlug/runs` | GET / POST | List runs / start "Run now". |
| `/v1/orgs/:slug/projects/:projectSlug/runs/:runId` | GET | Run detail. |
| `/v1/orgs/:slug/projects/:projectSlug/runs/:runId/full` | GET | Run detail with workflows + steps + cost expanded. |
| `/v1/orgs/:slug/projects/:projectSlug/runs/:runId/intent` | POST | Inject an ad-hoc intent into a running run. |
| `/v1/orgs/:slug/projects/:projectSlug/runs/:runId/cancel` | POST | Cancel. |
| `/v1/orgs/:slug/projects/:projectSlug/runs/:runId/timeline` | GET | Paged timeline (replay). |
| `/v1/orgs/:slug/projects/:projectSlug/runs/:runId/timeline/stream` | GET (SSE) | Live timeline stream. |

### SSE timeline stream

```
GET /v1/orgs/:slug/projects/:project_slug/runs/:run_id/timeline/stream
Accept: text/event-stream
```

Events:

```
event: timeline
data: {"id":"...","type":"AGENT_STEP_STARTED","payload":{...},"occurredAt":"..."}

event: timeline
data: {"type":"AGENT_TOOL_CALL", ... }

event: heartbeat
data: {"now":"..."}
```

Reconnect protocol: client sends `Last-Event-ID` (the largest event id received). The SSE controller backfills from that id via the durable timeline log, then subscribes to the live pubsub channel.

## Changesets

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/projects/:projectSlug/changesets` | GET | List. Filters: `status`, `daily_run_id`. |
| `/v1/orgs/:slug/projects/:projectSlug/changesets/:csId` | GET | Detail. |
| `/v1/orgs/:slug/projects/:projectSlug/changesets/:csId/decisions` | POST | Promote / rollback / defer. |
| `/v1/orgs/:slug/projects/:projectSlug/digest/:date` | GET | The digest payload for a date. |
| `/v1/orgs/:slug/projects/:projectSlug/digest/:date/group-promote` | POST | Atomic group promote. |

`POST /decisions` body:

```json
{ "kind": "promote", "comment": "looks good" }
```

## Approvals

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/inbox` | GET | Pending approvals + flagged changesets across all projects. |
| `/v1/orgs/:slug/projects/:projectSlug/approvals` | GET | Pending approvals for a project. |
| `/v1/orgs/:slug/projects/:projectSlug/approvals/:approvalId/resolve` | POST | Approve / reject / takeover. |
| `/v1/orgs/:slug/projects/:projectSlug/intent-inbox` | GET / POST | List / submit intents. Submitting with `decision: "approve"` records the operator's approval in the same action. |
| `/v1/orgs/:slug/ideas` | GET | Ideas waiting for a human decision, oldest first. |
| `/v1/orgs/:slug/ideas/:ideaId/decision` | POST | Approve / reject an idea. Only an approved idea can seed a run. |

### Ideas and the human gate

An idea (`intent_inbox_items`) is a proposal: a sentence someone typed, a Sentry
issue, a bug-triage finding. It carries one of four statuses.

| Status | Meaning |
|---|---|
| `queued` | Waiting for a person. Nothing runs from it. |
| `approved` | A person approved it; the next run may pick it up. |
| `rejected` | A person rejected it. It is never picked up. |
| `picked_up` | A run consumed it (`pickedUpRunId` points at the run). |

Only `approved` is visible to the pickup path in `apps/runner/src/step.ts`, and
only `queued` can be decided, so a decision cannot be applied twice. Machine
sources (the Sentry webhook, bug triage) always write `queued`; flows where the
person makes the choice themselves — the onboarding first task, the discovery
direction picker — submit `decision: "approve"` and land `approved` directly.
The rule lives in `packages/domain/src/ideas.ts`; every decision is recorded in
the org audit log as `idea.approved` / `idea.rejected`.

## LLM configuration

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/llm/providers` | GET / POST | List / register provider (incl. BYOK key upload). |
| `/v1/orgs/:slug/llm/profiles` | GET / POST | List / create profile. |

## Costs

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/orgs/:slug/costs` | GET | Org cost summary by day. |
| `/v1/orgs/:slug/projects/:projectSlug/costs` | GET | Per-project breakdown. |
| `/v1/orgs/:slug/projects/:projectSlug/runs/:runId/costs` | GET | Per-run breakdown. |

## Webhooks (inbound)

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/webhooks/github` | POST | GitHub webhook receiver. |
| `/v1/webhooks/sentry` | POST | Sentry alert receiver. |
| `/v1/webhooks/linear` | POST | Linear webhook receiver. |
| `/v1/webhooks/slack/interactivity` | POST | Slack action button responses. |

All inbound webhooks verify signatures and dispatch events into the orchestrator's inbox.

Outbound webhooks (user-supplied URLs receiving Mergecrew events) are Planned, not implemented.

## Pagination & filtering

- All list endpoints accept `limit` (default 50, max 200) and `cursor` (opaque).
- Cursors are stable across pages.
- All list endpoints support `?sort=` with allowlisted sort keys per resource.
- Filters use query params; complex filter combinations use `?filter=<base64-json>` (V2).

## Rate limiting

Per-session and per-BYOK-token rate limiting are Planned, not implemented.

## Idempotency

`Idempotency-Key` middleware is Planned, not implemented. Mutating endpoints today rely on adapter-level correlation ids (e.g., the deploy `correlationId`) for retry safety.

## Errors

Error codes (non-exhaustive):

- `UNAUTHORIZED`, `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_FAILED` (with `details.fields`)
- `GATE_REQUIRED` — action blocked by a gate.
- `BUDGET_EXHAUSTED`
- `RATE_LIMITED` — Mergecrew's own rate limit.
- `PROVIDER_UNAVAILABLE`
- `ADAPTER_AUTH_INVALID`

## SDKs

A first-party TypeScript SDK and an OpenAPI document published at `/v1/openapi.json` are Planned, not yet exposed. The Next.js BFF currently calls the API with hand-written fetch wrappers.
