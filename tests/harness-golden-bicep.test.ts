// Bicep inventory golden (BUILD-PLAN P4; DEP-02, DEP-05): every resource each infra/staged template declares, with
// its type, name expression, API version and the properties Azure cannot change after creation. A resource that
// disappears or a create-only property that changes would make a redeploy fail, or replace a running resource.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readGoldenJson, updating } from "./helpers/golden.ts";

type Obj = Record<string, any>;
type Entry = { type: string; name: string; apiVersion: string; createOnly: Record<string, unknown> };
type Inventory = Record<string, Entry>;

const root = path.resolve(import.meta.dirname, "..");
const stagedDir = path.join(root, "infra", "staged");

// Properties Azure accepts only at creation (changing them fails the deployment or replaces the resource).
const CREATE_ONLY: Record<string, string[]> = {
  "Microsoft.DocumentDB/databaseAccounts": ["kind", "properties.databaseAccountOfferType"],
  "Microsoft.DocumentDB/databaseAccounts/sqlDatabases": ["properties.resource.id"],
  "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers": ["properties.resource.id", "properties.resource.partitionKey"],
  "Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments": ["properties.roleDefinitionId", "properties.principalId", "properties.scope"],
  "Microsoft.Storage/storageAccounts": ["kind", "properties.isHnsEnabled"],
  "Microsoft.Web/serverfarms": ["kind", "sku"],
  "Microsoft.Web/sites": ["kind"],
  "Microsoft.ApiManagement/service": ["sku.name"],
  "Microsoft.CognitiveServices/accounts": ["kind", "properties.customSubDomainName"],
  "Microsoft.Insights/components": ["kind", "properties.Application_Type"],
  "Microsoft.Authorization/roleAssignments": ["scope", "properties.roleDefinitionId", "properties.principalId"],
  "Microsoft.Network/privateEndpoints": ["properties.subnet"],
};

function bicepPath(): string {
  const candidates = [process.env.BICEP_PATH, ...((process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, os.platform() === "win32" ? "bicep.exe" : "bicep"))),
    path.join(os.homedir(), ".azure", "bin", os.platform() === "win32" ? "bicep.exe" : "bicep")].filter(Boolean) as string[];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("Offline Bicep CLI required (az bicep install, or set BICEP_PATH); this test does not install tools.");
  return found;
}

// A create-only value, or the ARM expression that produces it: compiled loops and unions often turn a nested property
// into one expression string on an ancestor (for example `properties.resource` of the Cosmos containers).
function pickOrExpression(o: Obj, dotted: string): [string, unknown] | undefined {
  let v: any = o;
  const parts = dotted.split(".");
  for (let i = 0; i < parts.length; i++) {
    if (typeof v === "string" && v.startsWith("[")) return [parts.slice(0, i).join("."), v];
    if (v == null) return undefined;
    v = v[parts[i]];
  }
  return v === undefined ? undefined : [dotted, v];
}

// The template variables an expression refers to, followed transitively, so a change to a looped-over list is seen.
function referencedVariables(value: unknown, vars: Obj, out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const m of JSON.stringify(value).matchAll(/variables\('([^']+)'\)/g)) {
    if (m[1] in out || !(m[1] in vars)) continue;
    out[m[1]] = vars[m[1]];
    referencedVariables(vars[m[1]], vars, out);
  }
  return out;
}

function collect(template: Obj, file: string, chain: string[], out: Inventory) {
  const resources = Array.isArray(template.resources) ? template.resources : Object.values(template.resources ?? {});
  for (const r of resources as Obj[]) {
    if (r.existing === true) continue;
    const key = [file, ...chain, `${r.type} ${r.name}`].join(" :: ");
    const createOnly: Record<string, unknown> = {};
    for (const p of CREATE_ONLY[r.type] ?? []) {
      const found = pickOrExpression(r, p);
      if (found) createOnly[found[0]] = found[1];
    }
    const vars = referencedVariables(createOnly, template.variables ?? {});
    if (Object.keys(vars).length) createOnly.variables = vars;
    out[key] = { type: r.type, name: String(r.name), apiVersion: r.apiVersion, createOnly };
    if (r.type === "Microsoft.Resources/deployments" && r.properties?.template) collect(r.properties.template, file, [...chain, String(r.name)], out);
  }
}

async function inventory(): Promise<Inventory> {
  const bicep = bicepPath();
  const files = readdirSync(stagedDir).filter((f) => f.endsWith(".bicep")).sort();
  const run = promisify(execFile);
  const compiled = await Promise.all(files.map(async (f) => {
    const { stdout } = await run(bicep, ["build", path.join(stagedDir, f), "--stdout"], { maxBuffer: 64 * 1024 * 1024 });
    return [f, JSON.parse(stdout)] as const;
  }));
  const out: Inventory = {};
  for (const [f, arm] of compiled) collect(arm, `infra/staged/${f}`, [], out);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function inventoryProblems(before: Inventory, after: Inventory): string[] {
  const problems: string[] = [];
  for (const [key, was] of Object.entries(before)) {
    const now = after[key];
    if (!now) { problems.push(`resource disappeared or renamed: ${key}`); continue; }
    for (const [p, v] of Object.entries(was.createOnly)) {
      if (JSON.stringify(now.createOnly[p]) !== JSON.stringify(v)) problems.push(`create-only property changed: ${key} ${p}`);
    }
  }
  return problems;
}

let current: Inventory;

test("no staged resource disappears and no create-only property changes (compared with the golden)", async () => {
  current = await inventory();
  assert.ok(Object.keys(current).length > 20, `expected the staged templates' resources, got ${Object.keys(current).length}`);
  const golden = readGoldenJson<Inventory>("bicep-inventory.json", updating ? current : undefined);
  assert.deepEqual(inventoryProblems(golden, current), []);
});

test("the comparison catches a removed resource and a changed create-only property", async () => {
  current ??= await inventory();
  const [key] = Object.keys(current).filter((k) => current[k].type === "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers");
  assert.ok(key, "a Cosmos container is in the inventory");
  const removed = { ...current }; delete removed[key];
  const changed = JSON.parse(JSON.stringify(current)) as Inventory;
  const [field] = Object.keys(changed[key].createOnly);
  assert.ok(field, "the container records its create-only partition key (or the expression and variables behind it)");
  changed[key].createOnly[field] = "changed";
  assert.match(inventoryProblems(current, removed).join(), /resource disappeared/);
  assert.match(inventoryProblems(current, changed).join(), /create-only property changed/);
  const added = { ...current, "infra/staged/x.bicep :: Microsoft.Web/sites new": { type: "Microsoft.Web/sites", name: "new", apiVersion: "2024-04-01", createOnly: {} } };
  assert.deepEqual(inventoryProblems(current, added), [], "a new resource is compatible");
});
