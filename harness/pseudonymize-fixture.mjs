#!/usr/bin/env node
// Customer fixture pseudonymizer (BUILD-PLAN P3, ADR-0056). Reads a collection made by
// harness/customer/Collect-CustomerFixture.ps1 under .env.customer-fixture/ and writes a pseudonymized copy to
// tests/fixtures/customer/. Tenant, subscription, object and group IDs, resource and display names, emails,
// hostnames and config hashes are replaced by stable fake values, consistently across every file; the mapping is
// kept (gitignored) in .env.customer-fixture/pseudonym-map.json so a re-collection reuses the same fakes.
// It writes nothing if any original value would remain or if the leak scan finds anything.
//
//   node harness/pseudonymize-fixture.mjs --from .env.customer-fixture/20261119-101500
//
// Exit codes: 0 written; 1 usage or input error; 2 refused (an original value or a leak would remain).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_ROOT = path.join(root, ".env.customer-fixture");
export const OUTPUT_DIR = path.join(root, "tests", "fixtures", "customer");

// Public, non-identifying values that may stay as they are.
const PUBLIC_GUIDS = new Set([
  "04b07795-8ddb-461a-bbee-02f9e1bf7b46", // Azure CLI public client
  "00000000-0000-0000-0000-000000000001", // Cosmos DB Built-in Data Reader
  "00000000-0000-0000-0000-000000000002", // Cosmos DB Built-in Data Contributor
]);
const FAKE_GUID = /^00000000-0000-4000-8000-\d{12}$/;
export const PUBLIC_HOSTS = new Set([
  "login.microsoftonline.com", "sts.windows.net", "management.azure.com", "api.loganalytics.io", "api.loganalytics.azure.com",
  "cognitiveservices.azure.com", "cosmos.azure.com", "graph.microsoft.com", "ai.azure.com", "monitor.azure.com",
  "schemas.microsoft.com", "www.w3.org", "aka.ms", "learn.microsoft.com", "json-schema.org", "api.applicationinsights.io",
  "docs.anthropic.com", "github.com",
]);
const AZURE_SUFFIX = String.raw`(?:scm\.)?(?:azurewebsites\.net|azure-api\.net|documents\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com|openai\.azure\.com|(?:blob|queue|table|file|dfs)\.core\.windows\.net|vault\.azure\.net|azurecr\.io|applicationinsights\.azure\.com)`;
const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HASH_RE = /\b[0-9a-f]{64}\b/gi;
const AZURE_HOST_RE = new RegExp(String.raw`\b([a-z0-9][a-z0-9-]*)\.${AZURE_SUFFIX}\b`, "gi");
const URL_HOST_RE = /\bhttps?:\/\/([a-z0-9.-]+)/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi;
const ARM_RE = /\/subscriptions\/[^/\s"'<>]+\/resourceGroups\/([^/\s"'<>?]+)(?:\/providers\/[^/\s"'<>]+\/[^/\s"'<>]+\/([^/\s"'<>?]+))?/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
const SECRET_RE = /AccountKey=|SharedAccessSignature|SharedAccessKey=|InstrumentationKey=|[?&]sig=[A-Za-z0-9%]{16,}|"(?:password|clientSecret|client_secret|primaryKey|secondaryKey)"\s*:/i;
// Config and state keys whose string values identify the customer. Keys ending in "Name" are added below.
const SENSITIVE_KEYS = new Set([
  "resourceGroup", "groupDisplayName", "displayName", "organizationName", "apimPublisherEmail", "apimPublisherName",
  "members", "adminEditors", "adminReaders", "group", "resourceName", "url", "endpoint", "gatewayUrl",
]);
const NOT_SENSITIVE_KEYS = new Set(["databaseName", "apiDisplayName", "roleName", "roleNames", "modelName", "deploymentName", "containerName", "configurationId"]);
const isFakeHost = (h) => /^fake/i.test(h) || /\.example\.test$/i.test(h);

export function isAllowedGuid(g) { const x = g.toLowerCase(); return PUBLIC_GUIDS.has(x) || FAKE_GUID.test(x); }

// Everything that must not reach a committed fixture. Used here before writing and by tests/harness-fixture-clean.test.ts.
export function scanForLeaks(text) {
  const problems = [];
  for (const m of text.matchAll(GUID_RE)) if (!isAllowedGuid(m[0])) problems.push(`guid ${m[0]}`);
  for (const m of text.matchAll(AZURE_HOST_RE)) if (!isFakeHost(m[1]) && !/^privatelink$/i.test(m[1])) problems.push(`azure host ${m[0]}`);
  for (const m of text.matchAll(URL_HOST_RE)) {
    const host = m[1].toLowerCase().replace(/\.$/, "");
    if (!PUBLIC_HOSTS.has(host) && !isFakeHost(host) && !host.startsWith("fake")) problems.push(`host ${host}`);
  }
  for (const m of text.matchAll(EMAIL_RE)) if (!/@example\.(test|com)$/i.test(m[0])) problems.push(`email ${m[0]}`);
  for (const m of text.matchAll(JWT_RE)) problems.push(`jwt ${m[0].slice(0, 12)}...`);
  const secret = text.match(SECRET_RE);
  if (secret) problems.push(`secret marker ${secret[0]}`);
  return problems;
}

function collectFromJson(value, key, add) {
  if (Array.isArray(value)) { for (const v of value) collectFromJson(v, key, add); return; }
  if (value && typeof value === "object") { for (const [k, v] of Object.entries(value)) collectFromJson(v, k, add); return; }
  if (typeof value !== "string" || !key || NOT_SENSITIVE_KEYS.has(key)) return;
  if (SENSITIVE_KEYS.has(key) || /Name$/.test(key)) {
    if (/^https?:\/\//i.test(value)) { const host = value.replace(/^https?:\/\//i, "").split(/[/:?]/)[0]; add(host.split(".")[0], "name"); }
    else add(value, key === "resourceGroup" ? "rg" : "name");
  }
}

export function findOriginals(files) {
  const found = new Map();
  const add = (value, kind) => {
    const v = value.trim();
    if (v.length < 4 || v.startsWith("@") || v.startsWith("REPLACE")) return;
    if (kind === "guid" && isAllowedGuid(v)) return;
    if ((kind === "name" || kind === "rg") && (/^fake/i.test(v) || PUBLIC_HOSTS.has(v.toLowerCase()))) return;
    const k = v.toLowerCase();
    if (!found.has(k)) found.set(k, { value: v, kind });
  };
  for (const { text, name } of files) {
    for (const m of text.matchAll(GUID_RE)) add(m[0], "guid");
    for (const m of text.matchAll(HASH_RE)) add(m[0], "hash");
    for (const m of text.matchAll(ARM_RE)) { add(decodeURIComponent(m[1]), "rg"); if (m[2]) add(decodeURIComponent(m[2]), "name"); }
    for (const m of text.matchAll(AZURE_HOST_RE)) if (!/^privatelink$/i.test(m[1])) add(m[1], "name");
    for (const m of text.matchAll(URL_HOST_RE)) {
      const host = m[1].toLowerCase();
      if (!PUBLIC_HOSTS.has(host) && !new RegExp(String.raw`\.${AZURE_SUFFIX}$`, "i").test(host)) add(host, "host");
    }
    for (const m of text.matchAll(EMAIL_RE)) add(m[0], "email");
    if (name.endsWith(".json")) { try { collectFromJson(JSON.parse(text), null, add); } catch { /* not JSON: regexes only */ } }
  }
  return found;
}

function fakeFor(kind, n, original) {
  const nn = String(n).padStart(2, "0");
  switch (kind) {
    case "guid": return `00000000-0000-4000-8000-${String(100000 + n).padStart(12, "0")}`;
    case "hash": return createHash("sha256").update(`ccof-fake-${n}`).digest("hex");
    case "rg": return `fake-rg-${nn}`;
    case "email": return `person${nn}@example.test`;
    case "host": return `fake-host-${nn}.example.test`;
    default:
      if (/\s/.test(original) || /[A-Z]/.test(original)) return `Fake Name ${nn}`;
      return /^[a-z0-9]+$/.test(original) ? `fakename${nn}` : `fake-name-${nn}`;
  }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function pseudonymize(files, existingMap = {}) {
  const map = { ...existingMap };
  const counters = {};
  for (const fake of Object.values(map)) counters[fake.kind] = Math.max(counters[fake.kind] ?? 0, fake.n);
  const originals = findOriginals(files);
  for (const [k, { value, kind }] of originals) {
    if (map[k]) continue;
    const n = (counters[kind] = (counters[kind] ?? 0) + 1);
    map[k] = { kind, n, fake: fakeFor(kind, n, value) };
  }
  const order = Object.keys(map).sort((a, b) => b.length - a.length);
  const out = files.map(({ name, text }) => {
    let t = text;
    for (const k of order) {
      const re = new RegExp(`(?<![A-Za-z0-9])${escape(k)}(?![A-Za-z0-9])`, "gi");
      t = t.replace(re, (m) => (m === m.toUpperCase() && m !== m.toLowerCase() && map[k].kind === "guid" ? map[k].fake.toUpperCase() : map[k].fake));
    }
    return { name, text: t };
  });
  const problems = [];
  for (const { name, text } of out) {
    const lower = text.toLowerCase();
    for (const k of order) if (lower.includes(k)) problems.push(`${name}: an original ${map[k].kind} remains (${map[k].fake})`);
    for (const p of scanForLeaks(text)) problems.push(`${name}: ${p}`);
  }
  return { files: out, map, problems };
}

function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((e) => {
    const full = path.join(dir, e);
    return statSync(full).isDirectory() ? listFiles(full, base) : [path.relative(base, full).replace(/\\/g, "/")];
  });
}

const inside = (child, parent) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); };

export function main(argv) {
  let from = null, mapPath = path.join(FIXTURE_ROOT, "pseudonym-map.json"), out = OUTPUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") from = argv[++i];
    else if (argv[i] === "--map") mapPath = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else { console.error(`unknown argument: ${argv[i]}`); return 1; }
  }
  if (!from) { console.error("Usage: node harness/pseudonymize-fixture.mjs --from .env.customer-fixture/<collection>"); return 1; }
  const src = path.resolve(from), dest = path.resolve(out), map = path.resolve(mapPath);
  if (!inside(src, FIXTURE_ROOT) || !existsSync(src)) { console.error(`refused: --from must be a collection under ${FIXTURE_ROOT}`); return 1; }
  if (path.relative(OUTPUT_DIR, dest) !== "") { console.error(`refused: output is always ${OUTPUT_DIR}`); return 1; }
  if (!inside(map, FIXTURE_ROOT)) { console.error(`refused: the mapping holds original values and stays under ${FIXTURE_ROOT}`); return 1; }

  const files = listFiles(src).filter((f) => /\.(json|xml|txt|kql)$/i.test(f))
    .map((name) => ({ name, text: readFileSync(path.join(src, name), "utf8").replace(/^\uFEFF/, "") }));
  const existing = existsSync(map) ? JSON.parse(readFileSync(map, "utf8")) : {};
  const result = pseudonymize(files, existing);
  if (result.problems.length) {
    console.error(`refused: nothing written. ${result.problems.length} problem(s):`);
    for (const p of result.problems.slice(0, 50)) console.error(`  ${p}`);
    return 2;
  }
  const staging = `${dest}.staging`;
  rmSync(staging, { recursive: true, force: true });
  for (const f of result.files) {
    const target = path.join(staging, f.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.text);
  }
  // Synthetic Cosmos documents stay unless the collection has real (pseudonymized) ones.
  const keepSynthetic = !result.files.some((f) => f.name.startsWith("cosmos/")) && existsSync(path.join(dest, "cosmos"));
  if (keepSynthetic) for (const f of listFiles(path.join(dest, "cosmos"))) {
    mkdirSync(path.join(staging, "cosmos", path.dirname(f)), { recursive: true });
    writeFileSync(path.join(staging, "cosmos", f), readFileSync(path.join(dest, "cosmos", f)));
  }
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  mkdirSync(path.dirname(map), { recursive: true });
  writeFileSync(map, JSON.stringify(result.map, null, 2));
  console.log(`Wrote ${result.files.length} file(s) to ${dest}${keepSynthetic ? " (synthetic Cosmos documents kept)" : ""}.`);
  console.log(`Replaced ${Object.keys(result.map).length} distinct value(s). Read every file before committing.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
