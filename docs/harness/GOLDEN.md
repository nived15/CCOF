# Golden contracts (P4)

Golden files under `tests/golden/` record what a deployed installation depends on. A test fails when the code
changes one of them. Update a golden only on purpose, with a stated reason in the pull request and the
`golden-change` label (`.github/copilot-instructions.md`, rule 4):

```powershell
$env:CCOF_UPDATE_GOLDEN = '1'; node --test tests/harness-golden-names.test.ts; Remove-Item Env:CCOF_UPDATE_GOLDEN
```

| Test | Golden | Fails when | Invariants |
| --- | --- | --- | --- |
| `tests/harness-golden-policy.test.ts` | `policy/` | the policy rendered for the customer fixture changes in any way | DATA-01, DATA-02 |
| `tests/harness-golden-bicep.test.ts` | `bicep-inventory.json` | a resource in `infra/staged/*.bicep` disappears or is renamed, or a create-only property changes | DATA-03, DEP-02, DEP-05 |
| `tests/harness-golden-names.test.ts` | `runtime-names.json` | a function name, role guard, `AzureWebJobs.*.Disabled` setting, app setting, Cosmos container or partition key, trace source or `ledger.kql` column changes | OPS-01, OPS-02, DATA-02, DATA-03 |
| `tests/harness-golden-admin-api.test.ts` | `admin-api.json` | `admin/openapi.yaml` removes a path, method or response field, or makes a parameter or request body newly required (additions pass) | — |
| `tests/harness-golden-ratecard.test.ts` | `rate-card-entries.json` | a rate card entry is edited, removed, reopened or closed before it began (new entries and closing an open one pass) | MON-03 |
| `tests/Test-HarnessCustomerReplay.ps1` | `fixtures/customer/state.sealed.json` | the current staged driver reports a stage stale that the deployed commit accepted, or refuses the customer's config or state | DEP-01, DEP-04 |

## How the policy golden is rendered

`harness/golden/Render-CustomerPolicy.ps1` builds the gateway configuration with Stage 5's own statements. It takes
the customer fixture's config and recorded stage outputs, so no Azure call is made, and runs
`infra/gateway/render.ts`. The test fails if `Invoke-Stage5` no longer contains those statements.

## The customer replay

Pseudonymizing changes every input of the stage hashes. `harness/customer/Seal-FixtureState.ps1` checks out the
deployed commit (`manifest.json`) in a temporary worktree. With that commit's driver, it recomputes the hashes of
the stages that were fresh at collection (`freshness.json`), then writes `state.sealed.json` and `seal.json`. The
replay reads the sealed state with the current driver.

Run the seal again after every re-collection:

```powershell
pwsh -File harness/customer/Seal-FixtureState.ps1
```

## Deliberate changes each test catches (2026-11-19)

| Change | Caught by |
| --- | --- |
| Rename the `ccof-admission-person` rate limit in the policy template | policy golden |
| Change the `budgetState` partition key; drop the `backends` container | Bicep inventory |
| Rename the `health` function; rename `RESOLVER_REQUEST_DEADLINE_MS`; drop a `ledger.kql` column | runtime names |
| Rename the `/projects/{projectId}/settings` path | admin API |
| Add an input to the Stage 1 hash in `Staged.Common.ps1` | customer replay (stage 1 reported stale, DEP-04) |
