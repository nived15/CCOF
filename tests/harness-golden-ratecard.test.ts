// Rate card append-only check (BUILD-PLAN P4; MON-03): compared with tests/golden/rate-card-entries.json, an entry of
// config/rate-card.json may only be closed (effectiveTo set once, from null to a time at or after effectiveFrom);
// it is never edited or removed. A price change adds a new entry (instructions rule 5).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readGoldenJson, updating } from "./helpers/golden.ts";

type Entry = Record<string, unknown> & { model: string; effectiveFrom: string; effectiveTo: string | null };
const root = path.resolve(import.meta.dirname, "..");
const entries = () => (JSON.parse(readFileSync(path.join(root, "config", "rate-card.json"), "utf8")) as { entries: Entry[] }).entries;
const key = (e: Entry) => `${e.model}@${e.effectiveFrom}`;

function appendOnlyProblems(before: Entry[], after: Entry[]): string[] {
  const now = new Map(after.map((e) => [key(e), e]));
  const problems: string[] = [];
  for (const was of before) {
    const is = now.get(key(was));
    if (!is) { problems.push(`entry removed or its model/effectiveFrom edited: ${key(was)}`); continue; }
    const { effectiveTo: toWas, ...restWas } = was;
    const { effectiveTo: toNow, ...restNow } = is;
    if (JSON.stringify(restWas) !== JSON.stringify(restNow)) problems.push(`entry edited in place: ${key(was)}`);
    if (toWas !== null && toWas !== toNow) problems.push(`closed entry's effectiveTo changed: ${key(was)}`);
    if (toWas === null && toNow !== null && !(Date.parse(toNow) >= Date.parse(was.effectiveFrom))) problems.push(`entry closed before it began: ${key(was)}`);
  }
  return problems;
}

test("MON-03: the rate card only gains entries or closes them (compared with the golden)", () => {
  const now = entries();
  const golden = readGoldenJson<Entry[]>("rate-card-entries.json", updating ? now : undefined);
  assert.deepEqual(appendOnlyProblems(golden, now), []);
});

test("the comparison catches an edited price, a removed entry and a reopened or back-dated close", () => {
  const base = entries();
  const copy = () => JSON.parse(JSON.stringify(base)) as Entry[];
  const edited = copy(); (edited[0].promptTiers as { rates: Record<string, string> }[])[0].rates.input = "0.01";
  const removed = copy().slice(1);
  const closed = copy(); closed[0].effectiveTo = "2027-01-01T00:00:00Z";
  const reopened = closed.map((e) => ({ ...e })); reopened[0].effectiveTo = "2027-02-01T00:00:00Z";
  const backDated = copy(); backDated[0].effectiveTo = "2000-01-01T00:00:00Z";
  const appended = [...copy(), { ...copy()[0], effectiveFrom: "2027-01-01T00:00:00Z" }];
  assert.match(appendOnlyProblems(base, edited).join(), /edited in place/);
  assert.match(appendOnlyProblems(base, removed).join(), /entry removed/);
  assert.match(appendOnlyProblems(closed, reopened).join(), /effectiveTo changed/);
  assert.match(appendOnlyProblems(base, backDated).join(), /closed before it began/);
  assert.deepEqual(appendOnlyProblems(base, closed), [], "closing an open entry is allowed");
  assert.deepEqual(appendOnlyProblems(base, appended), [], "adding an entry is allowed");
});
