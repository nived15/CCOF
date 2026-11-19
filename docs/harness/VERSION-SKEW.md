# Version skew (P5)

During an upgrade, the customer's deployed version (N-1) and the new version run side by side. The new resolver
reads documents the old sync and reconciler wrote, and the old gateway policy reads replies from the new resolver
until its revision is made current, and the other way round. `tests/harness-version-skew.test.ts` checks both
directions:

| Check | How |
| --- | --- |
| Current readers accept documents N-1 wrote | The current group reader, registry reader and resolver run on N-1's documents. The registry view (scopes, budgets, members) must equal N-1's own reading, and each resolver outcome must equal N-1's recorded reply. |
| N-1 readers accept documents the current version writes | N-1's compiled readers (vendored) run on the current documents and must match the current readings and replies. |
| Replies pass the other policy's validation | Every reply from both versions goes through both policies' `ccofResolverResult` C# expression (`tests/helpers/policy-csharp.ts`). Both must read it the same way: allows as `allow`, refusals as `refuse`. |

## Capturing N-1

```powershell
node harness/capture-version.mjs              # the deployed commit in tests/fixtures/customer/manifest.json
node harness/capture-version.mjs --ref <sha>
```

The script checks out the commit in a temporary git worktree and runs `harness/version/capture-artifacts.mts`
against that version's own code and test helpers. It records five scenarios, each with its documents and resolver
reply, plus the rendered policy. It then builds the commit and copies the compiled readers, with their imports,
into `tests/fixtures/version-n-1/`. The test then needs no git history. Run it again after every customer upgrade.

## Deliberate changes it catches (2026-11-19, N-1 = `9faa1fc`)

| Change | Caught by |
| --- | --- |
| The current policy expects `decisionVersion` 4 | the policy check: N-1 replies are read differently |
| The current resolver requires a membership field N-1 never wrote | both document checks |
| The current reconciler silently drops project documents without a new schema field | both document checks (registry views differ) |
