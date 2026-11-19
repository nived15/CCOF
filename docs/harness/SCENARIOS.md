# Scenario evals (P6)

Each file in `tests/scenarios/` is one scenario: an `id` (the file name), the `invariants` it protects, its
`source`, a `layer`, and `given` / `when` / `then`. `tests/harness-scenarios.test.ts` runs every scenario
through the real code (`tests/helpers/scenario-engine.ts`) and compares the observed outcome with `then`. It also
fails if an SEC, MON or SYNC invariant has no executed scenario.

| Layer | Runs | `then` fields |
| --- | --- | --- |
| `gateway` | APIM `validate-jwt` (asserted on the rendered policy), the selector header and its format check, the resolver's HTTP handler over documents built by the real sync and reconciler, the policy's `ccofResolverResult`, family admission and the refusal status and body. All C# is compiled (`tests/helpers/policy-csharp.ts`). | `status`, `refusal`, `errorType`, `group`, `chargedTo`, `logsExclude` |
| `reconciler` | Ledger rows (Haiku 4.5 input, USD 1 per million tokens) priced by the rate card and reconciled with an optional budget guard | `spentUsd`, `budgetUsd`, `exhausted`, `ceiling`, `warning`, `projectedUsd`, `completeness` |
| `pricing` | `computeSpend` over token categories | `usd` or `error` |
| `ledger` | A recorded ledger response parsed and priced | row counts by outcome, `spentUsd`, `listUsd` |
| `sync` | `planSync` with group reads, existing entitlements, account states and removal limits | `holdings`, `writes`, `projectsFrozen`, `events` |
| `reconciler-run` | A full reconciler run with one read failing | `writes`, `outcome` |
| `live-only` | Not run: evidence that needs Azure or the network | `evidence` |

## Catalogue (58 scenarios)

- The 23 bypass attempts of `docs/status/BUDGET-ACCEPTANCE-2026-10-23.md` (`bypass-01` to `bypass-23`). One is
  live-only: a direct call to Foundry (see `docs/UNKNOWNS.md` LIVE-01). `bypass-21` records today's answer
  (budget used up) where the 2026-10-23 run answered "not entitled": both are refusals.
- SEC-01 to SEC-07: fail-closed without budget state, without entitlement and with incomplete usage; platform auth
  off or no principal; restricted families with and without approval; no prompt text in resolver logs; display
  names do not select.
- MON-01 to MON-06: exact decimal sums; the five token categories and the unknown legacy one; price history; CCU
  budgets; exhaustion at equality; reads before writes.
- The budget guard (ADR-0040): slow-down, warning, projected refusal, a new month, and a budget raised mid-month
  (acceptance §6).
- REH-3 as it behaves today: streamed cache categories are unknown, spend is a lower bound and completeness is
  partial.
- Money: the recorded 2026-10-11 ledger response prices to USD 0.00068 (20 partial, 55 unpriced rows).
- SYNC-01 to SYNC-04: frozen on a failed or missing read, withheld removals, classification conflicts, and
  disabled and unknown account states.

## Deliberate changes (2026-11-19)

| Change | Scenarios that fail |
| --- | --- |
| Exhausted at `spent > budget` instead of `>=` | `mon05-equal`, `mon04-ccu-budget` |
| Model admission ignores case | `bypass-09-model-case` |
| A failed group read no longer freezes its project | `sync01-failed-read-freezes`, `sync01-missing-read-is-failed` |
| The gateway stops lower-casing a GUID selector | none: the resolver also compares group IDs in lower case, so the behaviour does not change (an equivalent mutant at this level) |

Add a scenario for every new live finding (BUILD-PLAN L4) and every fixed bug.
