---
applyTo: "infra/gateway/**"
---

# Gateway policy (T3: deployed behaviour)

The APIM policy is the only door to the models. Every change here reaches production through a new gateway revision.

## Invariants here

- **SEC-04:** model admission is an exact, case-sensitive, ordinal match against the decision's family policy. Never
  use prefixes, wildcards, `OrdinalIgnoreCase` or date stripping.
- **SEC-05:** `fable` and `mythos` need the `CYB` classification or a `group` with `restrictedFamiliesApproved: true`.
- **SEC-06:** no prompt, response, token or credential in a trace, header or log.
- **DATA-01:** a valid decision has `decisionVersion` exactly `3`, and the cache key starts `ccof-ent:d3:v`. Urgent
  revocation means bumping `keyVersion` (`%%CACHE_KEY_VERSION%%`), not changing the namespace.
- **DATA-02:** the trace source `ccof.usage.v1` and the fields `analytics/ledger.kql` reads are contracts.
- **DEP-06:** deploy only with `infra/gateway/Deploy-GatewayRevision.ps1`, which creates a new non-current revision.
  Never edit the policy in the Portal.

## Edit the source, not the output

- The sources are `infra/gateway/policy/*.template.xml` and `infra/gateway/render.ts` (with `config.ts` and
  `template.ts`). Never edit rendered XML (rule 6).
- Render with `node infra/gateway/render.ts --config <file> [--out <dir>]`.

## Tests

```powershell
node --test tests/gateway-*.test.ts                 # policy C# is compiled and run (needs .NET 10)
node --test tests/harness-scenarios.test.ts         # end-to-end bypass and invariant scenarios
node --test tests/harness-golden-policy.test.ts tests/harness-version-skew.test.ts
pwsh -NoProfile -File tests/Test-GatewayRevisionFragments.ps1
pwsh -NoProfile -File tests/Test-HarnessCustomerReplay.ps1
node harness/run-mutants.mjs --area gateway         # commit first; about 5 minutes
```

## Traps

- **Validation exists twice.** The resolver reply is checked in `ccofResolverResult` and a cached decision in
  `ccofCachedDecisionValid`. Change both, or a cached entry and a fresh reply disagree (P7 found both version
  checks untested).
- **The restricted-family rule exists twice:** in `ccofModelFamily` (admission) and `ccofAllowedModels` (the models
  a refusal lists).
- **The cached-refusal mapping** passes only `project_selection_required`, `budget_state_unavailable`,
  `budget_exhausted`, `budget_projected` and `aggregate_budget_exhausted`. Everything else collapses to
  `not_authorized` (SEC-03).
- **C# lives inside XML attributes.** Tests extract it with `tests/helpers/policy-csharp.ts`. Each `runExpressions`
  call compiles once (about 1.5 s), so batch the vectors.
- **Any template change moves the golden policy and the customer digest.** Update the golden file only with
  `CCOF_UPDATE_GOLDEN=1`, give the reason in the PR and add the `golden-change` label (rule 4).
- **Line endings:** templates are hashed LF-normalised. Don't rely on `String.Replace` across CRLF/LF; use regexes.
- **Never deploy:** never run `Deploy-GatewayRevision.ps1` without a preview, `-MakeCurrent`, or any `az` write
  (rule 1). Write the command for the human instead.
