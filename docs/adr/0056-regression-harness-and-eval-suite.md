# ADR-0056: Regression harness and eval suite

Status: accepted, 2026-11-19. Packet: harness P1.

## Context

CCOF is deployed at a customer. A feature, bug fix or documentation change must be checked against what is
deployed before it merges and before it reaches the customer's environment. The repository already has a large
offline suite (`npm test`), the Ironclad gate and a staged preview/`-Apply`/read-back model, but no single list of
the rules that must never break, and no record of which tests protect each rule.
`docs/harness/BUILD-PLAN.md` sets out a harness in packets P0 to P10; P0 recorded the baseline
(`docs/harness/BASELINE.md`).

## Decision

- Build the harness on top of the existing suites, never in place of them. Harness code goes in `harness/`, Node
  tests in `tests/harness-*.test.ts` and PowerShell tests in `tests/Test-Harness*.ps1`, so `npm test` runs them
  with no runner change. No packet adds an npm dependency.
- `harness/invariants.json` is the register of invariants. Each entry has an ID from
  `.github/copilot-instructions.md`, a statement, a category, `sources` (code, configuration and ADRs, verified by
  reading the code), `protectedBy` (test files run by a suite whose assertions fail if the rule breaks) and a
  coverage of `full`, `partial` or `none`. A rule that is not enforced in code is marked `"status": "unverified"`.
- Every invariant without full coverage is listed in `knownGaps` with a reason.
  `tests/harness-invariants.test.ts` fails if the register and the instructions file disagree, if a cited file is
  missing, if a protecting test is not run by a suite, or if `knownGaps` is incomplete. It also fails if
  `knownGaps` changes size from the committed ceiling: a closed gap must lower the ceiling, and raising it is
  loosening a test (instructions rule 4).
- The register starts with 30 invariants and 8 known gaps: DATA-02, DATA-03, MON-03, OPS-01, OPS-02, DEP-06,
  CLI-01 and DOC-01. MON-03 (append-only rate card) and DOC-01 (docs match scripts) are working rules not
  enforced in code, so they are `unverified`.

## Consequences

- A change that adds, removes or renames an invariant must update the instructions file and the register together.
- Later packets close gaps (golden files in P4, scenarios in P6, mutants in P7) and lower the ceiling as they do.
- The register is documentation with a test behind it. It does not change any runtime behaviour, contract or
  invariant.
