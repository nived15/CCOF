// BUILD-PLAN P7: the mutation sentinel register stays runnable. Every mutant's original string must still occur
// exactly once in its file, so a code change that moves a guarded line shows up here, not as a silent skip
// in the nightly run. The mutants themselves run in harness/run-mutants.mjs (docs/harness/MUTANTS.md).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyMutant, expandSuites, loadMutants, summarize } from "../harness/run-mutants.mjs";
import { rulesFor } from "../harness/classify-change.mjs";

const root = path.resolve(import.meta.dirname, "..");
const doc = loadMutants(path.join(root, "harness", "mutants.json"));
const register = JSON.parse(readFileSync(path.join(root, "harness", "invariants.json"), "utf8")) as { invariants: { id: string }[] };
const tiers = JSON.parse(readFileSync(path.join(root, "harness", "tiers.json"), "utf8"));

test("every mutant is well formed, names a register invariant and an area with suites", () => {
  const ids = new Set<string>();
  const invariants = new Set(register.invariants.map((i) => i.id));
  assert.ok(doc.mutants.length >= 30, `expected at least 30 mutants, found ${doc.mutants.length}`);
  for (const m of doc.mutants) {
    assert.match(m.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, m.id);
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
    ids.add(m.id);
    assert.ok(invariants.has(m.invariant), `${m.id}: unknown invariant ${m.invariant}`);
    assert.ok(Array.isArray(doc.suites[m.area]), `${m.id}: unknown area ${m.area}`);
    assert.ok(m.description.trim().length > 0, `${m.id}: description`);
    if (m.equivalentReason !== undefined) assert.ok(m.equivalentReason.trim().length > 20, `${m.id}: equivalentReason must explain`);
  }
});

test("every mutant targets a deployed-behaviour module (T3, or T2 for the contracts area)", () => {
  for (const m of doc.mutants) {
    const tierOf = rulesFor(m.file, tiers).map((r) => r.tier);
    const allowed = m.area === "contracts" ? ["T2", "T3"] : ["T3"];
    assert.ok(tierOf.some((t) => allowed.includes(t)), `${m.id}: ${m.file} is ${tierOf.join(",") || "unclassified"}`);
  }
});

test("every mutant's original occurs exactly once in the current source", () => {
  for (const m of doc.mutants) {
    const text = readFileSync(path.join(root, m.file), "utf8");
    assert.doesNotThrow(() => applyMutant(text, m), `${m.id} is stale: update harness/mutants.json with the guarded line's new text`);
  }
});

test("the SEC, MON and SYNC invariants with runtime code each have a mutant", () => {
  const covered = new Set(doc.mutants.map((m) => m.invariant));
  for (const id of ["SEC-01", "SEC-02", "SEC-03", "SEC-04", "SEC-05", "SEC-07", "MON-01", "MON-02", "MON-03", "MON-04", "MON-05", "MON-06", "SYNC-01", "SYNC-02", "SYNC-03", "SYNC-04", "DATA-01"]) {
    assert.ok(covered.has(id), `no mutant attacks ${id}`);
  }
});

test("suites never include golden or digest tests, which would catch every edit for the wrong reason", () => {
  for (const [area, patterns] of Object.entries(doc.suites)) {
    const files = expandSuites(root, patterns, doc.excludedSuites);
    assert.ok(files.length > 0, `${area} has no suites`);
    assert.ok(files.every((f) => !/harness-golden-|harness-version-skew/.test(f)), `${area}: ${files.join(", ")}`);
  }
});

test("applyMutant replaces exactly one occurrence and keeps CRLF files CRLF", () => {
  const m = { id: "t", file: "f", original: "a\nb", replacement: "a\nc" };
  assert.equal(applyMutant("x\r\na\r\nb\r\ny", m), "x\r\na\r\nc\r\ny");
  assert.equal(applyMutant("a\nb", m), "a\nc");
  assert.throws(() => applyMutant("zzz", m), /found 0 times/);
  assert.throws(() => applyMutant("a\nb a\nb", m), /found 2 times/);
  assert.throws(() => applyMutant("q", { id: "t", file: "f", original: "q", replacement: "q" }), /equals original/);
});

test("summarize fails on a survivor and on an equivalent mutant that was killed", () => {
  const ok = summarize([{ id: "a", status: "killed", equivalent: false }, { id: "b", status: "survived", equivalent: true }]);
  assert.deepEqual([ok.pass, ok.equivalent], [true, ["b"]]);
  assert.deepEqual(summarize([{ id: "a", status: "survived", equivalent: false }]).survived, ["a"]);
  assert.equal(summarize([{ id: "a", status: "survived", equivalent: false }]).pass, false);
  assert.deepEqual(summarize([{ id: "b", status: "killed", equivalent: true }]).equivalentKilled, ["b"]);
});
