---
mode: agent
description: Fix a CCOF bug test-first, within the hard rules and invariants.
---

# Fix a bug

Bug: ${input:bug:Describe the bug, with the observed and expected behaviour}

Follow `.github/copilot-instructions.md`, and the area file in `.github/instructions/` for every file you touch.

1. **Classify.** Name the files you expect to touch and run `node harness/classify-change.mjs --files <paths>`.
   Report the tier and the invariants. If the fix would conflict with an invariant, stop and ask.
2. **Reproduce.** Write a test that fails for the reported reason: a unit test in the area's existing test file, or a
   scenario in `tests/scenarios/` for behaviour across layers (see `docs/harness/SCENARIOS.md`). Run it and show
   that it fails.
3. **Fix.** Make the smallest change that makes the test pass. Don't refactor, reformat or loosen any other test or
   golden file (rule 4).
4. **Check.** Commit, then run `node harness/run-checks.mjs --base main`. For T3, also run
   `node harness/run-mutants.mjs --area <area>`. Report every command with its pass and fail counts.
5. **Record.** Update `docs/CHANGELOG.md` and `docs/STATUS.md`. Add an ADR only if the fix changes a contract or an
   invariant.
6. **Finish** with the summary the instructions require: tier, invariants, files, test evidence, docs, ADR, and any
   live check the human must run.

Never run Azure writes, `-Apply`, live or paid tests, push or merge unless the user has explicitly allowed it.
