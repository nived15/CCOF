## Summary

<!-- What changes and why. Link the issue or packet. -->

## Tier and invariants

<!-- Run: node harness/classify-change.mjs --base main -->

- **Tier:** <!-- T0 | T1 | T2 | T3 (the highest of any file touched) -->
- **Invariants touched:** <!-- IDs from harness/invariants.json, or "none" -->

## Golden changes

- [ ] None
- [ ] Yes: regenerated with `CCOF_UPDATE_GOLDEN=1`, `golden-change` label added. **Reason:** <!-- required -->

## Test evidence

<!-- Commands run and their pass/fail counts. `node harness/run-checks.mjs --base main` runs every required check. -->

| Command | Result |
| --- | --- |
|  |  |

## Docs and decisions

- [ ] `docs/CHANGELOG.md` and `docs/STATUS.md` updated
- [ ] ADR added in `docs/adr/` (a behaviour, contract or invariant change), or not needed because: <!-- reason -->

## Live check needed

- [ ] No
- [ ] Yes (T3): <!-- which lab or customer check, for the human to run; Copilot never runs live or paid traffic -->
