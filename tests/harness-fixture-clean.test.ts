// Customer fixture checks (BUILD-PLAN P3, ADR-0056): committed fixtures under tests/fixtures/customer/ hold no
// customer GUID, hostname, email, JWT or secret; synthetic Cosmos documents are marked and pass the real readers;
// the pseudonymizer replaces every original value consistently and refuses when one would remain.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Decimal } from "decimal.js";
import { pseudonymize, scanForLeaks, type FixtureFile } from "../harness/pseudonymize-fixture.mjs";
import { readGroupRegistration } from "../src/contracts/group-registration.ts";
import { checkEntitlementRecord, validateMembership } from "../src/resolver/freshness.ts";

const root = path.resolve(import.meta.dirname, "..");
const fixtureDir = path.join(root, "tests", "fixtures", "customer");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
  const full = path.join(dir, e);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("committed customer fixtures hold no customer GUID, hostname, email, JWT or secret", () => {
  assert.ok(existsSync(fixtureDir), "tests/fixtures/customer/ is missing");
  const files = walk(fixtureDir);
  assert.ok(files.length > 0, "tests/fixtures/customer/ is empty");
  const leaks = files.flatMap((f) => scanForLeaks(readFileSync(f, "utf8")).map((p) => `${path.relative(root, f)}: ${p}`));
  assert.deepEqual(leaks, []);
});

test("synthetic Cosmos documents are marked synthetic and pass the real readers", () => {
  const cosmos = path.join(fixtureDir, "cosmos");
  const manifest = existsSync(path.join(fixtureDir, "manifest.json")) ? readJson(path.join(fixtureDir, "manifest.json")) : null;
  if (manifest?.cosmosSamples === true) return; // real, pseudonymized samples replaced the synthetic ones
  for (const name of ["projects.json", "entitlement.json", "budgetState.json"]) {
    const file = readJson(path.join(cosmos, name));
    assert.equal(file.synthetic, true, `${name} must be marked synthetic`);
    assert.ok(Array.isArray(file.documents) && file.documents.length > 0, `${name} needs documents`);
  }
  for (const doc of readJson(path.join(cosmos, "projects.json")).documents) {
    const read = readGroupRegistration(doc);
    assert.ok(read.ok, JSON.stringify(read));
  }
  for (const doc of readJson(path.join(cosmos, "entitlement.json")).documents) {
    assert.equal(doc.id, doc.personId);
    assert.deepEqual(checkEntitlementRecord(doc, Date.parse("2026-11-19T00:00:00Z")), { usable: true });
    for (const m of doc.projectMemberships) assert.equal(validateMembership(m).ok, true, JSON.stringify(validateMembership(m)));
  }
  for (const doc of readJson(path.join(cosmos, "budgetState.json")).documents) {
    assert.equal(doc.id, `${doc.personId}:${doc.projectId}`);
    assert.equal(doc.exhausted, new Decimal(doc.spentCcu).gte(new Decimal(doc.budgetCcu)), "MON-05: exhausted is spent >= budget");
    assert.ok(Number.isFinite(Date.parse(doc.validUntil)));
  }
});

// A made-up collection with the shapes the collector writes. None of these values is on the allow-list.
const TENANT = "11111111-2222-4333-8444-555555555555";
const GROUP = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const sample = (): FixtureFile[] => [
  { name: "staged.config.json", text: JSON.stringify({
    tenantId: TENANT, subscriptionId: "22222222-3333-4444-8555-666666666666", resourceGroup: "contoso-ccof-prod",
    stage1: { foundry: { accountName: "contoso-foundry-01", modelProviderData: { organizationName: "Contoso Ltd" } }, apimPublisherEmail: "ops@contoso.com" },
    groups: [{ groupDisplayName: "CONTOSO-AI-PILOT", displayName: "Contoso AI pilot", members: ["@me", "dev1@contoso.com"] }],
    backends: [{ url: "https://contoso-foundry-01.services.ai.azure.com/anthropic" }],
    client: { group: "CONTOSO-AI-PILOT" }, apim: { apiDisplayName: "Claude Messages (staged)" }, cosmos: { databaseName: "ccof" },
  }, null, 2) },
  { name: "state.json", text: JSON.stringify({
    target: { tenantId: TENANT },
    stages: { "1": { configHash: "a".repeat(64), outputs: { apimName: "contosoapim7x2", resolverAppName: "contoso-ccof-resolver",
      groupId: GROUP.toUpperCase(), cliClient: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
      apimId: "/subscriptions/22222222-3333-4444-8555-666666666666/resourceGroups/contoso-ccof-prod/providers/Microsoft.ApiManagement/service/contosoapim7x2" } } },
  }, null, 2) },
  { name: "gateway/api-policy.xml", text: `<policies><!-- configuration sha256 ${"a".repeat(64)} -->
  <openid-config url="https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration" />
  <set-url>https://contoso-ccof-resolver.azurewebsites.net/api/resolve</set-url>
  <value>${GROUP}</value></policies>` },
];

test("the pseudonymizer replaces every original consistently across files and keeps public values", () => {
  const { files, map, problems } = pseudonymize(sample());
  assert.deepEqual(problems, []);
  const all = files.map((f) => f.text).join("\n");
  for (const original of [TENANT, GROUP, "contoso", "Contoso Ltd", "ops@contoso.com", "dev1@contoso.com", "a".repeat(64)]) {
    assert.ok(!all.toLowerCase().includes(original.toLowerCase()), `${original} remains`);
  }
  assert.ok(all.includes("04b07795-8ddb-461a-bbee-02f9e1bf7b46"), "the public Azure CLI client ID is kept");
  assert.ok(all.includes("login.microsoftonline.com"), "public hosts are kept");
  assert.ok(all.includes("@me"), "the @me placeholder is kept");
  assert.ok(all.includes('"databaseName": "ccof"'), "contract names are kept");
  const tenantFake = map[TENANT].fake;
  for (const f of files) assert.ok(f.text.includes(tenantFake), `${f.name} uses the same fake tenant`);
  const resolverFake = map["contoso-ccof-resolver"].fake;
  assert.ok(files[1].text.includes(resolverFake) && files[2].text.includes(`${resolverFake}.azurewebsites.net`), "a name and its hostname map together");
  assert.ok(files[1].text.includes(map[GROUP].fake.toUpperCase()), "an upper-case GUID keeps its case");
  for (const f of files) assert.deepEqual(scanForLeaks(f.text), [], f.name);
});

test("a saved mapping gives the same fakes on a later run", () => {
  const first = pseudonymize(sample());
  const second = pseudonymize(sample(), first.map);
  assert.deepEqual(second.files, first.files);
});

test("the pseudonymizer refuses when an original value would remain", () => {
  const files = sample();
  files.push({ name: "notes.txt", text: "see contoso-ccof-prod2 for details" });
  const { problems } = pseudonymize(files);
  assert.ok(problems.some((p) => p.startsWith("notes.txt: an original rg remains")), problems.join("\n"));
});

test("file names are pseudonymized, and app and backend IDs are identifying", () => {
  const files = sample();
  files.push({ name: "functions/contoso-ccof-admin.json", text: JSON.stringify({ app: "contoso-ccof-admin", functions: [] }) });
  files.push({ name: "gateway/backends.json", text: JSON.stringify([{ backendId: "contoso-foundry-eus" }]) });
  files.push({ name: "gateway/fragment-outbound.xml", text: "<when condition='backendId == \"contoso-foundry-eus\"' />" });
  const { files: out, map, problems } = pseudonymize(files);
  assert.deepEqual(problems, []);
  const admin = out.find((f) => f.text.includes(map["contoso-ccof-admin"].fake));
  assert.equal(admin?.name, `functions/${map["contoso-ccof-admin"].fake}.json`);
  assert.ok(!out.some((f) => /contoso/i.test(f.name + f.text)), "no original name in any path or content");
});

test("any name that contains a known name's generated suffix is replaced too", () => {
  const files = sample();
  files[1].text = files[1].text.replace(/contosoapim7x2/g, "ccof-ab12cd34ef-apim");
  files.push({ name: "notes.txt", text: "the sync app ccof-ab12cd34ef-sync stores in ccofab12cd34efsyn" });
  const { files: out, problems } = pseudonymize(files);
  assert.deepEqual(problems, []);
  assert.ok(!out.some((f) => f.text.toLowerCase().includes("ab12cd34ef")), "no generated suffix remains");
});

test("guest UPNs, user-profile paths and the subscription name are replaced", () => {
  const files = sample();
  files.push({ name: "state2.json", text: JSON.stringify({
    subscription: { name: "CONTOSO-PROD-SUB-01", id: "22222222-3333-4444-8555-666666666666" },
    signedInUser: { upn: "jane.doe_contoso.com#EXT#@contosotenant.onmicrosoft.com" },
    client: { clientConfig: "C:\\Users\\janedoe\\ccof-private\\.staged-state\\generated\\client.json", other: "/home/janedoe/x" },
  }, null, 2) });
  const { files: out, problems } = pseudonymize(files);
  assert.deepEqual(problems, []);
  const text = out.map((f) => f.text).join("\n").toLowerCase();
  for (const original of ["contoso-prod-sub-01", "jane.doe", "contosotenant", "janedoe", "#ext#"]) assert.ok(!text.includes(original), `${original} remains`);
  assert.ok(scanForLeaks("C:\\Users\\janedoe\\x").length === 1, "the scan flags a real user-profile path");
  assert.ok(scanForLeaks("x_y.com#EXT#@t.onmicrosoft.com").length === 1, "the scan flags a guest UPN");
});

test("the leak scan catches unknown GUIDs, customer hosts, emails, JWTs and secrets", () => {
  assert.ok(scanForLeaks(TENANT).length === 1);
  assert.ok(scanForLeaks("https://contoso-api.azure-api.net/x").length >= 1);
  assert.ok(scanForLeaks("contact dev1@contoso.com").length === 1);
  assert.ok(scanForLeaks("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlX2hlcmU").length === 1);
  assert.ok(scanForLeaks("DefaultEndpointsProtocol=https;AccountKey=abc").length >= 1);
  assert.deepEqual(scanForLeaks("00000000-0000-4000-8000-000000100001 https://fake-name-01.azurewebsites.net person01@example.test"), []);
});

test("the CLI reads only from .env.customer-fixture and writes only to tests/fixtures/customer", () => {
  const cli = path.join(root, "harness", "pseudonymize-fixture.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  const outside = run("--from", "docs");
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /--from must be a collection under/);
  const wrongOut = run("--from", ".env.customer-fixture/x", "--out", "docs");
  assert.equal(wrongOut.status, 1);
  assert.match(wrongOut.stderr, /refused/);
});
