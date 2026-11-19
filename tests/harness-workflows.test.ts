// BUILD-PLAN P8: the harness and Copilot setup workflows stay safe and keep doing their jobs. Neither may reach Azure,
// read secrets, write to the repository or run live tests; the PR job must run the classifier's checks; the nightly
// jobs must run the mutants and the audit; the setup job must keep the name and limits the agent requires.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseYaml } from "../harness/lib/yaml-lite.mjs";
import { plannedRuns, summaryMarkdown } from "../harness/run-checks.mjs";

const root = path.resolve(import.meta.dirname, "..");
type Obj = Record<string, any>;
const read = (name: string) => readFileSync(path.join(root, ".github", "workflows", name), "utf8");
const workflows = ["harness.yml", "copilot-setup-steps.yml"].map((name) => ({ name, text: read(name), doc: parseYaml(read(name)) as Obj }));
const stepsOf = (job: Obj) => (job.steps as Obj[]);
const runText = (job: Obj) => stepsOf(job).map((s) => String(s.run ?? "")).join("\n");

test("both workflows are read-only and credential-free", () => {
  for (const { name, text, doc } of workflows) {
    assert.doesNotMatch(text, /azure\/login|secrets\.|id-token:\s*write|pull_request_target|continue-on-error|CCOF_LIVE_(TESTS|SMOKE): ['"]?1/, name);
    for (const [id, job] of Object.entries(doc.jobs as Record<string, Obj>)) {
      const permissions = job.permissions ?? doc.permissions;
      assert.deepEqual(permissions, { contents: "read" }, `${name} ${id}: permissions`);
      for (const step of stepsOf(job).filter((s) => String(s.uses ?? "").startsWith("actions/checkout"))) {
        assert.equal(step.with?.["persist-credentials"], false, `${name} ${id}: checkout keeps no credentials`);
      }
    }
  }
});

test("pull requests run the classifier's checks with full history and every package installed", () => {
  const doc = workflows[0].doc;
  assert.ok("pull_request" in doc.on && "schedule" in doc.on && "workflow_dispatch" in doc.on);
  assert.equal(doc.env.CCOF_LIVE_TESTS, "0");
  const job = doc.jobs["tier-checks"];
  assert.equal(job.if, "github.event_name == 'pull_request'");
  assert.equal(stepsOf(job)[0].with["fetch-depth"], 0);
  const run = runText(job);
  assert.match(run, /node harness\/run-checks\.mjs --base origin\/\$\{\{ github\.base_ref \}\}/);
  for (const prefix of ["npm ci", "npm --prefix admin ci", "npm --prefix client ci"]) assert.ok(run.includes(`${prefix} --ignore-scripts --no-audit --no-fund`), prefix);
  assert.match(run, /az bicep install --version v0\.46\.1/);
});

test("nightly runs the mutation sentinels and the dependency audit, never on pull requests", () => {
  const { jobs } = workflows[0].doc;
  for (const id of ["mutants", "dependency-audit"]) assert.equal(jobs[id].if, "github.event_name != 'pull_request'", id);
  assert.match(runText(jobs.mutants), /node harness\/run-mutants\.mjs --out mutants-report\.json/);
  assert.equal(jobs.mutants.steps[0].with["fetch-depth"], 0);
  const audit = runText(jobs["dependency-audit"]);
  assert.match(audit, /'\.', 'admin', 'client'/);
  assert.match(audit, /audit --package-lock-only --audit-level=high/);
});

test("the Copilot setup job has the required name, allowed settings and the repository's toolchain", () => {
  const doc = workflows[1].doc;
  assert.deepEqual(Object.keys(doc.jobs), ["copilot-setup-steps"]);
  const job = doc.jobs["copilot-setup-steps"];
  const allowed = new Set(["steps", "permissions", "runs-on", "services", "snapshot", "timeout-minutes"]);
  assert.deepEqual(Object.keys(job).filter((k) => !allowed.has(k)), []);
  assert.ok(job["timeout-minutes"] <= 59);
  assert.equal(job["runs-on"], "ubuntu-latest");
  const node = stepsOf(job).find((s) => String(s.uses).startsWith("actions/setup-node"));
  assert.equal(node?.with["node-version"], "22");
  assert.ok(stepsOf(job).some((s) => String(s.uses).startsWith("actions/setup-dotnet")));
  const run = runText(job);
  assert.match(run, /az bicep install --version v0\.46\.1/);
  assert.match(run, /\$PSVersionTable/);
  for (const prefix of ["npm ci", "npm --prefix admin ci", "npm --prefix client ci"]) assert.ok(run.includes(prefix), prefix);
  assert.match(run, /CCOF_LIVE_TESTS=0/);
});

test("run-checks runs each distinct required command once and reports failures and manual checks", () => {
  const classification = {
    tier: "T3", invariants: ["MON-05"],
    checks: {
      required: [{ id: "a", tier: "T1", run: "node --test x" }, { id: "b", tier: "T1", run: "node --test x" }, { id: "c", tier: "T2", run: "npm test" }],
      manual: [{ id: "human-review", tier: "T3", manual: "A human reviews the diff." }],
    },
  };
  const runs = plannedRuns(classification);
  assert.deepEqual(runs.map((r) => r.id), ["a", "c"]);
  const md = summaryMarkdown(classification, [{ ...runs[0], status: 0 }, { ...runs[1], status: 1 }]);
  assert.match(md, /tier T3/);
  assert.match(md, /MON-05/);
  assert.match(md, /\| a \| T1 \| `node --test x` \| pass \|/);
  assert.match(md, /\| c \| T2 \| `npm test` \| FAIL \(1\) \|/);
  assert.match(md, /human-review \(T3\): A human reviews the diff\./);
});
