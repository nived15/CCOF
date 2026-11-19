// Risk tiers and the change classifier (BUILD-PLAN P2, ADR-0056): every tracked file matches exactly one rule in
// harness/tiers.json, sample paths get the expected tier, and a mixed change takes the highest tier.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "harness", "classify-change.mjs");

type Result = {
  tier: string | null;
  files: { file: string; rules: string[]; tier: string | null }[];
  unmatched: string[];
  ambiguous: { file: string; rules: string[] }[];
  invariants: { id: string; viaSource: string[]; viaTest: string[] }[];
  checks: { required: { tier: string; id: string; run: string }[]; pending: { id: string }[]; manual: { id: string }[] };
};

function classify(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [cli, "--json", ...args], { cwd: root, encoding: "utf8", input });
  return { status: r.status, result: JSON.parse(r.stdout) as Result, stderr: r.stderr };
}
const files = (...f: string[]) => classify(["--files", ...f]);

test("every tracked file matches exactly one rule", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  const { status, result } = classify(["--stdin"], tracked);
  assert.deepEqual(result.unmatched, [], "files with no rule");
  assert.deepEqual(result.ambiguous, [], "files with more than one rule");
  assert.equal(status, 0);
  assert.ok(result.files.length > 1000, `expected the whole repository, got ${result.files.length} files`);
});

test("sample paths get the expected tier", () => {
  const expected: Record<string, string> = {
    "docs/harness/BUILD-PLAN.md": "T0",
    "README.md": "T0",
    "docs/adr/0056-regression-harness-and-eval-suite.md": "T0",
    "tests/resolver-decide.test.ts": "T1",
    "tests/Test-StagedStages.ps1": "T1",
    "admin/ui-v3/src/main.tsx": "T1",
    "scripts/load/mock.mjs": "T1",
    "harness/invariants.json": "T1",
    "src/contracts/model-families.ts": "T2",
    "config/rate-card.json": "T2",
    "admin/openapi.yaml": "T2",
    "analytics/ledger.kql": "T2",
    "client/src/config.mjs": "T2",
    ".github/workflows/public-ci.yml": "T2",
    "package-lock.json": "T2",
    "infra/gateway/policy/claude-messages.template.xml": "T3",
    "infra/gateway/policy/README.md": "T3",
    "src/resolver/decide.ts": "T3",
    "src/reconciler/run.ts": "T3",
    "src/sync/plan.ts": "T3",
    "src/cost/money.ts": "T3",
    "infra/staged/stage1.bicep": "T3",
    "admin/src/index.ts": "T3",
    "scripts/Stage3-RegisterProject.ps1": "T3",
  };
  const { result } = files(...Object.keys(expected));
  const got = Object.fromEntries(result.files.map((f) => [f.file, f.tier]));
  assert.deepEqual(got, expected);
});

test("a mixed change takes the highest tier and the checks of every tier up to it", () => {
  const { result } = files("docs/STATUS.md", "tests/sync-plan.test.ts", "config/rate-card.json", "src/reconciler/reconcile-person.ts");
  assert.equal(result.tier, "T3");
  const tiersWithChecks = new Set(result.checks.required.map((c) => c.tier));
  assert.deepEqual([...tiersWithChecks].sort(), ["T0", "T1", "T2", "T3"]);
  assert.ok(result.checks.manual.some((c) => c.id === "live-lab"), "T3 needs the live lab check");

  const docsOnly = files("docs/STATUS.md").result;
  assert.equal(docsOnly.tier, "T0");
  assert.ok(docsOnly.checks.required.every((c) => c.tier === "T0"));
  assert.equal(files("docs/STATUS.md", "tests/sync-plan.test.ts").result.tier, "T1");
  assert.equal(files("docs/STATUS.md", "config/model-families.json").result.tier, "T2");
});

test("touched invariants are found through their sources and their protecting tests", () => {
  const { result } = files("src/reconciler/reconcile-person.ts", "tests/sync-plan-safety.test.ts");
  const ids = result.invariants.map((i) => i.id).sort();
  assert.ok(ids.includes("MON-05"), "a source of MON-05 changed");
  assert.ok(["SYNC-01", "SYNC-02", "SYNC-03"].every((id) => ids.includes(id)), "a protecting test of SYNC-01..03 changed");
  const runs = result.checks.required.map((c) => c.run);
  assert.ok(runs.includes("node --test tests/reconciler-reconcile-person.test.ts"), "MON-05's protecting tests run");
  assert.ok(runs.includes("node --test tests/sync-plan-safety.test.ts"), "the changed test runs");
});

test("a file no rule covers is reported and fails the run", () => {
  const { status, result } = files("unknown-area/thing.txt");
  assert.equal(status, 2);
  assert.deepEqual(result.unmatched, ["unknown-area/thing.txt"]);
});

test("Windows separators are normalised before matching", () => {
  assert.equal(files("src\\resolver\\decide.ts").result.tier, "T3");
});

test("git mode with no committed change since the base classifies nothing", () => {
  const { status, result } = classify(["--base", "HEAD", "--committed-only"]);
  assert.equal(status, 0);
  assert.equal(result.tier, null);
  assert.deepEqual(result.files, []);
});

test("every rule names a defined tier and rule IDs are unique", () => {
  const tiers = JSON.parse(readFileSync(path.join(root, "harness", "tiers.json"), "utf8")) as {
    tiers: Record<string, unknown>; rules: { id: string; tier: string }[];
  };
  const ids = tiers.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of tiers.rules) assert.ok(r.tier in tiers.tiers, `${r.id}: unknown tier ${r.tier}`);
});
