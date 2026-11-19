# Customer fixture (P3)

The harness tests run against a pseudonymized copy of what is deployed at the customer. You make the copy.
Copilot never runs the collector.

## 1. Collect (read-only)

Sign in with `az login` to the customer tenant with Reader access to the resource group, then run:

```powershell
pwsh -File harness/customer/Collect-CustomerFixture.ps1 -DeployedCommit <sha the customer runs> -ConfigPath <path to staged.config.json>
```

- `-StateDirectory <dir>`: the folder holding `state.json`. It defaults to `.staged-state` next to the config.
- `-IncludeCosmos`: also read a few documents from `entitlement`, `budgetState` and `projects`. A Cosmos account
  behind a private endpoint is not reachable from outside the VNet; the collector then skips the samples and says so
  in `manifest.json`.

The collector allows only `show`, `list` and `GET` Azure CLI commands, and refuses any other command before calling
`az`. It writes only to a new folder under `.env.customer-fixture/`, which git ignores. App settings are listed by
name only: the values are filtered out inside `az` and never reach the script. `freshness.json` records, for each
stage, whether its config and dependency hashes still matched at collection time. Pseudonymizing changes those
hashes, so the P4 replay uses this file.

## 2. Pseudonymize

```powershell
node harness/pseudonymize-fixture.mjs --from .env.customer-fixture/<collection folder>
```

This replaces tenant, subscription, object and group IDs, resource and display names, emails, hostnames and config
hashes with stable fake values, consistently across files, and writes `tests/fixtures/customer/`. The mapping
from original to fake values stays in `.env.customer-fixture/pseudonym-map.json` (gitignored), so a later
collection gets the same fakes. It writes nothing if any original value would remain, or if a GUID, hostname, email,
JWT or secret marker that is not on the allow-list would be left.

## 3. Review and test

Read every file under `tests/fixtures/customer/` before you commit it, then run:

```powershell
node --test tests/harness-fixture-clean.test.ts
pwsh -NoProfile -File tests/Test-HarnessCollector.ps1
```

Until a collection includes Cosmos samples, `tests/fixtures/customer/cosmos/` holds synthetic documents marked
`"synthetic": true`. They are built from the TypeScript types and checked by the real readers.
