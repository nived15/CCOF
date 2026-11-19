---
mode: ask
description: Review a CCOF diff against the invariants and risk tiers only.
---

# Review a change against the invariants and tiers

Diff: ${input:ref:Base ref or pull request to review against (default main)}

Review only against `harness/invariants.json`, `harness/tiers.json` and the hard rules in
`.github/copilot-instructions.md`. Don't comment on style, naming or anything else.

1. **Classify.** Run `node harness/classify-change.mjs --base <ref>`. Report the tier, the invariants touched and any
   file that is unmatched or ambiguous.
2. **Invariants.** For each invariant touched, read its `statement` and `sources`, and check the diff:
   - Does any line weaken it? For example: a fail-closed refusal turned into an allow, a removed exact match, float
     arithmetic on money, a read failure that is swallowed, or a renamed contract.
   - Quote the line and name the invariant ID.
3. **Tests.** Check whether each changed guard has a test that would fail if it were reverted. Flag these:
   - a deleted, skipped or loosened test;
   - a golden file changed without `CCOF_UPDATE_GOLDEN=1`, a stated reason and the `golden-change` label;
   - a rate-card entry edited in place (rule 5);
   - a hand-edited generated file (rule 6).
4. **Evidence.** Check that the pull request shows every check `node harness/run-checks.mjs --base <ref> --dry-run`
   lists for its tier, with a result. For T3, check that it names the manual checks: human review and the live lab.
5. **Answer** with a table of finding, invariant or rule, file and line, and severity (blocker or concern). End with
   one verdict: `approve`, `changes needed` or `stop and ask the owner`. Report only findings you can show from the
   diff.
