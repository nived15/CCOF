---
mode: agent
description: Change CCOF documentation so that every command and output it shows is true (DOC-01).
---

# Change documentation

Change: ${input:change:What should the documentation say, and on which pages}

Follow `.github/instructions/docs.instructions.md`.

1. For every command, parameter or switch you write, open the script it names and confirm it in the `param(...)`
   block or the CLI parser. Quote printed output only after finding the line that prints it.
2. Change only the pages the request needs. Use plain words on reader pages, with no customer identifiers.
3. Run the docs checks and report their counts:
   - `node --test tests/docs-long-term-audit.test.ts tests/docs-pseudonymise.test.ts tests/docs-reader-pages.test.ts`
   - `pwsh -NoProfile -File tests/Test-PortalGuide.ps1`
   - `pwsh -NoProfile -File tests/Test-PublicManualGuide.ps1`
4. If a docs test fails because the page now disagrees with the code, the page is wrong. Fix the page, never the test.
   If the code is wrong, stop and say so: that is a bug fix, not a docs change.
5. Update `docs/CHANGELOG.md` and `docs/STATUS.md`. List every command you checked, and the file where you found it.
