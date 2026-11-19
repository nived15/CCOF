// Runtime names golden (BUILD-PLAN P4; OPS-01, OPS-02, DATA-02, DATA-03): the names a deployed installation depends
// on, extracted from the source and compared with tests/golden/runtime-names.json. A rename here breaks a running
// installation: app settings, timers, Cosmos containers, telemetry queries and alerts refer to these exact names.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readGoldenJson, updating } from "./helpers/golden.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const walk = (dir: string, ext: RegExp): string[] => readdirSync(path.join(root, dir)).flatMap((e) => {
  const rel = `${dir}/${e}`;
  if (e === "node_modules" || e === "dist" || e === "ui-v3") return [];
  return statSync(path.join(root, rel)).isDirectory() ? walk(rel, ext) : ext.test(e) ? [rel] : [];
});
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

// A string constant such as `const FUNCTION_NAME = "syncEntitlement";`, looked up in the file itself first and then in
// the file it is imported from (two apps both define FUNCTION_NAME).
function resolveConstant(file: string, id: string): string | undefined {
  const text = read(file);
  const local = text.match(new RegExp(`\\bconst ${id} = "([^"]+)"`));
  if (local) return local[1];
  const imported = [...text.matchAll(/import \{([^}]+)\} from "(\.[^"]+)"/g)].find((m) => m[1].split(",").map((s) => s.trim()).includes(id));
  return imported ? resolveConstant(path.posix.join(path.posix.dirname(file), imported[2]), id) : undefined;
}

// Each registered function with its trigger and the CCOF_APP_ROLE guard it sits inside (null: always registered).
function functions() {
  const out: Record<string, { name: string; trigger: string; role: string | null }[]> = {};
  for (const file of ["src/resolver/function-app.ts", "src/sync/function-app.ts", "src/reconciler/function-app.ts", "admin/src/function-app.ts"]) {
    const text = read(file);
    const guards: { start: number; end: number; role: string }[] = [];
    for (const m of text.matchAll(/if \(process\.env\.CCOF_APP_ROLE === "([a-z]+)"\) \{/g)) {
      let depth = 0, i = m.index! + m[0].length - 1;
      for (; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) break; }
      guards.push({ start: m.index!, end: i, role: m[1] });
    }
    out[file] = [...text.matchAll(/app\.(http|timer)\(\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/g)].map((m) => ({
      name: m[2] ?? resolveConstant(file, m[3]) ?? `<unresolved ${m[3]}>`,
      trigger: m[1],
      role: guards.find((g) => m.index! > g.start && m.index! < g.end)?.role ?? null,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

const settingLiterals = (files: string[]) => sorted(files.flatMap((f) => [...read(f).matchAll(/"([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)"/g)].map((m) => m[1])));

function extract() {
  const infraText = walk("infra", /\.(bicep|ps1|psm1)$/).map(read).join("\n");
  const ledger = read("analytics/ledger.kql");
  const project = ledger.slice(ledger.lastIndexOf("| project ") + "| project ".length, ledger.lastIndexOf("};"));
  return {
    functions: functions(),
    disabledSettings: sorted([...`${infraText}\n${walk("src", /\.ts$/).map(read).join("\n")}`.matchAll(/AzureWebJobs\.([A-Za-z0-9]+)\.Disabled/g)].map((m) => m[1])),
    appRolesSetByInfra: sorted([...infraText.matchAll(/CCOF_APP_ROLE['"]?\s*[:=]\s*'([a-z]+)'/g)].map((m) => m[1])),
    settings: {
      resolver: settingLiterals(["src/resolver/config.ts"]),
      sync: settingLiterals(["src/sync/config.ts", "src/sync/registry-seed.ts", "src/sync/snapshot-function.ts"]),
      reconciler: settingLiterals(["src/reconciler/settings.ts"]),
      admin: sorted(settingLiterals(walk("admin/src", /\.ts$/)).filter((s) => s.startsWith("ADMIN_"))),
    },
    cosmosContainers: Object.fromEntries([...read("infra/staged/stage2-schema.bicep").matchAll(/\{ name: '([^']+)', partitionKey: '([^']+)' \}/g)]
      .map((m) => [m[1], m[2]]).sort(([a], [b]) => a.localeCompare(b))),
    traceSources: sorted([...walk("src", /\.ts$/), ...walk("infra/gateway/policy", /\.xml$/), ...walk("analytics", /\.kql$/)]
      .flatMap((f) => [...read(f).matchAll(/\bccof\.[a-z]+(?:\.[a-z]+)*\.v\d+\b/g)].map((m) => m[0]))),
    ledgerColumns: project.split(",").map((c) => c.trim()).filter(Boolean),
  };
}

test("runtime names match the golden (function names, settings, containers, trace sources, ledger columns)", () => {
  const now = extract();
  assert.deepEqual(now, readGoldenJson("runtime-names.json", updating ? now : undefined));
});

test("OPS-01: every function name is resolved, has no hyphen, and every timer has its Disabled setting", () => {
  const names = extract();
  const all = Object.values(names.functions).flat();
  assert.deepEqual(all.filter((f) => f.name.startsWith("<") || f.name.includes("-")).map((f) => f.name), []);
  for (const required of ["resolve", "health", "myUsage", "syncEntitlement", "registrySeed", "snapshotApply", "reconcileBudgets"]) {
    assert.ok(all.some((f) => f.name === required), `${required} is registered`);
  }
  for (const timer of all.filter((f) => f.trigger === "timer")) assert.ok(names.disabledSettings.includes(timer.name), `AzureWebJobs.${timer.name}.Disabled`);
});

test("OPS-02: every timer is registered only inside the CCOF_APP_ROLE guard of its own app", () => {
  const { functions: byFile } = extract();
  for (const [file, list] of Object.entries(byFile)) {
    const app = file.split("/")[1] === "src" ? "admin" : file.split("/")[1];
    for (const timer of list.filter((f) => f.trigger === "timer")) assert.equal(timer.role, app, `${file}: ${timer.name}`);
  }
});

test("DATA-03: the Cosmos containers the source reads exist with their partition keys", () => {
  const { cosmosContainers } = extract();
  assert.equal(cosmosContainers.entitlement, "/personId");
  assert.equal(cosmosContainers.budgetState, "/personId");
  assert.equal(cosmosContainers.projects, "/projectId");
});
