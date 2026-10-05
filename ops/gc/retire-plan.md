# Engine retirement plan (ADR-0016 step 5)

| Module | Files | Lines | Inbound refs | Internal refs |
| - | - | - | - | - |
| `apps/orchestrator` | 22 | 4791 | 1 | 0 |
| `packages/agent-runtime` | 17 | 3467 | 2 | 1 |
| `apps/runner` | 28 | 6885 | 0 | 0 |
| `apps/runner-agent` | 8 | 1142 | 0 | 0 |
| `apps/worker-cron` | 14 | 1233 | 1 | 0 |

## Retirement order

Leaf first. A module goes when it has no internal reference and no outside reference.

1. `apps/runner` — internal refs 0, outside refs 0
2. `apps/runner-agent` — internal refs 0, outside refs 0
3. `apps/orchestrator` — internal refs 0, outside refs 1
4. `apps/worker-cron` — internal refs 0, outside refs 1
5. `packages/agent-runtime` — internal refs 1, outside refs 2

## References

A reference is a resolved import (`from`, `import(`, or `require(`).
A path inside a string is data, not a reference.
A test file that imports a target counts. The retirement must delete or rewrite it.

## Blockers

- `apps/orchestrator` is referenced by 1 file(s):
  - `ops/gc/test/retire-plan.test.mjs` (1)
- `packages/agent-runtime` is referenced by 2 file(s):
  - `ops/gc/test/retire-plan.test.mjs` (2)
  - `apps/runner/src/step.ts` (1)
- `apps/worker-cron` is referenced by 1 file(s):
  - `scripts/telemetry-preview.ts` (1)
