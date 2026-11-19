#!/usr/bin/env node
// Captures the customer's deployed version for the version-skew test (BUILD-PLAN P5). In a temporary git worktree at
// --ref (default: tests/fixtures/customer/manifest.json deployedCommit) it:
//   - produces that version's documents, resolver replies and rendered policy from its own code and test helpers
//     (harness/version/capture-artifacts.mts), and
//   - builds it and copies the compiled readers the current version's documents must still satisfy (the resolver's
//     handler, the group-registration and project readers, the reconciler's registry reader), with their imports.
// Writes tests/fixtures/version-n-1/. Re-run after every customer upgrade. Node built-ins only; reads git, no Azure.
//
//   node harness/capture-version.mjs [--ref <sha>]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tests", "fixtures", "version-n-1");
export const READER_ENTRIES = [
  "resolver/http-handler.js", "contracts/group-registration.js", "sync/projects.js", "reconciler/registry.js",
];

const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

// The entry modules and every module they import, relative to dist/.
export function importClosure(distDir, entries) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = readFileSync(path.join(distDir, rel), "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  };
  for (const e of entries) visit(e);
  return [...seen].sort();
}

async function main(argv) {
  let ref = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") ref = argv[++i];
    else { console.error(`unknown argument: ${argv[i]}`); return 1; }
  }
  ref ??= JSON.parse(readFileSync(path.join(root, "tests", "fixtures", "customer", "manifest.json"), "utf8")).deployedCommit;
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`);
  const worktree = mkdtempSync(path.join(os.tmpdir(), "ccof-version-"));
  rmSync(worktree, { recursive: true, force: true });
  git("worktree", "add", "--detach", worktree, sha);
  try {
    // The old version's code resolves its packages through the current installation (same package.json at 9faa1fc).
    symlinkSync(path.join(root, "node_modules"), path.join(worktree, "node_modules"), "junction");
    const { capture } = await import(pathToFileURL(path.join(root, "harness", "version", "capture-artifacts.mts")).href);
    const artifacts = await capture(worktree);

    execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(worktree, "tsconfig.json")], { stdio: "inherit" });
    const dist = path.join(worktree, "dist");
    const readers = importClosure(dist, READER_ENTRIES);

    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(path.join(OUT, "readers"), { recursive: true });
    for (const rel of readers) {
      const target = path.join(OUT, "readers", rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(dist, rel), "utf8").replace(/\n\/\/# sourceMappingURL=.*\s*$/, "\n"));
    }
    writeFileSync(path.join(OUT, "policy.xml"), artifacts.policyXml);
    writeFileSync(path.join(OUT, "scenarios.json"), `${JSON.stringify(artifacts.scenarios, null, 2)}\n`);
    writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify({
      ref: sha.slice(0, 7), commit: sha, commitDate: git("show", "-s", "--format=%cI", sha), readerEntries: READER_ENTRIES, readers,
      note: "Produced by harness/capture-version.mjs from the deployed version's own code; do not edit. Re-run after each customer upgrade.",
    }, null, 2)}\n`);
    console.log(`Captured ${sha.slice(0, 7)}: ${artifacts.scenarios.length} scenarios, ${readers.length} reader modules -> ${path.relative(root, OUT)}`);
    return 0;
  } finally {
    rmSync(path.join(worktree, "node_modules"), { force: true, recursive: false });
    git("worktree", "remove", "--force", worktree);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
