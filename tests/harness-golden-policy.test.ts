// Gateway policy golden (BUILD-PLAN P4; DEP-06, DATA-01, DATA-02): the policy the current code renders for the
// customer fixture (harness/golden/Render-CustomerPolicy.ps1), compared with tests/golden/policy/. Any change to the
// deployed policy shows up here as a reviewed golden change before it reaches a new APIM revision.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { normalizeGoldenText, readGolden, updating } from "./helpers/golden.ts";

const root = path.resolve(import.meta.dirname, "..");
let out: string;

before(() => {
  out = mkdtempSync(path.join(os.tmpdir(), "ccof-golden-policy-"));
  const r = spawnSync("pwsh", ["-NoProfile", "-File", path.join(root, "harness", "golden", "Render-CustomerPolicy.ps1"), "-OutDir", out], { encoding: "utf8" });
  assert.equal(r.status, 0, `render failed:\n${r.stdout}\n${r.stderr}`);
});
after(() => rmSync(out, { recursive: true, force: true }));

const rendered = (name: string) => normalizeGoldenText(readFileSync(path.join(out, "gateway", name), "utf8"));

// The first differing line with a little context, instead of a 100 KB assertion message.
function firstDifference(golden: string, actual: string): string {
  const g = golden.split("\n"), a = actual.split("\n");
  const i = g.findIndex((line, n) => line !== a[n]);
  const at = i < 0 ? Math.min(g.length, a.length) : i;
  const show = (lines: string[]) => lines.slice(Math.max(0, at - 2), at + 3).map((l, k) => `${Math.max(0, at - 2) + k + 1}: ${l.slice(0, 200)}`).join("\n");
  return `first difference at line ${at + 1}\n--- golden\n${show(g)}\n--- rendered\n${show(a)}`;
}

for (const name of ["claude-messages.policy.xml", "claude-messages.usage.policy.xml"]) {
  test(`${name} matches the golden`, () => {
    const actual = rendered(name);
    const golden = readGolden(`policy/${name}`, updating ? actual : undefined);
    assert.ok(golden === actual, firstDifference(golden, actual));
  });
}

test("the render digests and fragment IDs match the golden", () => {
  const manifest = JSON.parse(readFileSync(path.join(out, "gateway", "render.json"), "utf8"));
  const deployment = JSON.parse(readFileSync(path.join(out, "gateway", "claude-messages.policy.deployment.json"), "utf8"));
  const summary = {
    configurationId: manifest.configurationId, apiId: manifest.apiId,
    configSha256: manifest.configSha256, templateSha256: manifest.templateSha256, policySha256: manifest.policySha256,
    usageTemplateSha256: manifest.usageTemplateSha256, usagePolicySha256: manifest.usagePolicySha256,
    fragments: deployment.fragments.map((f: { id: string }) => f.id),
  };
  const actual = `${JSON.stringify(summary, null, 2)}\n`;
  assert.deepEqual(JSON.parse(readGolden("policy/render.json", updating ? actual : undefined)), summary);
});

test("the harness builds the gateway configuration with Stage 5's own statements", () => {
  const script = readFileSync(path.join(root, "harness", "golden", "Render-CustomerPolicy.ps1"), "utf8").replace(/\r\n/g, "\n");
  const stage5 = readFileSync(path.join(root, "infra", "staged", "Staged.Application.ps1"), "utf8").replace(/\r\n/g, "\n");
  const body = stage5.slice(stage5.indexOf("function Invoke-Stage5"), stage5.indexOf("\nfunction ", stage5.indexOf("function Invoke-Stage5") + 1));
  const block = script.slice(script.indexOf("# BEGIN Stage 5 gateway config"), script.indexOf("# END Stage 5 gateway config")).split("\n").slice(1);
  const statements = block.map((l) => l.trim()).filter(Boolean);
  assert.equal(statements.length, 3);
  for (const s of statements) assert.ok(body.includes(s), `Invoke-Stage5 no longer contains: ${s}\nupdate harness/golden/Render-CustomerPolicy.ps1 to match`);
});
