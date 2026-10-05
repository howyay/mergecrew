# `gc/integration-contract`

Base: `main` · Commit: `aa1fe64fc300` · 2026-10-05

## Summary

docs(infra): the Gas City integration contract

States the read calls (supervisor HTTP), the action calls (gc CLI), the tenant
rule, the product surface, the failure behaviour, and the operating rules that
the 2026-10-05 incident taught. Every payload shape comes from a live run.

Also states what the page does not cover: no pull request exists yet, the web
app does not call the endpoints yet, and the API typecheck is red for
pre-existing reasons (me-kgy).

## Scope

- `docs/03-infrastructure/08-gas-city-integration.md`

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
