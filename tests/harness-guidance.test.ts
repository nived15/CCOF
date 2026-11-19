// BUILD-PLAN P9: the per-area Copilot guidance stays true. Each area file applies to the paths the plan names and
// lists every invariant whose code lives there. Every invariant ID, repository path and test command the guidance
// or the prompts mention exists (DOC-01 for agent guidance).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { globToRegExp } from "../harness/classify-change.mjs";

const root = path.resolve(import.meta.dirname, "..");
const register = JSON.parse(readFileSync(path.join(root, "harness", "invariants.json"), "utf8")) as { invariants: { id: string; sources: string[] }[] };
const ids = new Set(register.invariants.map((i) => i.id));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

const AREAS: Record<string, string[]> = {
  gateway: ["infra/gateway/**"],
  money: ["src/reconciler/**", "src/cost/**", "config/rate-card.json"],
  staged: ["infra/staged/**", "**/*.bicep"],
  docs: ["docs/**"],
};
const PROMPTS = ["bugfix", "feature", "docs-change", "review"];
// Paths the guidance names on purpose because they are missing (recorded drift).
const KNOWN_MISSING = new Set(["infra/gateway/config/sample-pilot.json"]);

const guidance = [
  ...Object.keys(AREAS).map((a) => `.github/instructions/${a}.instructions.md`),
  ...PROMPTS.map((p) => `.github/prompts/${p}.prompt.md`),
].map((rel) => ({ rel, text: readFileSync(path.join(root, rel), "utf8") }));

function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(m, "front matter");
  return Object.fromEntries(m[1].split(/\r?\n/).map((l) => /^(\w+):\s*"?(.*?)"?$/.exec(l)!).map((x) => [x[1], x[2]]));
}

test("each area file applies to the paths BUILD-PLAN P9 names, and no other area file exists", () => {
  assert.deepEqual(readdirSync(path.join(root, ".github", "instructions")).sort(), Object.keys(AREAS).map((a) => `${a}.instructions.md`).sort());
  for (const [area, globs] of Object.entries(AREAS)) {
    const fm = frontMatter(guidance.find((g) => g.rel.includes(`/${area}.`))!.text);
    assert.deepEqual(fm.applyTo.split(","), globs, area);
  }
});

test("each area file names every invariant whose code lives in its paths", () => {
  for (const [area, globs] of Object.entries(AREAS)) {
    const text = guidance.find((g) => g.rel.includes(`/${area}.`))!.text;
    const res = globs.map(globToRegExp);
    // ADRs record decisions; the code they describe decides which area owns the invariant.
    const owned = register.invariants.filter((i) => i.sources.some((s) => !s.startsWith("docs/adr/") && res.some((r) => r.test(s)))).map((i) => i.id);
    assert.deepEqual(owned.filter((id) => !new RegExp(`\\b${id}\\b`).test(text)), [], `${area} misses invariants`);
  }
});

test("every invariant ID the guidance and prompts mention is in the register", () => {
  for (const { rel, text } of guidance) {
    for (const [id] of text.matchAll(/\b(?:SEC|MON|SYNC|DATA|OPS|DEP|CLI|DOC)-\d{2}\b/g)) assert.ok(ids.has(id), `${rel}: ${id}`);
  }
});

test("every repository path and test glob the guidance and prompts mention exists", () => {
  const pattern = /(?<![\w./-])((?:tests|harness|src|infra|config|docs|scripts|analytics|\.github)\/[A-Za-z0-9_.*/-]*[A-Za-z0-9_*/])/g;
  for (const { rel, text } of guidance) {
    for (const [, raw] of text.matchAll(pattern)) {
      if (KNOWN_MISSING.has(raw)) continue;
      const p = raw.replace(/\/$/, "");
      if (p.includes("*")) assert.ok(files.some((f) => globToRegExp(p).test(f)), `${rel}: ${raw} matches no file`);
      else assert.ok(existsSync(path.join(root, p)), `${rel}: ${raw} does not exist`);
    }
  }
  for (const missing of KNOWN_MISSING) assert.ok(!existsSync(path.join(root, missing)), `${missing} exists now: drop it from KNOWN_MISSING and fix the guidance`);
});

test("every prompt has a description, starts from the classifier, and only the review prompt is read-only", () => {
  assert.deepEqual(readdirSync(path.join(root, ".github", "prompts")).sort(), PROMPTS.map((p) => `${p}.prompt.md`).sort());
  for (const p of PROMPTS) {
    const { text } = guidance.find((g) => g.rel.endsWith(`/${p}.prompt.md`))!;
    const fm = frontMatter(text);
    assert.ok(fm.description?.length > 10, p);
    assert.equal(fm.mode, p === "review" ? "ask" : "agent", p);
    if (p !== "docs-change") assert.match(text, /node harness\/classify-change\.mjs/, p);
  }
});
