---
applyTo: "src/reconciler/**,src/cost/**,config/rate-card.json"
---

# Money: pricing, budgets and the reconciler (T3; the rate card is T2)

These modules decide what people are charged and when they are cut off. Be exact.

## Invariants here

- **MON-01:** all spend arithmetic uses `decimal.js` (`Money` in `src/cost/money.ts`). Never use `Number`, `+` on
  amounts, `toNumber()` mid-calculation, or `Math`.
- **MON-02:** there are exactly five token categories (`src/cost/token-categories.ts`): `input`, `cacheWrite5m`,
  `cacheWrite1h`, `cacheRead`, `output`. An unknown category throws.
- **MON-03:** the rate card is append-only. To change a price, set the old entry's `effectiveTo` and add a new entry
  from that instant (rule 5). Intervals are half-open: `effectiveFrom <= t < effectiveTo`.
- **MON-04:** 100 CCU = USD 1 (`CCU_PER_USD`). A stored budget keeps its own `currency`.
- **MON-05:** `spent >= budget` means exhausted, ceiling 0 and a refusal (`buildPersonState` in
  `src/reconciler/reconcile-person.ts`). The budget guard's warning is also `>=`.
- **MON-06:** a reconciler run writes nothing unless every read succeeded (`src/reconciler/run.ts`). Never catch a
  read failure and continue with empty data.
- **DATA-03:** Cosmos container names, partition keys and document IDs (`src/reconciler/settings.ts`) are contracts.
- **OPS-01 / OPS-02:** the function name `reconcileBudgets` and its `AzureWebJobs.reconcileBudgets.Disabled` setting
  never change. The timer registers only when `CCOF_APP_ROLE` matches.

## Tests

```powershell
node --test tests/reconciler-*.test.ts tests/cost-*.test.ts tests/budget-acceptance.test.ts
node --test tests/harness-scenarios.test.ts tests/harness-golden-ratecard.test.ts
node harness/run-mutants.mjs --area money           # commit first; about 2 minutes
```

## Traps

- **Two paths:** `buildPersonState` (CCU) is what the timer runs. `reconcilePerson` (USD) is the earlier form; don't
  extend it by mistake.
- **Ceilings round down** (`floor`), and cap at `MAX_CEILING_TOKENS` (APIM's 32-bit limit).
- **Streamed cache tokens are unknown (REH-3).** Such rows are `partial` and spend is a lower bound. Never report a
  partial row as `priced`.
- **An unpriced allow-listed model** must fail closed, never be priced at zero.
- **Changing the rate card** changes `tests/golden/` and the customer replay. Follow rule 4 for golden updates.
