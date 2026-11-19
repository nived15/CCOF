---
applyTo: "docs/**"
---

# Documentation (T0)

Operators follow these pages at the customer. A wrong command in a guide is a production incident.

## Invariant here

- **DOC-01:** every command and parameter a page shows exists in the script it names. Before you write one, open
  the script and check its `param(...)` block. If the page quotes printed output, check it against the line that
  prints it.

## Tests

```powershell
node --test tests/docs-long-term-audit.test.ts tests/docs-pseudonymise.test.ts tests/docs-reader-pages.test.ts
pwsh -NoProfile -File tests/Test-PortalGuide.ps1
pwsh -NoProfile -File tests/Test-PublicManualGuide.ps1
node harness/classify-change.mjs --base main            # a docs-only change is T0
```

## Rules

- **Every change** updates `docs/CHANGELOG.md` and `docs/STATUS.md`.
- **A decision** that changes behaviour, a contract or an invariant gets an ADR in `docs/adr/`. Use the next free
  number after the highest file there.
- **Plain language** on reader pages. The tests refuse unknown-register IDs and `CODE-NOTE` placeholders.
- **Prices** carry a source and a retrieval date.
- **No customer data:** no tenant, subscription or object IDs, names or host names. Use the pseudonymized fixtures'
  values or placeholders (rule 3).
- **Harness pages** live in `docs/harness/`. The build plan is `docs/harness/BUILD-PLAN.md`.

## Traps

- **Pages that read like specs:** `docs/INDEX.md` lists them. A test may quote them, so a rewording can fail a test
  in `tests/`. Fix the wording, not the test (rule 4).
- **Known drift:** `docs/GATEWAY.md` names `infra/gateway/config/sample-pilot.json`, which is not in the
  repository. It is recorded in `docs/STATUS.md` and still to fix.
