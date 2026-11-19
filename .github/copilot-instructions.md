# Copilot instructions for CCOF (Claude Code on Foundry)

> Place this file at `.github/copilot-instructions.md`. Copilot reads it on every chat, agent and
> code-review request in this repository. The build plan is `docs/harness/BUILD-PLAN.md`.

## What this repository is

CCOF routes Claude Code through one Azure API Management gateway to Claude models on Microsoft Foundry.
Access, models, token limits and monthly dollar budgets are set per Entra security group; every request
is charged to a cost code. **It is deployed at a customer.** Treat every change as a change to a running
production system.

| Part | Code | Runs as |
| --- | --- | --- |
| Gateway policy | `infra/gateway/policy/*.template.xml`, rendered by `infra/gateway/render.ts` | APIM policy |
| Resolver | `src/resolver/` | Function App, called only by APIM's managed identity |
| Sync | `src/sync/` | Function App timer, Graph → Cosmos entitlements |
| Reconciler | `src/reconciler/`, `src/cost/`, `config/rate-card.json` | Function App timer, prices usage, writes budget state |
| Admin console | `admin/` (API in `admin/src`, React UI in `admin/ui-v3`) | Separate Function App |
| Developer client | `client/`, `scripts/client/` | Developer workstations |
| Deployment | `infra/staged/` (current), `infra/quickstart`, `infra/manual` (earlier paths) | PowerShell + Bicep |
| Reporting | `analytics/` (KQL, workbook, alerts) | Log Analytics |

## Hard rules (never break these)

1. **No Azure or Entra writes.** Never run `-Apply`, `-MakeCurrent`, `az ... create|update|delete|set`,
   `az rest --method put|patch|post|delete`, role assignments, or Graph writes. You may *write* such commands
   into a file or a reply for the human to run.
2. **No paid model traffic.** Never set `CCOF_LIVE_TESTS=1` or `CCOF_LIVE_SMOKE=1`, and never run
   `scripts/Test-OwnerSmoke.ps1` or Stage 8 yourself.
3. **Never print, log, commit or paste tokens, secrets, connection strings or app-setting values.**
   Customer data goes only into gitignored `.env.*` folders; only pseudonymized fixtures are committed.
4. **Never weaken a test to make it pass.** Do not delete, skip, loosen or re-baseline a test or golden file
   unless the task explicitly says so. A golden-file change needs `CCOF_UPDATE_GOLDEN=1`, a stated reason in
   the PR and the `golden-change` label.
5. **Never edit `config/rate-card.json` entries in place.** Close the old entry with `effectiveTo` and add a new one.
6. **Never edit generated output** (rendered policy, `dist/`, compiled workbooks). Change the source and re-render.
7. **Never push, merge, force-push or change branch protection unless the user explictly allows** Work on a branch; the human merges or asks you to merge.
8. **Stop and ask** if a task conflicts with an invariant below, needs a new dependency, or needs a
   change to `package.json`/lockfiles, `.github/workflows/`, or `.ironclad/charter.json`.

## Invariants (short form; authoritative list: `harness/invariants.json`)

Cite these IDs in commits, PRs and tests that protect them.

- **SEC-01** The resolver fails closed: any invalid input, read failure or missing record is a refusal, never an allow (`src/resolver/decide.ts`).
- **SEC-02** Only APIM's managed identity may call the resolver; the handler refuses when platform auth is off or no principal is present (`src/resolver/http-handler.ts`, ADR-0009).
- **SEC-03** External refusal reasons are collapsed to a small set (`externalCategory`).
- **SEC-04** Model admission is an exact, case-sensitive match; no prefixes, wildcards or date stripping (`config/model-families.json`).
- **SEC-05** `fable` and `mythos` require the CYB classification or `restrictedFamiliesApproved: true` (ADR-0034).
- **SEC-06** No prompts, responses, tokens or credentials in logs or telemetry; sync reads IDs and account state only.
- **SEC-07** Group object IDs authorize; display names are informational only.
- **MON-01** All spend arithmetic uses `decimal.js`; no floating point (`src/reconciler/compute-ceiling.ts`).
- **MON-02** Exactly five token categories; an unknown category throws (`src/cost/token-categories.ts`).
- **MON-03** The rate card is append-only (rule 5).
- **MON-04** 100 CCU = USD 1; a stored budget keeps its own currency (`src/cost/budget-units.ts`).
- **MON-05** `spent >= budget` means exhausted, ceiling 0, refusal (`src/reconciler/reconcile-person.ts`).
- **MON-06** The reconciler writes nothing unless every read succeeded (`src/reconciler/run.ts`).
- **SYNC-01** A failed group read freezes that project; it is never an empty group (`src/sync/plan.ts`).
- **SYNC-02** Removals are withheld when they exceed both removal limits.
- **SYNC-03** A person in two classification groups keeps the incumbent, or gets neither.
- **SYNC-04** Disabled accounts are not admitted; an unknown account state is not "disabled".
- **DATA-01** `decisionVersion: 3`, cache namespace `ccof-ent:d3`; urgent revocation = bump `keyVersion`.
- **DATA-02** Trace sources `ccof.usage.v1` / `ccof.resolver.v1` and the columns of `analytics/ledger.kql` are contracts.
- **DATA-03** Cosmos container names, partition keys and document IDs are contracts (old and new versions run side by side during an upgrade).
- **OPS-01** Function names `resolve`, `health`, `myUsage`, `syncEntitlement`, `registrySeed`, `snapshotApply`, `reconcileBudgets` and their `AzureWebJobs.<name>.Disabled` settings never change; no hyphens.
- **OPS-02** Timers register only in the app whose `CCOF_APP_ROLE` matches.
- **DEP-01** Stages run 0–8 in order; a stage refuses to run before the stages it reads.
- **DEP-02** Stage 1 is create-only; its values never change for an existing resource group.
- **DEP-03** A preview changes nothing; `-Apply` verifies by read-back; a failed read-back records nothing.
- **DEP-04** An existing `.staged-state/state.json` keeps working; no stage turns stale without an input change.
- **DEP-05** Ownership is by exact resource ID, never by name prefix; stages never delete.
- **DEP-06** The gateway policy is deployed only as a new non-current revision (`infra/gateway/Deploy-GatewayRevision.ps1`), never edited in the Portal.
- **CLI-01** The client config schema and `signInMethod` (`msal` | `azure-cli`) stay compatible; every setup script has a restore script.
- **DOC-01** Commands and parameters shown in docs exist in the scripts they name.

## Risk tiers (authoritative mapping: `harness/tiers.json`; classify a change with `node harness/classify-change.mjs --base main`)

| Tier | Paths (examples) | Minimum checks |
| --- | --- | --- |
| T0 docs | `docs/**`, `*.md` | Docs tests (`tests/docs-*.test.ts`, `tests/Test-*Guide*.ps1`) |
| T1 internal | `admin/ui-v3/**`, `tests/**`, `scripts/load/**` | T0 + affected unit tests + typecheck |
| T2 contract | `src/contracts/**`, `config/**`, `admin/openapi.yaml`, `analytics/**`, `client/**` | T1 + full `npm test` + golden + compatibility tests |
| T3 deployed behaviour | `infra/gateway/**`, `src/resolver/**`, `src/reconciler/**`, `src/sync/**`, `src/cost/**`, `infra/staged/**`, `**/*.bicep` | T2 + scenario evals + customer replay + human review + live lab check |

A change takes the highest tier of any file it touches.

## Commands

```powershell
npm ci --ignore-scripts --no-audit --no-fund          # root; repeat in admin/ and client/
npm test                                              # every Node and PowerShell suite, offline
node --test tests/<name>.test.ts                      # one Node suite
pwsh -NoProfile -File tests/<Name>.ps1                # one PowerShell suite
npx tsc -p tsconfig.typecheck.json                    # typecheck
npx tsc -p tsconfig.json                              # build
npm --prefix admin test ; npm --prefix client test    # admin and client suites
node .ironclad/gate.mjs --stage pre-commit            # fast gate
node .ironclad/gate.mjs --stage packet                # definition of done
az bicep build --file <template.bicep> --stdout       # compile one template
```

Requirements: Node.js 22, PowerShell 7, Azure CLI with Bicep, Python, .NET SDK (KQL checker).
Keep `CCOF_LIVE_TESTS=0`. Source files stay under 400 lines and test files under 800 (`.ironclad/charter.json`).

## How to work on any task

1. Say which tier the change is and which invariants it touches, before editing.
2. **Bug fix:** first write a test that fails for the reported reason, then fix, then show it passes.
   **Feature:** write the tests that define it first. **Docs:** check every command against the script.
3. Make the smallest change that does the job. Do not refactor or reformat unrelated code.
4. Run the checks for the tier. Report the commands you ran and their pass/fail counts; never claim a
   check passed that you did not run.
5. Update `docs/CHANGELOG.md` and `docs/STATUS.md`; add an ADR in `docs/adr/` for any decision that changes
   behaviour, a contract or an invariant (next free number after the highest existing one).
6. End with: summary, tier, invariants touched, files changed, test evidence, docs updated, ADR (yes/no),
   anything the human must do (for example a live check).
