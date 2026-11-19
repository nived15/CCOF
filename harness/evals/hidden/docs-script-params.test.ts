// Eval hidden test (docs-drift tasks, harness/evals/tasks/drift-*.json). Every documented invocation of a deployment
// script uses only parameters the script declares (DOC-01). Parameters are read from PowerShell itself
// (Get-Command), so the check follows the script, not a copy of its param block.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPTS = ["infra/staged/Invoke-StagedDeployment.ps1", "infra/gateway/Deploy-GatewayRevision.ps1"];

function declared(script: string): Set<string> {
  const out = execFileSync("pwsh", ["-NoProfile", "-Command", `(Get-Command '${path.join(root, script)}').Parameters.Keys -join ' '`], { encoding: "utf8" });
  return new Set(out.trim().split(/\s+/).map((p) => p.toLowerCase()));
}

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? markdown(full) : name.endsWith(".md") ? [full] : [];
  });
}

test("every documented invocation of a deployment script uses only its declared parameters", () => {
  const pages = [...markdown(path.join(root, "docs")), path.join(root, "README.md")];
  const problems: string[] = [];
  for (const script of SCRIPTS) {
    const name = path.basename(script);
    const params = declared(script);
    for (const page of pages) {
      readFileSync(page, "utf8").split(/\r?\n/).forEach((line, i) => {
        const at = line.indexOf(name);
        if (at < 0) return;
        // The invocation runs to the end of the line, or to the closing backtick of inline code.
        const rest = line.slice(at + name.length).split("`")[0];
        for (const [, p] of rest.matchAll(/(?:^|\s)-([A-Za-z][A-Za-z0-9]*)\b/g)) {
          if (!params.has(p.toLowerCase())) problems.push(`${path.relative(root, page)}:${i + 1}: ${name} has no -${p}`);
        }
      });
    }
  }
  assert.deepEqual(problems, []);
});
