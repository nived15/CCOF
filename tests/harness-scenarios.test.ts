// Scenario evals (BUILD-PLAN P6): every tests/scenarios/*.json runs through the real code (tests/helpers/
// scenario-engine.ts) and its observed outcome must equal its `then`. Every SEC, MON and SYNC invariant has at least
// one executed scenario. `live-only` scenarios record evidence that cannot run offline; they are listed, not run.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { runGateway, runLedger, runPricing, runReconciler, runReconcilerRun, runSync, type Scenario } from "./helpers/scenario-engine.ts";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "tests", "scenarios");
const scenarios = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Scenario) }));
const register = JSON.parse(readFileSync(path.join(root, "harness", "invariants.json"), "utf8")) as { invariants: { id: string }[] };
const LAYERS = ["gateway", "reconciler", "pricing", "ledger", "sync", "reconciler-run", "live-only"];

type Obj = Record<string, any>;
const observed = new Map<string, Obj>();

before(async () => {
  const gateway = scenarios.filter((s) => s.layer === "gateway");
  (await runGateway(gateway)).forEach((o, i) => observed.set(gateway[i].id, o));
  for (const s of scenarios) {
    if (s.layer === "reconciler") observed.set(s.id, runReconciler(s));
    if (s.layer === "pricing") observed.set(s.id, runPricing(s));
    if (s.layer === "ledger") observed.set(s.id, runLedger(s));
    if (s.layer === "sync") observed.set(s.id, runSync(s));
    if (s.layer === "reconciler-run") observed.set(s.id, await runReconcilerRun(s));
  }
});

test("every scenario file is well formed: unique id equal to its file name, known layer, registered invariants", () => {
  const ids = new Set<string>();
  const known = new Set(register.invariants.map((i) => i.id));
  for (const s of scenarios) {
    assert.equal(s.file, `${s.id}.json`, s.file);
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`); ids.add(s.id);
    assert.ok(LAYERS.includes(s.layer), `${s.id}: layer ${s.layer}`);
    assert.ok(s.title && s.source && s.then && s.invariants.length, `${s.id}: title, source, invariants and then are required`);
    for (const inv of s.invariants) assert.ok(known.has(inv), `${s.id}: unknown invariant ${inv}`);
    if (s.layer === "live-only") assert.ok(s.then.evidence, `${s.id}: a live-only scenario records its evidence`);
  }
});

for (const s of scenarios.filter((x) => x.layer !== "live-only")) {
  test(`${s.id}: ${s.title}`, () => {
    const got = observed.get(s.id);
    assert.ok(got, `${s.id} did not run`);
    const { logsExclude, ...expected } = s.then;
    const actual = Object.fromEntries(Object.keys(expected).map((k) => [k, got[k]]));
    assert.deepEqual(actual, expected, `${s.id} (${s.source})`);
    for (const text of (logsExclude ?? []) as string[]) {
      assert.ok(!(got.logs as string[]).some((l) => l.includes(text)), `${s.id}: a log line carries "${text}"`);
    }
  });
}

test("every SEC, MON and SYNC invariant has at least one executed scenario", () => {
  const covered = new Set(scenarios.filter((s) => s.layer !== "live-only").flatMap((s) => s.invariants));
  const required = register.invariants.map((i) => i.id).filter((id) => /^(SEC|MON|SYNC)-/.test(id));
  assert.deepEqual(required.filter((id) => !covered.has(id)), []);
});
