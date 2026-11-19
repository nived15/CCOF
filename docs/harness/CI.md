# Continuous integration for the harness (P8)

Three workflows guard `main`. None of them has Azure credentials or secrets, and all are read-only (`contents: read`,
`persist-credentials: false`). Live tests stay off (`CCOF_LIVE_TESTS=0`). `tests/harness-workflows.test.ts` and
`tests/public-ci-workflow.test.ts` keep it that way.

| Workflow | When | What |
| --- | --- | --- |
| `public-ci.yml` (`public-source-ci`) | every push and pull request | the full `npm test`, typecheck, build and every Bicep template on Node 22 and 26 |
| `harness.yml`, job **Harness tier checks** | every pull request | `node harness/run-checks.mjs --base origin/<base>`: classifies the change and runs every check its tier requires |
| `harness.yml`, jobs **Mutation sentinels** and **Dependency audit** | nightly 02:00 IST, or by hand (`workflow_dispatch`) | `node harness/run-mutants.mjs` (report kept as the `mutants-report` artifact), and `npm audit --audit-level=high` on the root, admin and client lockfiles |
| `copilot-setup-steps.yml` | before every Copilot cloud agent session; on changes to itself | installs Node 22, .NET 10, Bicep v0.46.1 and the root, admin and client packages on Ubuntu |

## Run the PR checks locally

```powershell
node harness/run-checks.mjs --base main --dry-run   # the tier and the checks it requires
node harness/run-checks.mjs --base main             # run them; exit 1 if any fails
```

The checks come from `harness/tiers.json` (see `docs/harness/BUILD-PLAN.md` P2). Each distinct command runs once.
Manual checks (human review and the live lab for T3) are only listed in the job summary. A file that no tier rule
covers, or that two rules cover, fails the run.

## Notes

- **Copilot runs on Ubuntu.** The Copilot cloud agent's firewall does not support Windows runners
  ([GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)),
  so the agent gets Ubuntu. Node suites, typecheck and Bicep builds run there. Some PowerShell suites assume Windows
  (`docs/STATUS.md`), so they run in `public-source-ci` and the harness job on every pull request.
- **The nightly audit fails on high advisories.** Known issue K-2 (`docs/harness/BASELINE.md`) records high advisories
  in the root and client lockfiles, so the audit job fails until they are fixed or accepted. That is the intended
  signal.
- `copilot-setup-steps.yml` runs only once it is on `main`.

## Human checkpoint (Copilot must not do this)

In **Settings → Branches → Branch protection rules → `main`**, require these status checks:

- `Public source (Node 22)`
- `Public source (Node 26)`
- `Harness tier checks`

Mutation sentinels and the dependency audit run nightly, not on pull requests, so they are not required checks. Watch
their runs on the Actions tab.
