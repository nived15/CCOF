// Admin API compatibility (BUILD-PLAN P4): compared with tests/golden/admin-api.json, admin/openapi.yaml may add
// paths, methods, optional parameters and response fields, but must not remove a path, a method or a response field,
// and must not make a parameter or a request body newly required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseYaml } from "../harness/lib/yaml-lite.mjs";
import { readGoldenJson, updating } from "./helpers/golden.ts";

type Obj = Record<string, any>;
type Operation = { params: Record<string, boolean>; bodyRequired: boolean; responses: Record<string, string[]> };
type Contract = Record<string, Record<string, Operation>>;

const root = path.resolve(import.meta.dirname, "..");
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

function extractContract(spec: Obj): Contract {
  const resolve = (node: Obj | undefined): Obj | undefined => {
    let n = node, guard = 0;
    while (n && typeof n.$ref === "string" && guard++ < 20) {
      n = n.$ref.replace(/^#\//, "").split("/").reduce((o: Obj | undefined, k: string) => o?.[k], spec);
    }
    return n;
  };
  const fields = (schema: Obj | undefined, prefix: string, seen: Set<Obj>, out: Set<string>) => {
    const s = resolve(schema);
    if (!s || typeof s !== "object" || seen.has(s)) return;
    seen.add(s);
    for (const part of [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])]) fields(part, prefix, seen, out);
    for (const [k, v] of Object.entries((s.properties ?? {}) as Obj)) {
      out.add(`${prefix}${k}`);
      fields(v as Obj, `${prefix}${k}.`, seen, out);
    }
    if (s.items) fields(s.items, `${prefix}[].`, seen, out);
    seen.delete(s);
  };
  const contract: Contract = {};
  for (const [p, item] of Object.entries((spec.paths ?? {}) as Obj)) {
    const shared = ((item as Obj).parameters ?? []) as Obj[];
    contract[p] = {};
    for (const m of METHODS) {
      const op = (item as Obj)[m] as Obj | undefined;
      if (!op) continue;
      const params: Record<string, boolean> = {};
      for (const raw of [...shared, ...((op.parameters ?? []) as Obj[])]) {
        const prm = resolve(raw);
        if (prm?.name) params[`${prm.in}:${prm.name}`] = prm.required === true;
      }
      const body = resolve(op.requestBody);
      const responses: Record<string, string[]> = {};
      for (const [code, r] of Object.entries((op.responses ?? {}) as Obj)) {
        const resp = resolve(r as Obj);
        const out = new Set<string>();
        for (const media of Object.values((resp?.content ?? {}) as Obj)) fields((media as Obj).schema, "", new Set(), out);
        responses[code] = [...out].sort();
      }
      contract[p][m] = { params, bodyRequired: body?.required === true, responses };
    }
  }
  return contract;
}

function breakingChanges(before: Contract, after: Contract): string[] {
  const problems: string[] = [];
  for (const [p, methods] of Object.entries(before)) {
    if (!after[p]) { problems.push(`path removed: ${p}`); continue; }
    for (const [m, op] of Object.entries(methods)) {
      const now = after[p][m];
      if (!now) { problems.push(`method removed: ${m.toUpperCase()} ${p}`); continue; }
      for (const [name, required] of Object.entries(now.params)) {
        if (required && op.params[name] !== true) problems.push(`parameter newly required: ${m.toUpperCase()} ${p} ${name}`);
      }
      if (now.bodyRequired && !op.bodyRequired) problems.push(`request body newly required: ${m.toUpperCase()} ${p}`);
      for (const [code, fieldsBefore] of Object.entries(op.responses)) {
        const fieldsNow = new Set(now.responses[code] ?? []);
        if (!now.responses[code]) { problems.push(`response removed: ${m.toUpperCase()} ${p} ${code}`); continue; }
        for (const f of fieldsBefore) if (!fieldsNow.has(f)) problems.push(`response field removed: ${m.toUpperCase()} ${p} ${code} ${f}`);
      }
    }
  }
  return problems;
}

const current = () => extractContract(parseYaml(readFileSync(path.join(root, "admin", "openapi.yaml"), "utf8")) as Obj);

test("admin/openapi.yaml removes nothing and makes nothing newly required (compared with the golden)", () => {
  const now = current();
  const golden = readGoldenJson<Contract>("admin-api.json", updating ? now : undefined);
  assert.deepEqual(breakingChanges(golden, now), []);
});

test("the comparison catches each kind of breaking change", () => {
  const base = current();
  const clone = () => JSON.parse(JSON.stringify(base)) as Contract;
  const [p] = Object.keys(base).filter((k) => base[k].get && Object.values(base[k].get.responses).some((f) => f.length));
  const [code] = Object.entries(base[p].get.responses).find(([, f]) => f.length)!;

  const noPath = clone(); delete noPath[p];
  const noMethod = clone(); delete noMethod[p].get;
  const noField = clone(); noField[p].get.responses[code] = noField[p].get.responses[code].slice(1);
  const newRequired = clone(); newRequired[p].get.params["query:newFilter"] = true;
  const newBody = clone(); newBody[p].get.bodyRequired = true;
  const added = clone(); added["/new"] = { get: { params: { "query:x": false }, bodyRequired: false, responses: { "200": ["a"] } } };

  assert.match(breakingChanges(base, noPath).join(), /path removed/);
  assert.match(breakingChanges(base, noMethod).join(), /method removed/);
  assert.match(breakingChanges(base, noField).join(), /response field removed/);
  assert.match(breakingChanges(base, newRequired).join(), /parameter newly required/);
  assert.match(breakingChanges(base, newBody).join(), /request body newly required/);
  assert.deepEqual(breakingChanges(base, added), [], "additions are compatible");
});
