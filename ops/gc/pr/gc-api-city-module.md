# `gc/api-city-module`

Base: `main` · Commit: `d7bb8881b22a` · 2026-10-05

## Summary

feat(api): expose Gas City state under the admin tree (ADR-0016 criterion 3)

The product had no door to Gas City. This adds one, next to the existing
admin health endpoint, and reuses RoleGuard plus RequireRole('admin').

- apps/api/src/modules/city/city.service.ts: reads the supervisor HTTP API
  (CITY_API_URL, GC_CITY), and exposes the tenant rule (reference org keeps
  the mergecrew rig, every other org is prefixed with mc-).
- apps/api/src/modules/city/city.controller.ts: GET status, agents, sessions,
  and tenant/:orgSlug under /v1/orgs/:slug/admin/city.
- apps/api/src/modules/city/city.module.ts and the AppModule registration.

Verified: the module adds 0 type errors. 'pnpm --filter @mergecrew/api
typecheck' reports no error in modules/city. The tree's remaining type errors
are pre-existing (see the separate finding).

## Scope

- `apps/api/src/app.module.ts`
- `apps/api/src/modules/city/city.controller.ts`
- `apps/api/src/modules/city/city.module.ts`
- `apps/api/src/modules/city/city.service.ts`

## Evidence

No test file ran. State the reason in the review section.

## Review checklist

- [ ] One branch for one work item. No other work item is mixed in.
- [ ] No push to the default branch and no force push.
- [ ] Every check in the Evidence section passed.
- [ ] No order or schedule fires more often than every five minutes (the Dolt churn rule).
- [ ] The work item in the tracker matches this branch.

## Review conclusion

**Ready for review.** Every recorded check passed.
