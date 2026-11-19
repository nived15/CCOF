#!/usr/bin/env node
// Mutation sentinels (BUILD-PLAN P7, docs/harness/MUTANTS.md). Checks out a commit in a temporary git
// worktree, proves its suites pass unmutated, then applies each mutant from harness/mutants.json one at a time
// and runs only that mutant's area suites. A mutant is killed when a suite fails (or times out) and survives
// when every suite passes. The caller's working tree is never written: every edit is inside the worktree.
//
//   node harness/run-mutants.mjs [--ref HEAD] [--only id,id] [--area name] [--out report.json] [--timeout 600] [--list]
//
// Exit: 0 every non-equivalent mutant killed; 1 a non-equivalent mutant survived, or an equivalent one was
// killed (its recorded reason is wrong); 2 setup or baseline failure.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadMutants(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Applies one mutant to a file's text. The original must occur exactly once; a multi-line original written
// with \n also matches a CRLF file.
export function applyMutant(text, mutant) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const original = mutant.original.replace(/\r?\n/g, eol);
  const replacement = mutant.replacement.replace(/\r?\n/g, eol);
  const count = text.split(original).length - 1;
  if (count !== 1) throw new Error(`mutant ${mutant.id}: original found ${count} times in ${mutant.file} (expected 1)`);
  if (original === replacement) throw new Error(`mutant ${mutant.id}: replacement equals original`);
  const at = text.indexOf(original);
  return text.slice(0, at) + replacement + text.slice(at + original.length);
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
}

// The suite files for patterns such as "tests/resolver-*.test.ts", minus the excluded patterns, sorted.
export function expandSuites(root, patterns, excluded = []) {
  const out = new Set();
  const exclude = excluded.map(globToRegExp);
  for (const pattern of patterns) {
    const dir = path.posix.dirname(pattern);
    const re = globToRegExp(pattern);
    for (const name of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (re.test(rel) && !exclude.some((x) => x.test(rel))) out.add(rel);
    }
  }
  return [...out].sort();
}

// The verdict for a finished run: survivors fail it unless recorded as equivalent; an equivalent mutant that
// is killed fails it too, because its recorded reason no longer holds.
export function summarize(results) {
  const survived = results.filter((r) => r.status === "survived" && !r.equivalent).map((r) => r.id);
  const equivalentKilled = results.filter((r) => r.status === "killed" && r.equivalent).map((r) => r.id);
  return {
    total: results.length,
    killed: results.filter((r) => r.status === "killed").length,
    survived,
    equivalent: results.filter((r) => r.equivalent && r.status === "survived").map((r) => r.id),
    equivalentKilled,
    pass: survived.length === 0 && equivalentKilled.length === 0,
  };
}

function parseArgs(argv) {
  const args = { ref: "HEAD", only: null, area: null, out: null, timeout: 600, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (["--ref", "--only", "--area", "--out", "--timeout"].includes(a) && argv[i + 1] !== undefined) {
      const v = argv[(i += 1)];
      if (a === "--only") args.only = new Set(v.split(","));
      else if (a === "--timeout") args.timeout = Number(v);
      else args[a.slice(2)] = v;
    } else throw new Error(`unknown or incomplete argument: ${a}`);
  }
  return args;
}

function failingTests(tap) {
  return [...tap.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((n) => !n.endsWith(".test.ts")).slice(0, 5);
}

function runSuites(worktree, files, timeoutSeconds) {
  const scratch = path.join(worktree, ".env.public-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const started = Date.now();
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutSeconds * 1000,
    env: { ...process.env, CCOF_LIVE_TESTS: "0", CCOF_LIVE_SMOKE: "0", CCOF_UPDATE_GOLDEN: "0", TEMP: scratch, TMP: scratch },
  });
  const timedOut = r.error?.code === "ETIMEDOUT";
  return { passed: r.status === 0 && !timedOut, timedOut, seconds: Math.round((Date.now() - started) / 1000), failing: failingTests(r.stdout ?? "") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
  const doc = loadMutants(path.join(root, "harness", "mutants.json"));
  let mutants = doc.mutants;
  if (args.only) mutants = mutants.filter((m) => args.only.has(m.id));
  if (args.area) mutants = mutants.filter((m) => m.area === args.area);
  if (mutants.length === 0) throw new Error("no mutants selected");
  if (args.list) {
    for (const m of mutants) console.log(`${m.id}\t${m.invariant}\t${m.area}\t${m.file}`);
    return 0;
  }

  const sha = execFileSync("git", ["rev-parse", args.ref], { cwd: root, encoding: "utf8" }).trim();
  const worktree = mkdtempSync(path.join(os.tmpdir(), "ccof-mutants-"));
  rmSync(worktree, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "--detach", worktree, sha], { cwd: root, stdio: "ignore" });
  const results = [];
  try {
    symlinkSync(path.join(root, "node_modules"), path.join(worktree, "node_modules"), "junction");
    const suitesOf = (area) => {
      const patterns = doc.suites[area];
      if (!patterns) throw new Error(`unknown area: ${area}`);
      return expandSuites(worktree, patterns, doc.excludedSuites);
    };
    // Every mutant's original must be present before anything runs.
    for (const m of mutants) applyMutant(readFileSync(path.join(worktree, m.file), "utf8"), m);

    const baselineFiles = [...new Set(mutants.flatMap((m) => suitesOf(m.area)))].sort();
    console.error(`baseline at ${sha.slice(0, 7)}: ${baselineFiles.length} suites`);
    const baseline = runSuites(worktree, baselineFiles, args.timeout);
    if (!baseline.passed) {
      console.error(`baseline failed (${baseline.timedOut ? "timeout" : baseline.failing.join("; ")}); no mutant can be classified`);
      return 2;
    }

    for (const m of mutants) {
      const target = path.join(worktree, m.file);
      const original = readFileSync(target, "utf8");
      writeFileSync(target, applyMutant(original, m));
      let run;
      try {
        run = runSuites(worktree, suitesOf(m.area), args.timeout);
      } finally {
        writeFileSync(target, original);
      }
      const status = run.passed ? "survived" : "killed";
      const equivalent = typeof m.equivalentReason === "string";
      results.push({ id: m.id, invariant: m.invariant, area: m.area, status, timedOut: run.timedOut, seconds: run.seconds, killedBy: run.failing, equivalent });
      console.error(`${status.padEnd(8)} ${m.id} (${m.invariant}, ${run.seconds}s)${run.failing.length ? ` <- ${run.failing[0]}` : ""}`);
    }
  } finally {
    const link = path.join(worktree, "node_modules");
    if (existsSync(link)) rmSync(link, { force: true, recursive: false });
    execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" });
  }

  const summary = summarize(results);
  const report = { schemaVersion: 1, commit: sha, summary, results };
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  return summary.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
