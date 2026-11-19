// Version skew (BUILD-PLAN P5; DATA-01, DATA-03, SEC-01): during an upgrade the customer's deployed version (N-1,
// captured by harness/capture-version.mjs into tests/fixtures/version-n-1/) and the current version run side by side.
// Documents one writes, the other reads; replies one resolver gives, the other version's gateway policy validates.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, test } from "node:test";
import { attr, descendants, parseApimXml } from "../infra/gateway/apim-xml.ts";
import { capture, readsOver, SKEW_ENFORCEMENT, SKEW_NOW, type Artifacts, type Documents, type Scenario } from "../harness/version/capture-artifacts.mts";
import { readGroupRegistration } from "../src/contracts/group-registration.ts";
import { readRegistry } from "../src/reconciler/registry.ts";
import { handleResolveRequest } from "../src/resolver/http-handler.ts";
import { runExpressions } from "./helpers/policy-csharp.ts";
import { fakeReads } from "./helpers/resolver-fixtures.ts";

type Obj = Record<string, any>;
const root = path.resolve(import.meta.dirname, "..");
const nMinus1 = path.join(root, "tests", "fixtures", "version-n-1");
const manifest = JSON.parse(readFileSync(path.join(nMinus1, "manifest.json"), "utf8"));
const oldScenarios = JSON.parse(readFileSync(path.join(nMinus1, "scenarios.json"), "utf8")) as Scenario[];
const oldPolicyXml = readFileSync(path.join(nMinus1, "policy.xml"), "utf8");
const oldReader = (rel: string) => import(pathToFileURL(path.join(nMinus1, "readers", rel)).href);

let current: Artifacts;
let old: { handleResolveRequest: Obj["handleResolveRequest"]; readGroupRegistration: Obj["readGroupRegistration"]; readRegistry: Obj["readRegistry"] };
before(async () => {
  current = await capture(root);
  const [h, g, r] = await Promise.all([oldReader("resolver/http-handler.js"), oldReader("contracts/group-registration.js"), oldReader("reconciler/registry.js")]);
  old = { handleResolveRequest: h.handleResolveRequest, readGroupRegistration: g.readGroupRegistration, readRegistry: r.readRegistry };
});

// What a caller and the gateway act on: the status, the refusal or the selected scope.
const outcome = (status: number, body: Obj) => ({ status, error: body.error ?? null, refused: body.refused ?? null,
  projectId: body.projectId ?? null, classification: body.classification ?? null, decisionVersion: body.decisionVersion ?? null });

// What the reconciler would act on: the registered scopes with their budgets, and the memberships.
function registryView(registry: Obj) {
  const scopes = [...registry.scopes.values()].map((s: Obj) => `${s.scopeId} person=${s.personBudgetCcu} aggregate=${s.aggregateBudgetCcu ?? "none"}`).sort();
  const members = registry.members.map((m: Obj) => `${m.personId}@${m.scopeId}`).sort();
  return { scopes, members, problems: registry.problems };
}

async function answer(handler: Obj["handleResolveRequest"], s: { request: Obj; documents: Documents }) {
  const reply = await handler({ platformAuthEnabled: true, authenticatedPrincipal: true, body: s.request }, {
    readiness: { ready: true, requestDeadlineMs: 5000, reads: fakeReads(readsOver(s.documents)), budgetEnforcement: SKEW_ENFORCEMENT },
    now: () => SKEW_NOW, log: () => {},
  });
  return outcome(reply.status, reply.jsonBody);
}

test(`the captured N-1 version is ${manifest.ref} with the scenarios the current version also produces`, () => {
  assert.deepEqual(oldScenarios.map((s) => s.name), current.scenarios.map((s) => s.name));
  assert.ok(manifest.readers.length > 0);
});

test("current readers accept documents the N-1 version wrote", async () => {
  for (const s of oldScenarios) {
    for (const doc of s.documents.projects) assert.ok(readGroupRegistration(doc).ok, `${s.name}: current group reader refuses an N-1 project`);
    const view = registryView(readRegistry(s.documents.projects, s.documents.entitlements));
    assert.ok(view.scopes.length && view.members.length, `${s.name}: current registry reader registers nothing`);
    assert.deepEqual(view, registryView(old.readRegistry(s.documents.projects, s.documents.entitlements)), `${s.name}: current and N-1 registry readers differ on N-1 documents`);
    assert.deepEqual(await answer(handleResolveRequest, s), outcome(s.status, s.body), `${s.name}: current resolver over N-1 documents`);
  }
});

test("N-1 readers accept documents the current version writes", async () => {
  for (const s of current.scenarios) {
    for (const doc of s.documents.projects) assert.ok(old.readGroupRegistration(doc).ok, `${s.name}: N-1 group reader refuses a current project`);
    const view = registryView(old.readRegistry(s.documents.projects, s.documents.entitlements));
    assert.ok(view.scopes.length && view.members.length, `${s.name}: N-1 registry reader registers nothing`);
    assert.deepEqual(view, registryView(readRegistry(s.documents.projects, s.documents.entitlements)), `${s.name}: N-1 and current registry readers differ on current documents`);
    assert.deepEqual(await answer(old.handleResolveRequest, s), outcome(s.status, s.body), `${s.name}: N-1 resolver over current documents`);
  }
});

function resolverResult(policyXml: string) {
  const elements = descendants(parseApimXml(policyXml));
  const matches = elements.filter((e) => e.name === "set-variable" && attr(e, "name") === "ccofResolverResult");
  assert.ok(matches.length, "ccofResolverResult");
  return attr(matches[0], "value")!;
}

test("each version's resolver replies pass the other version's gateway policy validation unchanged", () => {
  const replies = [...oldScenarios.map((s) => ({ from: "N-1", s })), ...current.scenarios.map((s) => ({ from: "current", s }))];
  const run = (policyXml: string) => runExpressions({ Resolve: resolverResult(policyXml) }, replies.map(({ from, s }) => ({
    label: `${from} ${s.name}`, method: "Resolve", json: true, expected: null,
    vars: { ccofResolverResponse: { status: s.status, body: s.body } },
  }))) as Obj[];
  const kind = (r: Obj) => ({ o: r?.o ?? null, c: r?.c ?? null });
  const underOld = run(oldPolicyXml).map(kind), underCurrent = run(current.policyXml).map(kind);
  assert.deepEqual(underCurrent, underOld, "the N-1 and current policies read every reply the same way");
  replies.forEach(({ from, s }, i) => {
    const expected = s.status === 200 ? "allow" : s.status === 403 ? "refuse" : null;
    if (expected) assert.equal(underCurrent[i].o, expected, `${from} ${s.name}: ${JSON.stringify(underCurrent[i])}`);
  });
});
