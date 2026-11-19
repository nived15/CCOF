---
applyTo: "infra/staged/**,**/*.bicep"
---

# Staged deployment and Bicep (T3: deployed behaviour)

`infra/staged/Invoke-StagedDeployment.ps1` deployed the customer. Its saved `state.json` must keep working after
every change.

## Invariants here

- **DEP-01:** stages run 0 to 8 in order. A stage refuses to run before the stages it reads.
- **DEP-02:** Stage 1 is create-only. Its values never change for an existing resource group.
- **DEP-03:** without `-Apply` a stage only previews (Bicep `what-if` or a printed plan). `-Apply` verifies by
  reading back, and a failed read-back records nothing.
- **DEP-04:** an existing `.staged-state/state.json` keeps working. No stage turns stale without an input change.
- **DEP-05:** ownership is by exact resource ID, never by name prefix. Stages never delete.
- **SEC-02:** Stage 7's App Service Authentication on the resolver admits only APIM's managed identity
  (`infra/staged/Staged.Application.ps1`).
- **DATA-03:** Cosmos container names, partition keys and document IDs (`infra/staged/Staged.Resources.ps1`) are
  contracts. An upgrade runs old and new side by side.

## Tests

```powershell
pwsh -NoProfile -File tests/Test-StagedStages.ps1
pwsh -NoProfile -File tests/Test-StagedPreviews.ps1
pwsh -NoProfile -File tests/Test-StagedRedeployment.ps1
pwsh -NoProfile -File tests/Test-HarnessCustomerReplay.ps1      # the customer's sealed state stays fresh
node --test tests/harness-golden-bicep.test.ts tests/harness-golden-names.test.ts
az bicep build --file infra/staged/main.bicep --stdout          # Bicep v0.46.1
```

Run every `tests/Test-Staged*.ps1` before a pull request.

## Traps

- **Never run `-Apply`** or any Azure write (rule 1). Previews still call Azure, so leave them to the human too.
- **`-DotSourceOnly` runs the param block in the caller's scope.** It overwrites `$ConfigPath`, `$StateDirectory`
  and an `[int]` `$Stage`, which also clobbers `$stage`, because PowerShell names are case-insensitive. Copy your
  arguments first and use prefixed names.
- **Stage input hashes cover slices of the config** (`Get-StgStageInput`). Adding a field to a slice turns that stage
  stale for every existing deployment (DEP-04). Default the field so its hash does not move.
- **A Bicep property marked create-only** in `tests/golden/bicep-inventory.json` cannot change for existing
  resources.
- **Customer values** go only in gitignored `.env.*` folders (rule 3).
