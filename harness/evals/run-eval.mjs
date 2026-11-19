#!/usr/bin/env node
// Agent eval bank runner (BUILD-PLAN P10, docs/harness/EVALS.md).
//
//   node harness/evals/run-eval.mjs list
//   node harness/evals/run-eval.mjs prepare <task>                      # worktree at baseRef (+ seed); prints the prompt
//   node harness/evals/run-eval.mjs grade <task> <worktree> --model <name> [--quick] [--keep]
//   node harness/evals/run-eval.mjs validate <task|--all> [--kind k] [--out file]
//   node harness/evals/run-eval.mjs cleanup <worktree>
//
// Grading copies the hidden tests in only after the scope check, so they never count against the agent. Results go
// to harness/evals/results/<date>-<model>.json. Nothing here calls Azure or runs live tests.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMutant } from "../run-mutants.mjs";
import { mergeResult, protectedChanges, rateCardRewrites, scopeViolations, score, taskProblems } from "./eval-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TASKS = path.join(root, "harness", "evals", "tasks");
const ENV = { ...process.env, CCOF_LIVE_TESTS: "0", CCOF_LIVE_SMOKE: "0", CCOF_UPDATE_GOLDEN: "0" };
const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (text) => text.split(/\r?\n/).filter(Boolean);

export function loadTask(id) {
  const task = JSON.parse(readFileSync(path.join(TASKS, `${id}.json`), "utf8"));
  const problems = taskProblems(task);
  if (problems.length) throw new Error(`task ${id}: ${problems.join("; ")}`);
  return task;
}
const allTaskIds = () => readdirSync(TASKS).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
const stateFile = (worktree) => `${path.resolve(worktree)}.eval.json`;

function link(worktree) {
  for (const dir of [".", "admin", "client"]) {
    const from = path.join(root, dir, "node_modules");
    const to = path.join(worktree, dir, "node_modules");
    if (existsSync(from) && existsSync(path.join(worktree, dir)) && !existsSync(to)) symlinkSync(from, to, "junction");
  }
}

function seedEdits(task) {
  if (task.seed?.mutant) {
    const mutants = JSON.parse(readFileSync(path.join(root, "harness", "mutants.json"), "utf8")).mutants;
    const m = mutants.find((x) => x.id === task.seed.mutant);
    if (!m) throw new Error(`seed mutant ${task.seed.mutant} not in harness/mutants.json`);
    return [m];
  }
  return (task.seed?.edits ?? []).map((e, i) => ({ id: `${task.id}-edit-${i}`, ...e }));
}

// A detached worktree at ref, node_modules linked from this checkout, with the task's seed committed on top.
export function prepare(task, ref = task.baseRef, { seed = true } = {}) {
  const worktree = mkdtempSync(path.join(os.tmpdir(), `ccof-eval-${task.id}-`));
  rmSync(worktree, { recursive: true, force: true });
  git(["worktree", "add", "--detach", worktree, ref]);
  link(worktree);
  if (seed && seedEdits(task).length) {
    for (const e of seedEdits(task)) {
      const file = path.join(worktree, e.file);
      writeFileSync(file, applyMutant(readFileSync(file, "utf8"), e));
    }
    git(["-c", "user.name=ccof-eval", "-c", "user.email=eval@invalid", "commit", "-qam", `eval seed: ${task.id}`, "--no-verify"], worktree);
  }
  const state = { task: task.id, ref, baseSha: git(["rev-parse", ref]), startSha: git(["rev-parse", "HEAD"], worktree) };
  writeFileSync(stateFile(worktree), JSON.stringify(state, null, 2));
  return { worktree, ...state };
}

export function cleanup(worktree) {
  for (const dir of [".", "admin", "client"]) {
    const to = path.join(worktree, dir, "node_modules");
    if (existsSync(to)) rmSync(to, { force: true, recursive: false });
  }
  try { git(["worktree", "remove", "--force", worktree]); } catch { rmSync(worktree, { recursive: true, force: true }); git(["worktree", "prune"]); }
  rmSync(stateFile(worktree), { force: true });
}

function hiddenSource(task, file, state) {
  if (task.hiddenFrom === "evals") return readFileSync(path.join(root, "harness", "evals", "hidden", path.basename(file)), "utf8");
  return git(["show", `${task.hiddenFrom === "release" ? task.releaseRef : state.baseSha}:${file}`]);
}

function run(cmd, args, cwd, timeoutMinutes) {
  const r = spawnSync(cmd, args, { cwd, env: ENV, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: timeoutMinutes * 60000, shell: process.platform === "win32" && cmd === "npm" });
  return { ok: r.status === 0 && !r.error, timedOut: r.error?.code === "ETIMEDOUT", tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.split(/\r?\n/).filter(Boolean).slice(-5) };
}

function runHidden(task, worktree, state, timeoutMinutes = 20) {
  if (!task.hiddenTests.length) return { ok: null, details: [] };
  const details = task.hiddenTests.map((file) => {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    writeFileSync(path.join(worktree, file), hiddenSource(task, file, state));
    const r = file.endsWith(".ps1") ? run("pwsh", ["-NoProfile", "-File", file], worktree, timeoutMinutes) : run(process.execPath, ["--test", file], worktree, timeoutMinutes);
    return { file, ...r };
  });
  return { ok: details.every((d) => d.ok), details };
}

function changedFiles(worktree, startSha) {
  return [...new Set([...lines(git(["diff", "--name-only", "--no-renames", startSha], worktree)), ...lines(git(["ls-files", "--others", "--exclude-standard"], worktree))])].sort();
}

export function grade(task, worktree, { model, quick = false } = {}) {
  const state = JSON.parse(readFileSync(stateFile(worktree), "utf8"));
  if (state.task !== task.id) throw new Error(`${worktree} was prepared for ${state.task}, not ${task.id}`);
  const changed = changedFiles(worktree, state.startSha);
  const rateCard = changed.includes("config/rate-card.json") && existsSync(path.join(worktree, "config/rate-card.json"))
    ? rateCardRewrites(JSON.parse(git(["show", `${state.startSha}:config/rate-card.json`], worktree)), JSON.parse(readFileSync(path.join(worktree, "config/rate-card.json"), "utf8")))
    : [];
  const checks = { scope: scopeViolations(changed, task.allowedPaths), protected: protectedChanges(changed), rateCard };
  const hidden = runHidden(task, worktree, state);
  checks.hidden = hidden.ok;
  const suite = quick ? run(process.execPath, ["--test", "tests/*.test.ts"], worktree, 30) : run("npm", ["test"], worktree, 60);
  checks.suite = suite.ok;
  const invariantTests = ["tests/harness-invariants.test.ts", "tests/harness-mutants.test.ts", "tests/harness-guidance.test.ts"].filter((f) => existsSync(path.join(worktree, f)));
  checks.invariants = invariantTests.length ? run(process.execPath, ["--test", ...invariantTests], worktree, 10).ok : null;
  checks.gate = existsSync(path.join(worktree, ".ironclad", "gate.mjs")) ? run(process.execPath, [".ironclad/gate.mjs", "--stage", "pre-commit"], worktree, 5).ok : null;
  const verdict = score(task, checks);
  return {
    task: task.id, kind: task.kind, expected: task.expected, model, gradedAt: new Date().toISOString(), suiteMode: quick ? "node" : "npm test",
    ...verdict, changed, checks, hidden: hidden.details.map(({ file, ok, timedOut, tail }) => ({ file, ok, timedOut, ...(ok ? {} : { tail }) })),
    ...(suite.ok ? {} : { suiteTail: suite.tail }),
  };
}

// The task's hidden tests must fail where the agent starts, and pass at the reference: the release for a replay, the
// unseeded base for a seeded or docs-drift task. A trap's hidden tests (its protections) must pass at the base.
export function validate(task) {
  const start = prepare(task);
  try {
    const atStart = runHidden(task, start.worktree, start);
    if (task.kind === "trap") return { task: task.id, valid: atStart.ok !== false, baseFails: false, referencePasses: atStart.ok };
    let reference;
    if (task.kind === "replay") {
      const rel = prepare(task, task.releaseRef, { seed: false });
      try { reference = runHidden(task, rel.worktree, rel); } finally { cleanup(rel.worktree); }
    } else {
      git(["reset", "-q", "--hard", start.baseSha], start.worktree);
      reference = runHidden(task, start.worktree, start);
    }
    const fails = atStart.details.filter((d) => !d.ok).map((d) => d.file);
    return { task: task.id, valid: atStart.ok === false && reference.ok === true, baseFails: atStart.ok === false, referencePasses: reference.ok, failingAtBase: fails,
      ...(reference.ok ? {} : { referenceFailures: reference.details.filter((d) => !d.ok).map((d) => ({ file: d.file, timedOut: d.timedOut, tail: d.tail })) }) };
  } finally {
    cleanup(start.worktree);
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === "list") { for (const id of allTaskIds()) { const t = loadTask(id); console.log(`${id}\t${t.kind}\t${t.expected}`); } return 0; }
  if (cmd === "prepare") {
    const task = loadTask(rest[0]);
    const p = prepare(task);
    console.log(`worktree: ${p.worktree}\nbase: ${p.baseSha}\n\n${task.prompt}\n`);
    return 0;
  }
  if (cmd === "grade") {
    const task = loadTask(rest[0]);
    const model = flag("--model");
    if (!model || !/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("--model <name> is required (letters, digits, . _ -)");
    const result = grade(task, rest[1], { model, quick: rest.includes("--quick") });
    const file = path.join(root, "harness", "evals", "results", `${result.gradedAt.slice(0, 10)}-${model}.json`);
    const doc = mergeResult(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, result);
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    if (!rest.includes("--keep")) cleanup(rest[1]);
    console.log(JSON.stringify({ task: result.task, outcome: result.outcome, trapFailure: result.trapFailure, regression: result.regression, checks: result.checks }, null, 2));
    console.log(`results: ${path.relative(root, file)}`);
    return result.outcome === "pass" ? 0 : 1;
  }
  if (cmd === "validate") {
    const ids = rest[0] === "--all" ? allTaskIds().filter((id) => !flag("--kind") || loadTask(id).kind === flag("--kind")) : [rest[0]];
    const out = [];
    for (const id of ids) {
      const r = validate(loadTask(id));
      out.push(r);
      console.error(`${r.valid ? "valid  " : "INVALID"} ${id} (fails at start: ${r.baseFails}, passes at reference: ${r.referencePasses})`);
    }
    if (flag("--out")) writeFileSync(flag("--out"), JSON.stringify(out, null, 2) + "\n");
    return out.every((r) => r.valid) ? 0 : 1;
  }
  if (cmd === "cleanup") { cleanup(rest[0]); return 0; }
  console.error("usage: run-eval.mjs list | prepare <task> | grade <task> <worktree> --model <m> [--quick] [--keep] | validate <task|--all> [--kind k] [--out f] | cleanup <worktree>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(2); }
}
