# Harness baseline (P0)

Packet P0 of [BUILD-PLAN.md](BUILD-PLAN.md). No code was changed. Every number below comes from a
command that was run on 2026-11-19, three times in a row, at commit `b4ccd38` on branch `harness/p0`,
with `CCOF_LIVE_TESTS=0` and `CCOF_LIVE_SMOKE=0`. Nothing called Azure or a model.

## Machine

| Tool | Version |
| --- | --- |
| OS | Windows |
| Node.js | v26.13.0 (the instructions file asks for 22; CI runs both 22 and 26) |
| npm | 11.20.0 |
| PowerShell | 7.7.0 |
| Python | 3.12.10 (`python`); `python3` resolves to the Windows Store stub, see K-5 |
| .NET SDK | 10.0.404 |
| Azure CLI | 2.93.0, Bicep 0.46.1 |

Dependencies were installed with `npm ci --ignore-scripts --no-audit --no-fund` in the root, `admin/` and `client/`.

## Results

| Check | Command | Run 1 | Run 2 | Run 3 | Exit |
| --- | --- | --- | --- | --- | --- |
| Full suite | `npm test` | 339.0 s | 311.4 s | 312.4 s | 1, 1, 1 |
| Typecheck | `npx tsc -p tsconfig.typecheck.json` | 2.0 s | 1.6 s | 1.5 s | 0, 0, 0 |
| Build | `npx tsc -p tsconfig.json` | 1.9 s | 1.7 s | 1.8 s | 0, 0, 0 |
| Admin tests | `npm test` in `admin/` | 4.1 s | 2.6 s | 2.6 s | 0, 0, 0 |
| Client tests | `npm test` in `client/` | 6.7 s | 6.6 s | 6.5 s | 0, 0, 0 |
| Gate | `node .ironclad/gate.mjs --stage packet --no-run` | 1.4 s | 1.4 s | 1.4 s | 0, 0, 0 |

Counts were identical in all three runs:

| Check | Tests | Pass | Fail | Skip |
| --- | --- | --- | --- | --- |
| `npm test`, Node suites (`tests/*.test.ts`) | 1353 | 1347 | 0 | 6 |
| `npm test`, PowerShell suites (46 `tests/*.ps1` files) | 620 assertions | 619 | 1 | 0 |
| Admin (`admin/tests/*.test.ts`) | 220 | 220 | 0 | 0 |
| Client (`client/test/*.test.mjs`) | 80 | 79 | 0 | 1 |
| Gate (`--no-run`) | 26 checks | 20 | 0 | 4 (2 warned) |

PowerShell suites have no common reporter, so their count is the number of `PASS`/`FAIL` lines in the
output. Not every suite prints one line per assertion; treat 620 as a floor, not an exact test count.

### The one failure

`tests/Test-QuickstartSeed.ps1`: "the fake run produced a result output". The suite picks the first of
`python3`, `python` that `Get-Command` finds (line 40). On this machine `python3` is the Windows Store
App execution alias, which prints "Python was not found" instead of running. This is an environment
problem, not a code defect; it is recorded as K-5 and left unfixed in this packet. Turning off the
`python3.exe` alias (Settings > Apps > Advanced app settings > App execution aliases) is the local workaround.

### Skips (expected)

- Node, six tests: the live Azure tests, skipped because `CCOF_LIVE_TESTS` is not `1`.
- Client, one test: "off Windows the sh helper gives the token" (`# SKIP sh helper`), Windows only.
- Gate, four checks: `tests.run`, `quality.typecheck` and `quality.build` (because of `--no-run`) and
  `quality.lint` (no lint command in the charter).

### Gate warnings

- `quality.filesize`: six files over budget: `admin/ui/app.js` (1002 lines), `infra/quickstart/Deploy-Quickstart.ps1` (868),
  `tests/Test-StagedStages.ps1` (816 of 800), `admin/ui/v2.jsx` (774), `infra/staged/Staged.Resources.ps1` (609),
  `infra/staged/Staged.Common.ps1` (563).
- `unknowns.open`: three OPEN unknowns in `docs/UNKNOWNS.md`: G-R3, E2E-01, CC-01.

### Flaky tests

None. For each run, every failing and skipped test name was collected, and each PowerShell suite's
`PASS`/`FAIL` count was compared. All three runs matched exactly.

## Known issues

| ID | Issue | Status |
| --- | --- | --- |
| K-1 | `scripts/Test-LiveSmoke.ps1` dot-sources `scripts/Get-E2ETestToken.ps1` (line 58) and defaults to `infra/poc/live-test.config.json` (line 46); neither file exists. | Confirmed; **fixed in L0** (2026-11-19): `-NoToken` no longer needs the token script; see `docs/harness/LIVE.md` |
| K-2 | High-severity dependency findings (`docs/ROADMAP.md`, G-DEPENDENCY-AUDIT). | **Corrected**: `npm audit` reports 2 high in the root (`@azure/identity`, direct; `@azure/msal-node`, transitive), the same 2 in `admin/`, and **1 high in `client/`** (`@azure/msal-node`, direct). A fix is available for each; applying it changes lockfiles, so it needs approval. The first `npm audit` attempt was refused by the registry's rate limit; the second succeeded. |
| K-3 | Two ADRs share number 0048: `0048-claude-code-setup-on-macos-and-linux.md` and `0048-request-checks-and-backend-refusals.md`. | Confirmed |
| K-4 | Streamed prompt-cache tokens are not recorded, so live spend is a lower bound (`docs/UNKNOWNS.md` REH-3, ADR-0038). | Confirmed (documented; no test changed) |
| K-5 | `tests/Test-QuickstartSeed.ps1` fails on Windows machines where `python3` is the Store alias, because it prefers `python3` over a working `python`. | New |
| K-6 | The local machine runs Node 26, not the Node 22 the instructions require. CI covers both. | New, environment |

## Verdict

Green apart from known issues: the only failure is K-5 (environment), stable across three runs, with no flaky tests.
