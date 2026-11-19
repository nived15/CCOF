// Invariant register checks (BUILD-PLAN P1, ADR-0056): harness/invariants.json matches the invariants in
// .github/copilot-instructions.md, every cited file exists, every protecting test is one a suite runs, and the
// list of known gaps can only shrink.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

// Lower this when a gap closes. Raising it needs the explicit approval rule 4 of the instructions file asks for.
const KNOWN_GAPS_CEILING = 8;

type Invariant = {
  id: string; category: string; statement: string; status: string;
  sources: string[]; protectedBy: string[]; coverage: string; evidence: string;
};
type Register = { version: number; invariants: Invariant[]; knownGaps: { id: string; reason: string }[] };

const register = JSON.parse(read("harness/invariants.json")) as Register;
const ids = register.invariants.map((i) => i.id);

// Files that `npm test`, `npm --prefix admin test` or `npm --prefix client test` actually run.
const runByASuite = (p: string) =>
  /^tests\/[^/]+\.test\.ts$/.test(p) || /^tests\/[^/]+\.ps1$/.test(p) ||
  /^admin\/tests\/[^/]+\.test\.ts$/.test(p) || /^client\/test\/[^/]+\.test\.mjs$/.test(p);

test("every invariant ID is unique", () => {
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, []);
});

test("the register holds exactly the invariants of the instructions file", () => {
  const section = read(".github/copilot-instructions.md").split("## Invariants")[1]?.split("\n## ")[0] ?? "";
  const listed = [...section.matchAll(/^- \*\*([A-Z]+-\d{2})\*\*/gm)].map((m) => m[1]);
  assert.ok(listed.length > 0, "no invariants found in the instructions file");
  assert.deepEqual([...ids].sort(), [...listed].sort());
});

test("every entry is complete and its category matches its ID", () => {
  for (const inv of register.invariants) {
    assert.equal(inv.category, inv.id.split("-")[0], `${inv.id}: category`);
    assert.ok(["verified", "unverified"].includes(inv.status), `${inv.id}: status ${inv.status}`);
    assert.ok(["full", "partial", "none"].includes(inv.coverage), `${inv.id}: coverage ${inv.coverage}`);
    assert.ok(inv.statement.trim() && inv.evidence.trim(), `${inv.id}: statement and evidence are required`);
    assert.ok(inv.sources.length > 0, `${inv.id}: at least one source`);
  }
});

test("every source and protecting test exists", () => {
  const missing = register.invariants.flatMap((inv) =>
    [...inv.sources, ...inv.protectedBy].filter((p) => !existsSync(path.join(root, p))).map((p) => `${inv.id}: ${p}`));
  assert.deepEqual(missing, []);
});

test("every protecting test is one a test suite runs", () => {
  const stray = register.invariants.flatMap((inv) =>
    inv.protectedBy.filter((p) => !runByASuite(p)).map((p) => `${inv.id}: ${p}`));
  assert.deepEqual(stray, []);
});

test("coverage agrees with protectedBy: none means no test, full or partial means at least one", () => {
  for (const inv of register.invariants) {
    assert.equal(inv.coverage === "none", inv.protectedBy.length === 0, `${inv.id}: coverage ${inv.coverage}`);
  }
});

test("every gap is listed in knownGaps, and knownGaps lists only gaps", () => {
  const gaps = register.invariants.filter((i) => i.coverage !== "full").map((i) => i.id).sort();
  const listed = register.knownGaps.map((g) => g.id).sort();
  assert.deepEqual(listed, gaps);
  for (const g of register.knownGaps) assert.ok(g.reason.trim(), `${g.id}: a gap needs a reason`);
});

test("knownGaps can only shrink", () => {
  const count = register.knownGaps.length;
  assert.ok(count <= KNOWN_GAPS_CEILING, `knownGaps grew to ${count}, above the committed ceiling ${KNOWN_GAPS_CEILING}`);
  assert.equal(count, KNOWN_GAPS_CEILING,
    `knownGaps shrank to ${count}: lower KNOWN_GAPS_CEILING in this file to ${count} so it cannot grow back`);
});
