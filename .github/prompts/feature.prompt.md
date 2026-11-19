---
mode: agent
description: Build a CCOF feature from tests that define it, within the hard rules and invariants.
---

# Build a feature

Feature: ${input:feature:Describe the feature and who it is for}

Follow `.github/copilot-instructions.md`, and the area file in `.github/instructions/` for every file you touch.

1. **Classify.** List the files the feature needs and run `node harness/classify-change.mjs --files <paths>`. Report
   the tier and the invariants. Stop and ask if the feature needs any of these:
   - a new dependency, or a change to `package.json` or a lockfile;
   - a change to `.github/workflows/` or `.ironclad/charter.json`;
   - a change to a contract: decision version, Cosmos names, trace sources, function names or the client config.
2. **Define it in tests.** Write the tests that define the feature before the code, including at least one edge or
   refusal case. A feature that crosses the gateway, resolver, sync or reconciler also gets a scenario in
   `tests/scenarios/`.
3. **Build it** in the smallest change that passes those tests. Keep source files under 400 lines and test files
   under 800.
4. **Check.** Commit, then run `node harness/run-checks.mjs --base main`. For T3, add a mutant to
   `harness/mutants.json` for each new guard, and run `node harness/run-mutants.mjs --only <id>`. Report every
   command with its counts.
5. **Record.** Update `docs/CHANGELOG.md` and `docs/STATUS.md`, and the operator docs whose commands change (DOC-01).
   Add an ADR for every decision that changes behaviour, a contract or an invariant.
6. **Finish** with the summary the instructions require, including any live check the human must run.
