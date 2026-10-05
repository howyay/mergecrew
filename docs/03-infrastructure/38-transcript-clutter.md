# Transcript clutter control

A transcript is the record of what an agent actually did: the messages it sent, the
tool calls it made, the results it got back. Clutter is anything in that record that
does not move the run forward — a repeated call, a re-explained plan, a refiled issue.
It matters for two reasons. First, legibility: design principles [#2 (make the agent
legible)](../01-design/01-principles.md) and [#6 (show _what_, hide _how_)](../01-design/01-principles.md)
only hold if the transcript is worth opening. Second, budget: every redundant turn is
tokens, and tokens are the run's cost ([#9](../01-design/01-principles.md)).

This guide names the three forms of clutter, shows a good and a bad example of each,
and documents the one form the runtime catches on its own.

## The three forms

1. **Repeated tool calls** — the same skill, same arguments, issued again without the
   result of the previous call changing anything. The agent is looping, not working.
2. **Redundant narration** — the model restating a plan, a diff, or a prior result it
   already stated. Reads as activity; is not progress.
3. **Duplicate work items** — refiling a tracker issue, re-requesting an approval, or
   re-emitting a changeset that already exists.

## Good and bad examples

### 1. Repeated tool calls

**Bad** — the model re-issues the identical read instead of acting on it:

```text
step 1  repo.read_file   { path: "src/billing/invoice.dto.ts" }
        → { contents: "...taxId missing on InvoiceDto..." }
step 2  repo.read_file   { path: "src/billing/invoice.dto.ts" }   ← same call
        → { contents: "...taxId missing on InvoiceDto..." }
step 3  repo.read_file   { path: "src/billing/invoice.dto.ts" }   ← same call, again
        → { contents: "...taxId missing on InvoiceDto..." }
```

Three identical consecutive calls. The model has the answer and is not using it. The
loop fails here with `tool_call_repeat_detected` (see below).

**Good** — read once, then change state:

```text
step 1  repo.read_file   { path: "src/billing/invoice.dto.ts" }
        → { contents: "...taxId missing on InvoiceDto..." }
step 2  repo.write_file  { path: "src/billing/invoice.dto.ts", content: "... + taxId ..." }
step 3  build.run_typecheck {}
        → { ok: true }
```

The signal is _consecutive identical_ calls. Re-reading a file after editing a
different one is not clutter — it is a different argument, and it does not trip the
guard.

### 2. Redundant narration

**Bad** — the final message re-narrates the whole run to a reader who has the timeline:

```text
I began by reading the invoice DTO. I found that taxId was missing. I then wrote the
taxId field to the DTO. After that, I ran the typecheck. The typecheck passed. In
summary, I added taxId to the invoice DTO and the typecheck passed.
```

**Good** — the final message is the _outcome_, and nothing already on the timeline:

```text
Added `taxId` to `InvoiceDto` and its PDF template. Typecheck clean.
```

The transcript already shows the calls; the summary should not repeat them.

### 3. Duplicate work items

**Bad** — a bug-triage pass files the same issue every run:

```text
tracker.create_issue { title: "NullPointer in checkout.ts:88" }   ← run 1
tracker.create_issue { title: "NullPointer in checkout.ts:88" }   ← run 2, same fingerprint
```

**Good** — check the fingerprint first; file only what is new:

```text
errors.list_recent    → [ ...checkout.ts:88 seen last run... ]
memory.store          { fingerprint: "checkout.ts:88", ... }
# no create_issue: nothing new
```

The stock BugTriage prompt states this directly — "Do not file duplicates. If nothing
is new, say so and exit." — and uses `memory.store` to remember seen fingerprints.

## What the runtime catches: `tool_call_repeat_detected`

Form 1 is mechanical, so the runtime stops it. `RepeatGuard`
([`packages/agent-runtime/src/repeat-guard.ts`](../../packages/agent-runtime/src/repeat-guard.ts))
observes each tool call's signature — the skill name plus a key-sorted serialization of
its arguments — and fails the step the moment the same signature appears
`MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS` (3) times in a row. The loop wires it in
`toolsNode` ([`packages/agent-runtime/src/loop.ts`](../../packages/agent-runtime/src/loop.ts)):

```ts
if (repeatGuard.observe(toolCallSignature(skillName, input))) {
  return { outcome: { kind: 'failed', reason: 'tool_call_repeat_detected' } };
}
```

Key-order is normalized, so `{ path, content }` and `{ content, path }` count as the
same call. The guard is deliberately **consecutive-only**: an agent that reads a file,
edits another, then reads the first again never trips it. Alternating loops (A, B, A,
B, …) are left to the per-step tool-call budget, because they are ambiguous — re-running
tests after each edit is legitimate.

This is a _floor_, not a substitute for authoring. Recovery steps are in the operator
runbook under [`tool-call-repeat`](05-operator-runbook.md#tool-call-repeat).

## Authoring checklist

When writing or reviewing an agent, its prompt, or its skills:

- **Give the agent a next step.** A prompt that states only the goal leaves the model
  with nothing to do once it has read the input, which is how verbatim retries start.
- **Make tool results unambiguous.** A success-shaped empty result reads as "didn't
  run" and invites a retry. Return an explicit error or a non-empty payload.
- **Keep the final message to the outcome.** The timeline already carries the calls;
  do not re-narrate them.
- **Check before you file.** Any agent that creates work items must look first
  (`memory.store` / `errors.list_recent`) and file only what is new.
- **Prefer a bounded plan to open exploration.** A step that knows which files it will
  touch uses fewer turns than one that searches for them.

## Where this is enforced

| Clutter form         | Mechanism                                                 | Source                                                             |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| Repeated tool calls  | `RepeatGuard` → `tool_call_repeat_detected`               | `packages/agent-runtime/src/repeat-guard.ts`, `loop.ts`            |
| Redundant narration  | prompt guidance; reviewer verdict                         | `packages/domain/src/stock-agents.ts`, `default-mergecrew-yaml.ts` |
| Duplicate work items | prompt guidance (`Do not file duplicates`) + fingerprints | `packages/domain/src/default-mergecrew-yaml.ts`                    |
