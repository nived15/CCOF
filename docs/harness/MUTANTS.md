# Mutation sentinels (harness P7)

Mutation sentinels check that the tests would notice a broken guard. Each mutant in `harness/mutants.json` swaps
one exact string in a module that runs at the customer for a plausible mistake, and names the invariant it attacks.
If no test fails, the guard is unprotected.

## Run

```powershell
node harness/run-mutants.mjs                    # every mutant against HEAD, about 6 minutes
node harness/run-mutants.mjs --only mon05-exhausted-strict,sync01-failed-read-readable
node harness/run-mutants.mjs --area gateway --ref main --out report.json
node harness/run-mutants.mjs --list             # id, invariant, area, file
```

- The runner checks out `--ref` (default `HEAD`, so commit first) in a temporary detached git worktree, with
  `node_modules` linked from the repository, and never writes to your working tree.
- It runs the union of the selected areas' suites unmutated first. If that baseline fails, it stops with exit 2 and
  classifies nothing.
- Then, for each mutant, it applies the change, runs only that area's suites (`suites` in `mutants.json`), and
  restores the file.
- A mutant is **killed** when a suite fails or times out (`--timeout`, default 600 s), and **survives** when every
  suite passes.
- **Exit codes:**
  - 0: every mutant was killed.
  - 1: a mutant survived, or a mutant recorded with `equivalentReason` was killed (the recorded reason is wrong).
  - 2: setup failed.
- The report (`--out`) lists, for each mutant, the files and the first tests that killed it.
- The golden and version-skew tests (`excludedSuites`) are never run: they flag any edit to the template or
  contracts, so they would kill every mutant without testing the behaviour.
- `tests/harness-mutants.test.ts` runs in `npm test`. It checks that every mutant's original text still appears
  exactly once, names a register invariant and targets a T3 module (T2 for the `contracts` area). When you change a
  guarded line, that test fails. Update the mutant's `original` and `replacement` to match the new code; don't
  delete the mutant.

## Result (2026-11-19, commit `22789ea`)

All 47 mutants were killed. The mutated runs took 343 s in total. No mutant is recorded as equivalent.

The first run left five survivors. A scenario now kills each one (`docs/harness/SCENARIOS.md`):

| Survivor | Gap | New scenario |
| --- | --- | --- |
| `data01-gateway-version` | the cached-decision check accepted a newer `decisionVersion` | `data01-newer-cached-invalid` (with control `data01-cached-v3-valid`) |
| `data01-gateway-reply-version` | the resolver-reply check accepted a newer `decisionVersion` | `data01-newer-reply-refused` |
| `sec03-gateway-collapse` | a cached refusal could carry any code to the caller | `sec03-cached-refusal-collapsed` |
| `mon05-guard-warning-boundary` | no test at exactly the warning threshold | `guard-warning-at-threshold` |
| `mon06-entitlement-read-swallowed` | no test of a failed entitlement read in a reconciler run | `mon06-entitlement-read-fails` |

`sec07-selector-lowercase` was first recorded as equivalent, because P6 found it changes nothing end to end. It is
killed by `tests/gateway-request-checks.test.ts`, which tests the expression itself, so it is now an ordinary
mutant.

| Mutant | Invariant | Killed by (first three files) |
| --- | --- | --- |
| `sec01-budget-missing-allows` | SEC-01 | `harness-scenarios`, `resolver-backend-descriptor`, `resolver-decide` |
| `sec01-stale-served` | SEC-01 | `resolver-budget-exhaustion`, `resolver-freshness`, `resolver-http-handler` |
| `sec01-invalid-exhausted-flag` | SEC-01 | `resolver-budget-exhaustion`, `resolver-freshness` |
| `sec01-legacy-lease-ignored` | SEC-01 | `resolver-freshness` |
| `sec01-future-verified-at` | SEC-01 | `resolver-freshness`, `resolver-pilot-contract` |
| `sec01-unknown-aggregate-mode` | SEC-01 | `resolver-freshness`, `resolver-pilot-contract` |
| `sec01-key-person-mismatch` | SEC-01 | `resolver-decide`, `resolver-http-handler` |
| `sec01-duplicate-active` | SEC-01 | `resolver-group-precedence`, `resolver-pilot-contract` |
| `sec01-inactive-counted` | SEC-01 | `resolver-decide`, `resolver-group-precedence`, `resolver-pilot-contract` |
| `mon05-exhausted-ignored` | MON-05 | `harness-scenarios`, `resolver-budget-exhaustion`, `resolver-group-precedence` |
| `mon05-strict-aggregate-skipped` | MON-05 | `resolver-budget-exhaustion`, `resolver-decide`, `resolver-freshness` |
| `sec02-auth-off-open` | SEC-02 | `resolver-http-handler`, `resolver-my-usage-handler` |
| `sec02-no-principal` | SEC-02 | `harness-scenarios`, `resolver-http-handler`, `resolver-my-usage-handler` |
| `sec02-auth-setting-loose` | SEC-02 | `resolver-http-handler` |
| `sec03-reasons-passed-through` | SEC-03 | `resolver-backend-descriptor`, `resolver-budget-exhaustion`, `resolver-family-quotas` |
| `sec03-distinct-status` | SEC-03 | `resolver-decide`, `resolver-http-handler` |
| `data01-resolver-version` | DATA-01 | `harness-scenarios`, `resolver-family-quotas` |
| `sec04-gateway-case-insensitive` | SEC-04 | `gateway-family-quotas`, `harness-scenarios` |
| `sec04-gateway-prefix-match` | SEC-04 | `gateway-family-quotas`, `harness-scenarios` |
| `sec04-gateway-ambiguous-family` | SEC-04 | `gateway-family-quotas` |
| `sec05-gateway-restricted` | SEC-05 | `gateway-family-quotas` |
| `data01-gateway-version` | DATA-01 | `harness-scenarios` |
| `data01-gateway-reply-version` | DATA-01 | `harness-scenarios` |
| `data01-cache-namespace` | DATA-01 | `gateway-family-quotas`, `gateway-render` |
| `mon05-gateway-zero-ceiling` | MON-05 | `gateway-dollar-ceiling` |
| `sec03-gateway-collapse` | SEC-03 | `harness-scenarios` |
| `sec07-selector-lowercase` | SEC-07 | `gateway-request-checks` |
| `sec05-contract-restricted` | SEC-05 | `harness-scenarios`, `model-families-contract`, `resolver-family-quotas` |
| `sec04-contract-case-insensitive` | SEC-04 | `model-families-contract` |
| `mon05-exhausted-strict` | MON-05 | `budget-acceptance`, `harness-scenarios`, `reconciler-budget-guard` |
| `mon05-exhausted-ceiling` | MON-05 | `harness-scenarios`, `reconciler-reconcile` |
| `mon05-guard-warning-boundary` | MON-05 | `harness-scenarios` |
| `mon01-ceiling-rounds-up` | MON-01 | `reconciler-budget-guard`, `reconciler-ceiling` |
| `mon01-float-spend` | MON-01 | `reconciler-compute-ceiling` |
| `mon02-four-categories` | MON-02 | `budget-acceptance`, `cost-contract-schedule`, `cost-price-usage` |
| `mon02-partial-as-priced` | MON-02 | `budget-acceptance`, `cost-price-usage`, `harness-scenarios` |
| `mon03-closed-entry-in-force` | MON-03 | `cost-contract-schedule`, `cost-price-usage`, `cost-rate-card` |
| `mon04-ccu-rate` | MON-04 | `budget-acceptance`, `cost-budget-units`, `cost-price-usage` |
| `mon04-currency-swapped` | MON-04 | `cost-budget-units`, `harness-scenarios`, `integration-family-budget` |
| `mon06-entitlement-read-swallowed` | MON-06 | `harness-scenarios` |
| `sync01-failed-read-readable` | SYNC-01 | `harness-scenarios`, `sync-account-state`, `sync-plan-safety` |
| `sync02-count-floor-dropped` | SYNC-02 | `sync-account-state`, `sync-plan-safety`, `sync-plan` |
| `sync02-fraction-dropped` | SYNC-02 | `harness-scenarios`, `sync-account-state`, `sync-plan-safety` |
| `sync02-disabled-override-used` | SYNC-02 | `sync-removal-limits` |
| `sync03-conflict-picks-first` | SYNC-03 | `harness-scenarios`, `sync-plan-safety` |
| `sync04-unknown-is-disabled` | SYNC-04 | `harness-scenarios`, `sync-account-state`, `sync-family-policy` |
| `sync04-disabled-admitted` | SYNC-04 | `harness-scenarios`, `sync-account-state` |

File names omit `tests/` and `.test.ts`.

**Scenario-file kills:** `tests/harness-scenarios.test.ts` runs every layer in one `before` hook. A mutant that
makes any scenario throw therefore fails every test in that file. The other files listed in the table show where the
specific behaviour is caught.

## Adding a mutant

1. Pick a line that enforces an invariant, and pick a plausible wrong version of it: a flipped comparison, a dropped
   refusal, a loosened match, or a swallowed failure.
2. Add an entry to `harness/mutants.json` with these fields:
   - `id`
   - `invariant`
   - `area`
   - `file`
   - `original`: exact and unique in the file. Use `\n` for line breaks; CRLF files still match.
   - `replacement`
   - `description`
3. Run `node --test tests/harness-mutants.test.ts`, commit, then run `node harness/run-mutants.mjs --only <id>`.
4. If it survives, add a scenario or a unit test that kills it. Use `equivalentReason` only when no observable
   behaviour can change, and say why.
