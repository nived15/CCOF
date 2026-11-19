#!/usr/bin/env node
// Change classifier (BUILD-PLAN P2, ADR-0056). Lists the files a change touches, gives the change its risk tier
// (the highest tier of any file), the invariants it touches (through harness/invariants.json sources and protecting
// tests) and the checks that tier requires. Node built-ins only; reads git, writes nothing.
//
//   node harness/classify-change.mjs --base main            # committed changes since main, plus uncommitted work
//   node harness/classify-change.mjs --base main --json
//   node harness/classify-change.mjs --files src/cost/money.ts docs/STATUS.md
//   git ls-files | node harness/classify-change.mjs --stdin --json
//
// Exit codes: 0 classified; 1 usage or git error; 2 a file matches no rule or more than one rule.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const TIER_ORDER = ["T0", "T1", "T2", "T3"];

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else { re += ".*"; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (file, globs = []) => globs.some((g) => globToRegExp(g).test(file));

export function rulesFor(file, tiers) {
  return tiers.rules.filter((r) => matchesAny(file, r.include) && !matchesAny(file, r.exclude));
}

function testCommand(file) {
  if (/^tests\/[^/]+\.test\.ts$/.test(file)) return `node --test ${file}`;
  if (/^tests\/[^/]+\.ps1$/.test(file)) return `pwsh -NoProfile -File ${file}`;
  if (file.startsWith("admin/tests/")) return "npm --prefix admin test";
  if (file.startsWith("client/test/")) return "npm --prefix client test";
  return null;
}

export function classify(files, tiers, register) {
  const normal = [...new Set(files.map((f) => f.trim().replace(/\\/g, "/")).filter(Boolean))].sort();
  const perFile = normal.map((file) => {
    const rules = rulesFor(file, tiers);
    return { file, rules: rules.map((r) => r.id), tier: rules.length === 1 ? rules[0].tier : null };
  });
  const unmatched = perFile.filter((f) => f.rules.length === 0).map((f) => f.file);
  const ambiguous = perFile.filter((f) => f.rules.length > 1).map((f) => ({ file: f.file, rules: f.rules }));
  const tierIndex = Math.max(-1, ...perFile.filter((f) => f.tier).map((f) => TIER_ORDER.indexOf(f.tier)));
  const tier = tierIndex >= 0 ? TIER_ORDER[tierIndex] : null;

  const invariants = [];
  for (const inv of register.invariants) {
    const viaSource = normal.filter((f) => inv.sources.includes(f));
    const viaTest = normal.filter((f) => inv.protectedBy.includes(f));
    if (viaSource.length || viaTest.length) invariants.push({ id: inv.id, statement: inv.statement, viaSource, viaTest });
  }

  const affected = new Set();
  for (const f of normal) { const c = testCommand(f); if (c) affected.add(c); }
  for (const inv of invariants) {
    for (const t of register.invariants.find((i) => i.id === inv.id).protectedBy) { const c = testCommand(t); if (c) affected.add(c); }
  }
  for (const a of tiers.affected ?? []) if (normal.some((f) => matchesAny(f, a.include))) affected.add(a.run);

  const checks = { required: [], pending: [], manual: [] };
  for (const t of TIER_ORDER.slice(0, tierIndex + 1)) {
    for (const c of tiers.tiers[t].checks) {
      if (c.run) checks.required.push({ tier: t, id: c.id, run: c.run });
      else if (c.affected) for (const run of [...affected].sort()) checks.required.push({ tier: t, id: c.id, run });
      else if (c.pendingPacket) checks.pending.push({ tier: t, id: c.id, packet: c.pendingPacket });
      else if (c.manual) checks.manual.push({ tier: t, id: c.id, manual: c.manual });
    }
  }
  return { tier, files: perFile, unmatched, ambiguous, invariants, checks };
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split(/\r?\n/).filter(Boolean);
}

export function changedFiles({ base, head = "HEAD", worktree = true }) {
  const mergeBase = git(["merge-base", base, head])[0];
  const files = git(["diff", "--name-only", "--no-renames", mergeBase, head]);
  if (worktree && head === "HEAD") {
    files.push(...git(["diff", "--name-only", "--no-renames", "HEAD"]));
    files.push(...git(["ls-files", "--others", "--exclude-standard"]));
  }
  return files;
}

function parseArgs(argv) {
  const opts = { base: "main", head: "HEAD", json: false, worktree: true, stdin: false, files: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--head") opts.head = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--committed-only") opts.worktree = false;
    else if (a === "--stdin") opts.stdin = true;
    else if (a === "--files") { opts.files = argv.slice(i + 1); break; }
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.base || !opts.head) throw new Error("--base and --head need a ref");
  return opts;
}

function printText(result) {
  const out = [];
  out.push(`Tier: ${result.tier ?? "none (no changed files)"}`);
  out.push("", "Files:");
  for (const f of result.files) out.push(`  ${f.tier ?? "??"}  ${f.file}${f.rules.length > 1 ? `  (rules: ${f.rules.join(", ")})` : ""}`);
  out.push("", "Invariants touched:");
  if (!result.invariants.length) out.push("  none");
  for (const i of result.invariants) {
    const via = [...i.viaSource.map((f) => `source ${f}`), ...i.viaTest.map((f) => `test ${f}`)].join("; ");
    out.push(`  ${i.id}  ${i.statement}`, `         via ${via}`);
  }
  out.push("", "Required checks:");
  if (!result.checks.required.length) out.push("  none");
  for (const c of result.checks.required) out.push(`  [${c.tier}] ${c.run}`);
  if (result.checks.pending.length) {
    out.push("", "Not yet built (become required when their packet lands):");
    for (const c of result.checks.pending) out.push(`  [${c.tier}] ${c.id} (${c.packet})`);
  }
  if (result.checks.manual.length) {
    out.push("", "Manual:");
    for (const c of result.checks.manual) out.push(`  [${c.tier}] ${c.manual}`);
  }
  if (result.unmatched.length || result.ambiguous.length) {
    out.push("", "ERROR: every file must match exactly one rule in harness/tiers.json");
    for (const f of result.unmatched) out.push(`  no rule: ${f}`);
    for (const f of result.ambiguous) out.push(`  several rules (${f.rules.join(", ")}): ${f.file}`);
  }
  console.log(out.join("\n"));
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 1; }
  if (opts.help) { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 11).join("\n")); return 0; }
  const tiers = JSON.parse(readFileSync(path.join(here, "tiers.json"), "utf8"));
  const register = JSON.parse(readFileSync(path.join(here, "invariants.json"), "utf8"));
  let files;
  try {
    if (opts.files) files = opts.files;
    else if (opts.stdin) files = readFileSync(0, "utf8").split(/\r?\n/);
    else files = changedFiles(opts);
  } catch (e) {
    console.error(`git failed: ${(e.stderr || e.message).toString().trim()}`);
    return 1;
  }
  const result = classify(files, tiers, register);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  return result.unmatched.length || result.ambiguous.length ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
