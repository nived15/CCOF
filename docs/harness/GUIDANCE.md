# Copilot guidance per area (harness P9)

Copilot reads `.github/copilot-instructions.md` on every request. It also reads an area file from
`.github/instructions/` whenever it works on a file that file's `applyTo` matches.

| File | Applies to | Holds |
| --- | --- | --- |
| `gateway.instructions.md` | `infra/gateway/**` | SEC-04/05/06, DATA-01/02, DEP-06; the duplicated validation and family rules; golden and revision rules |
| `money.instructions.md` | `src/reconciler/**`, `src/cost/**`, `config/rate-card.json` | MON-01 to 06, DATA-03, OPS-01/02; the two reconcile paths, rounding, REH-3 |
| `staged.instructions.md` | `infra/staged/**`, `**/*.bicep` | DEP-01 to 05, SEC-02, DATA-03; the `-DotSourceOnly` trap, stage-input hashes |
| `docs.instructions.md` | `docs/**` | DOC-01; docs tests, ADR numbering, plain language, no customer data |

Prompts in `.github/prompts/`, run from Copilot Chat with `/bugfix`, `/feature`, `/docs-change` or `/review`:

- **`bugfix`:** classify, write a failing test, fix, run `harness/run-checks.mjs`, then record the change.
- **`feature`:** classify, stop at a contract or dependency change, define the feature in tests and add mutants
  for new T3 guards.
- **`docs-change`:** check every command against its script (DOC-01), then run the docs tests.
- **`review`** (ask mode, read-only): review a diff only against the invariants, the tiers and the hard rules, and
  end with a verdict.

`tests/harness-guidance.test.ts` keeps all of these true:

- each area file applies to exactly the paths above;
- each area file names every invariant whose code lives there, from the `sources` in `harness/invariants.json`;
- every invariant ID, path and test glob the guidance mentions exists;
- the prompts keep their modes.

When you move a file or add an invariant, that test tells you which guidance to update.
