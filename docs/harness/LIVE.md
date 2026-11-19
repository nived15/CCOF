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

## L1 run at the customer deployment (2026-11-19), read-only part

The owner asked for L1 to run against the deployed resource group instead of a lab. Copilot ran steps 1–3, with
every command read-only:

- `az` calls went through an allow-list that refuses anything but reads and `what-if`: 48 calls, 0 blocked.
- Previews used a copy of the deployment state. The real `state.json` was unchanged, checked by hash before and after.
- `CCOF_LIVE_SMOKE` was never set: the smoke checks ran in-process with `-NoToken`. No token, no paid request, no VM
  run-command.

Steps 4–6 are commands for the owner. They are written, with rollbacks, in the gitignored
`.env.live-customer/l1-2026-11-19/owner-commands.md`.

| Step | Result |
| --- | --- |
| Starting point | Gateway: release 17 template (the live policy header names template `6e04b5c0…`, config `4314721d…`). Candidate: `main` `814d510`. |
| Smoke baseline (`-NoToken`) | 6 PASS, 2 INFO, 3 SKIP (token checks, and the DNS check, which has no VM). APIM Succeeded; gateway and resolver answer 401 without credentials; resolver functions listed; 10 of 10 Cosmos DB containers present; no jump-box left. Saved as `before.json`. |
| Alert queries, 24 h | Gateway 5xx 0 %, 429 0 %; backend, resolver and budget signals below the minimum sample (no model traffic); last gateway log 4.7 minutes before the query. No alert rule is deployed (LIVE-02). |
| Stage freshness at `main` | Stages 1–6 fresh. Stage 0 and Stage 7 are stale on configuration, as in the P3 fixture; Stage 7 because Stage 4's outputs moved. |
| Previews, Stages 0–7 | Stage 0: all providers registered; Foundry public network access still Enabled (LIVE-01). Stages 1, 2, 4 and 6: no change. Stage 3 what-if: 32 NoChange, 60 Ignore, **no delete, no modify**. Stage 5: the policy changes (see below). Stage 7: republishes all four apps (resolver and admin code changed). |
| Stop conditions | No delete, no Stage 1 change, and no unexpected property change, with one exception: Stage 5 `-Apply` would replace the live policy on the current revision (LIVE-03). Upgrade the policy with `Deploy-GatewayRevision.ps1` only. |

The policy changes between the deployed release 17 and `main`, all from release 18:

- **Chunked bodies:** a request body sent with `Transfer-Encoding: chunked` is refused with HTTP 411
  (`request_length_required`). In step 5, test a client that streams its request body.
- **Error shape:** a Foundry error (HTTP 400 or above) is rewritten into Anthropic's error shape, with a request ID and
  a clearer message for 429.
- **Wording:** the budget-guard message text changes.
