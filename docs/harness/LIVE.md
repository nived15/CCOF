# Live checks (harness Part C)

Live work follows `docs/harness/BUILD-PLAN.md` Part C. **Copilot runs read-only commands only after you approve each
one.** Copilot writes the commands for `-Apply`, `-MakeCurrent`, Stage 8, `scripts/Test-OwnerSmoke.ps1` and anything
paid; you run them. Raw output stays in `.env.live-lab/` or `.env.live-customer/` (gitignored), and only summaries
are committed.

## `scripts/Test-LiveSmoke.ps1` (fixed in L0)

1. Copy `harness/live/live-config.example.json` to `.env.live-lab/live-config.json`, the default `-ConfigPath`. For
   the customer, copy it to `.env.live-customer/live-config.json` and pass that path.
2. Fill every `<...>` value. `harness/live/LiveTestConfig.ps1` refuses placeholders and invalid values (GUIDs,
   `https://` URLs, a `probeMaxTokens` of 1 to 16), naming each one. With `-NoToken`, the `cloud.*` and
   `testClient.*` values may stay as placeholders.
3. Run the read-only checks, which need no token and make no paid request:

```powershell
$env:CCOF_LIVE_SMOKE = '1'
./scripts/Test-LiveSmoke.ps1 -NoToken -ResultPath .env.live-lab/before.json
./scripts/Test-LiveSmoke.ps1 -NoToken -ApiRevision <N> -BaselinePath .env.live-lab/before.json
```

The checks query APIM, the gateway's anonymous 401, the resolver's 401, the function list, the Cosmos DB containers,
the Foundry private endpoint, DNS and the backend redundancy. All of them are read-only `az` and HTTP calls.

### The token checks

The token checks (`identity.test-token`, `gateway.with-token`) need `scripts/Get-E2ETestToken.ps1`. That script is
not in this repository, and no copy was found on the build machine (2026-11-19). The smoke script now loads it only
when a token is requested; without it, the token checks fail with that reason, and `-NoToken` is unaffected.

The token path creates a short-lived app secret in Entra and makes one paid request. At the customer it needs
approval like any other write. Until the script is restored, cover the token path with Stage 8 and
`scripts/Test-OwnerSmoke.ps1`, which you run yourself.

`tests/Test-LiveSmoke.ps1` tests all of this offline, with fake probes, as part of `npm test`.
