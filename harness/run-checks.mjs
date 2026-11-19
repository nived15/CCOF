#!/usr/bin/env node
// Runs every check the change classifier requires for a change (BUILD-PLAN P8). Used by
// .github/workflows/harness.yml on pull requests, and the same way locally:
//
//   node harness/run-checks.mjs --base main            # classify and run the required checks
//   node harness/run-checks.mjs --base main --dry-run  # list them only
//
// The tier, invariants and each check's result go to stdout and, in GitHub Actions, to the job summary. Manual
// checks (human review, live lab) are listed for the reviewer, never run. Exit 1 when the classification fails
// (an unclassified or ambiguous file) or any check fails.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The distinct commands to run, in the classifier's order.
export function plannedRuns(classification) {
  const seen = new Set();
  const runs = [];
  for (const check of classification.checks.required) {
    if (seen.has(check.run)) continue;
    seen.add(check.run);
    runs.push({ id: check.id, tier: check.tier, run: check.run });
  }
  return runs;
}

export function summaryMarkdown(classification, results) {
  const lines = [`## Harness checks: tier ${classification.tier}`, ""];
  lines.push(`Invariants touched: ${classification.invariants.length ? classification.invariants.join(", ") : "none"}`, "");
  lines.push("| Check | Tier | Command | Result |", "| --- | --- | --- | --- |");
  for (const r of results) lines.push(`| ${r.id} | ${r.tier} | \`${r.run}\` | ${r.status === undefined ? "planned" : r.status === 0 ? "pass" : `FAIL (${r.status})`} |`);
  const manual = classification.checks.manual ?? [];
  if (manual.length) {
    lines.push("", "Manual checks for the reviewer:");
    for (const m of manual) lines.push(`- ${m.id} (${m.tier})${m.manual ? `: ${m.manual}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const opts = { base: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1]) opts.base = argv[(i += 1)];
    else if (argv[i] === "--dry-run") opts.dryRun = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!opts.base) throw new Error("--base <ref> is required");
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
  const classified = spawnSync(process.execPath, [path.join(root, "harness", "classify-change.mjs"), "--base", opts.base, "--json"], { cwd: root, encoding: "utf8" });
  if (!classified.stdout) {
    console.error(classified.stderr || "classification failed");
    return 1;
  }
  const classification = JSON.parse(classified.stdout);
  if (classified.status !== 0) {
    console.error(`classification failed: unmatched ${JSON.stringify(classification.unmatched)}, ambiguous ${JSON.stringify(classification.ambiguous)}`);
    return 1;
  }
  const results = plannedRuns(classification);
  console.log(`tier ${classification.tier}; ${results.length} checks`);
  if (!opts.dryRun) {
    for (const r of results) {
      console.log(`\n=== ${r.id}: ${r.run}`);
      r.status = spawnSync(r.run, { cwd: root, shell: true, stdio: "inherit", env: { ...process.env, CCOF_LIVE_TESTS: "0", CCOF_LIVE_SMOKE: "0" } }).status ?? 1;
    }
  }
  const summary = summaryMarkdown(classification, results);
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  return results.some((r) => r.status !== undefined && r.status !== 0) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
