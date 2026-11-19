// Scenario engine (BUILD-PLAN P6). Runs tests/scenarios/*.json through the real code: the rendered gateway policy's
// C# expressions (compiled, tests/helpers/policy-csharp.ts), the resolver's HTTP handler, the sync planner, the
// reconciler and the cost module. A scenario names its layer; the engine builds the documents a deployment would hold
// from the scenario's `given`, runs `when`, and returns the observed `then` for comparison.
import { Decimal } from "decimal.js";
import { attr, descendants, parseApimXml, textOf, type XmlElement } from "../../infra/gateway/apim-xml.ts";
import type { GatewayConfig } from "../../infra/gateway/config.ts";
import { renderPolicy } from "../../infra/gateway/render.ts";
import { readGroupRegistration } from "../../src/contracts/group-registration.ts";
import { parseRateCardJson } from "../../src/cost/rate-card.ts";
import { computeSpend } from "../../src/reconciler/compute-ceiling.ts";
import { readFileSync } from "node:fs";
import type { LedgerRow } from "../../src/reconciler/ledger.ts";
import { budgetPeriodAt } from "../../src/reconciler/period.ts";
import { classifyRow } from "../../src/reconciler/price-rows.ts";
import { reconcile, type BudgetGuard } from "../../src/reconciler/reconcile.ts";
import { LedgerReadError, parseLedgerResponse } from "../../src/reconciler/ledger.ts";
import { runReconciler as runReconcilerJob, type RunAssets } from "../../src/reconciler/run.ts";
import { readReconcilerSettings } from "../../src/reconciler/settings.ts";
import { FakeAzure, LEDGER_KQL, ManualClock, ledgerBody } from "./reconciler-fakes.ts";
import { readRegistry } from "../../src/reconciler/registry.ts";
import { handleResolveRequest } from "../../src/resolver/http-handler.ts";
import { planSync } from "../../src/sync/plan.ts";
import { readProjectDocument } from "../../src/sync/projects.ts";
import { sampleConfig } from "./gateway-fixtures.ts";
import { groupDoc } from "./group-fixtures.ts";
import { runExpressions, type Vector } from "./policy-csharp.ts";
import { entitlementDoc, ledgerRow, packagedRateCard, packagedSchedule, pilotProject, PERSON_A as REC_PERSON, validSettings } from "./reconciler-fixtures.ts";
import { fakeReads } from "./resolver-fixtures.ts";
import { familyPolicy, GROUP_PRM, GROUP_STD, PERSON_A, PERSON_B, PERSON_C, projectDoc } from "./sync-fakes.ts";

type Obj = Record<string, any>;
export interface Scenario { id: string; title: string; source: string; invariants: string[]; layer: string; given: Obj; when: Obj; then: Obj; note?: string }

export const CALLER = PERSON_A;
export const STRANGER = "99999999-9999-4999-8999-999999999999";
export const GROUPS: Record<string, string> = {
  alpha: "11111111-1111-4111-8111-111111111111", beta: "55555555-5555-4555-8555-555555555555", gamma: "66666666-6666-4666-8666-666666666666",
};
const card = packagedRateCard();
const schedule = packagedSchedule(card);
const NOW = new Date("2026-10-23T12:00:00Z");
const ENFORCEMENT = { mode: "budget-state", staleness: { graceSeconds: 0, hardLimitSeconds: 0 }, requireCompleteUsage: true };
const usdToTokens = (usd: string) => new Decimal(usd).mul(1_000_000).toNumber(); // Haiku 4.5 input: USD 1 per million tokens
const ccuToUsd = (ccu: string) => new Decimal(ccu).div(100).toString();

// ---------------------------------------------------------------- documents a deployment holds

function budgetOf(b: Obj | string) {
  return typeof b === "string" ? { amount: b, currency: "USD", period: "monthly" } : { period: "monthly", ...b };
}

function policyFor(models: string[]) {
  const plain = models.filter((m) => !m.startsWith("claude-mythos"));
  const policy = familyPolicy(plain.length ? plain : ["claude-haiku-4-5"]);
  if (!plain.length) delete (policy.families as Obj).haiku;
  const mythos = models.filter((m) => m.startsWith("claude-mythos"));
  if (mythos.length) (policy.families as Obj).mythos = { models: mythos, person: unlimited(), group: unlimited() };
  return policy;
}
const unlimited = () => ({ tokensPerMinute: null, tokenQuota: null, tokenQuotaPeriod: null });

interface Row { group: string; usd: string; at?: string; cacheUnknown?: boolean }

// The packaged rate card with one entry closed and a new one appended (instructions rule 5), when a scenario asks.
function rateCardFor(change?: Obj) {
  if (!change) return card;
  const raw = JSON.parse(readFileSync(new URL("../../config/rate-card.json", import.meta.url), "utf8"));
  const old = raw.entries.find((e: Obj) => e.model === change.model && e.effectiveTo === null);
  const next = structuredClone(old);
  old.effectiveTo = change.effectiveFrom;
  next.effectiveFrom = change.effectiveFrom;
  for (const tier of next.promptTiers) tier.rates.input = change.input;
  raw.entries.push(next);
  return parseRateCardJson(JSON.stringify(raw));
}

function documents(given: Obj, rows: Row[], computedAt: Date, guard?: BudgetGuard) {
  const rates = rateCardFor(given.rateCardChange);
  const onboarded = Object.entries((given.groups ?? {}) as Record<string, Obj>).map(([name, g]) => groupDoc(GROUPS[name], {
    displayName: g.displayName ?? `Group ${name}`, priority: g.priority ?? 1, familyPolicy: policyFor(g.models ?? ["claude-haiku-4-5"]),
    budget: { mode: "autoScale", perUser: budgetOf(g.budget ?? "10"), groupCap: null },
    restrictedFamiliesApproved: g.restrictedFamiliesApproved ?? false,
  }));
  // An administrator cannot register a group document the contract refuses (SEC-05): it never reaches Cosmos.
  const registered = onboarded.filter((d) => readGroupRegistration(d).ok);
  const callerIn = new Set<string>(given.callerIn ?? Object.keys(given.groups ?? {}));
  const sync = planSync({
    projects: registered.map(readProjectDocument), existing: [], memberTypes: ["user"],
    groups: new Map(registered.map((d) => [String(d.id), { ok: true as const, groupId: String(d.id), pages: 1, retries: 0,
      members: [...(Object.keys(GROUPS).some((n) => GROUPS[n] === d.id && callerIn.has(n)) ? [{ id: CALLER, kind: "user" as const }] : []), { id: PERSON_B, kind: "user" as const }] }])),
    removalLimits: { maxRemovalsPerRun: 10, maxRemovalFraction: 0.5 }, now: computedAt,
  });
  const entitlements = sync.writes.map((w) => w.document as unknown as Obj);
  const period = budgetPeriodAt(computedAt);
  // The ledger query reads only the budget period (analytics/ledger.kql): earlier rows never reach the reconciler.
  const inPeriod = rows.filter((r) => { const t = Date.parse(r.at ?? "2026-10-23T11:00:00Z"); return t >= period.start.getTime() && t < period.end.getTime(); });
  const classified = inPeriod.map((r) => classifyRow(ledgerRow({
    timestamp: r.at ?? "2026-10-23T11:00:00.0000000Z", ingestedAt: r.at ?? "2026-10-23T11:00:00.0000000Z", projectId: GROUPS[r.group],
    classification: "group", personId: CALLER, model: "claude-haiku-4-5", input: usdToTokens(r.usd), output: 0,
    cacheRead: r.cacheUnknown ? null : 0, cacheWrite5m: r.cacheUnknown ? null : 0, cacheWrite1h: r.cacheUnknown ? null : 0, inferenceGeo: "global",
  }) as LedgerRow, period, rates, schedule));
  const result = reconcile({ registry: readRegistry(registered, entitlements), rows: classified, rateCard: rates,
    contractScheduleVersion: schedule.version, period, computedAt, validUntil: new Date(computedAt.getTime() + 600000), ...(guard ? { guard } : {}) });
  return { registered, entitlements, persons: result.persons.map((p) => p.doc as unknown as Obj), groups: result.groups.map((g) => g.doc as unknown as Obj) };
}

const spendRows = (spend: Obj = {}): Row[] => Object.entries(spend).map(([group, usd]) => ({ group, usd: String(usd) }));

// ---------------------------------------------------------------- gateway: policy C# + resolver

const policyXml = renderPolicy(sampleConfig() as GatewayConfig).policyXml;
const all = descendants(parseApimXml(policyXml));
const variable = (name: string, last = false) => {
  const found = all.filter((e) => e.name === "set-variable" && attr(e, "name") === name);
  if (!found.length) throw new Error(`policy has no set-variable ${name}`);
  return attr(last ? found.at(-1)! : found[0], "value")!;
};
const headerInvalid = (() => {
  const when = all.find((e) => e.name === "when" && e.children.some((c) => (c as XmlElement).name === "set-variable"
    && attr(c as XmlElement, "name") === "ccofRefusal" && attr(c as XmlElement, "value") === "project_header_invalid")) as XmlElement;
  return attr(when, "condition")!;
})();
const jwt = all.find((e) => e.name === "validate-jwt")!;
const audiences = descendants(jwt).filter((e) => e.name === "audience").map((e) => textOf(e).trim());
const headerName = (sampleConfig() as GatewayConfig).resolver.projectHeaderName;

export async function runGateway(scenarios: Scenario[]): Promise<Obj[]> {
  const out: Obj[] = scenarios.map(() => ({}));
  const live = scenarios.map((s, i) => ({ s, i })).filter(({ s, i }) => {
    const token = s.when.token ?? "valid";
    if (token === "valid") return true;
    // APIM's own validate-jwt answers before any policy expression runs; the rendered policy is what is checked.
    const rejects = attr(jwt, "failed-validation-httpcode") === "401" && attr(jwt, "header-name") === "Authorization"
      && (token === "none" || !audiences.includes(s.when.audience ?? "https://management.azure.com"));
    out[i] = { status: rejects ? 401 : 200 };
    return false;
  });
  const headersOf = (s: Scenario) => Object.fromEntries(Object.entries((s.when.headers ?? {}) as Obj).map(([k, v]) => [k === "selector" ? headerName : k, Array.isArray(v) ? v.join(",") : String(v)]));
  const selectors = runExpressions({ Selector: variable("ccofSelector") }, live.map(({ s }) => ({ label: s.id, method: "Selector", headers: headersOf(s), expected: null }))) as string[];
  const invalid = runExpressions({ HeaderInvalid: headerInvalid }, live.map(({ s }, k) => ({ label: s.id, method: "HeaderInvalid", vars: { ccofRefusal: "", ccofSelector: selectors[k] }, expected: null }))) as boolean[];

  const replies: (Obj | null)[] = [];
  for (const [k, { s }] of live.entries()) {
    if (invalid[k]) { replies.push(null); continue; }
    const d = documents(s.given, spendRows(s.given.spend).concat((s.given.partialUsage ?? []).map((g: string) => ({ group: g, usd: "0.01", cacheUnknown: true }))), NOW);
    if (s.given.dropBudgetState) d.persons = [];
    const auth = s.given.platformAuth ?? "on";
    const logs: string[] = [];
    const request = { personId: s.when.caller === "stranger" ? STRANGER : CALLER, ...(selectors[k] ? { projectId: selectors[k] } : {}), ...(s.when.extraBody ?? {}) };
    const reply = await handleResolveRequest({ platformAuthEnabled: auth !== "off", authenticatedPrincipal: auth === "on", body: request }, {
      readiness: { ready: true, requestDeadlineMs: 5000, budgetEnforcement: ENFORCEMENT, reads: fakeReads({
        readEntitlement: async (p: string) => d.entitlements.find((e) => e.personId === p) ?? null,
        readBudgetState: async (p: string, pr: string) => d.persons.find((b) => b.personId === p && b.projectId === pr) ?? null,
        readAggregateBudgetState: async (sc: string) => d.groups.find((g) => g.scopeId === sc) ?? null }) },
      now: () => NOW, log: (line: string) => logs.push(line),
    } as unknown as Parameters<typeof handleResolveRequest>[1]);
    // given.replyPatch: fields a different resolver version would send, applied to a 200 before the gateway reads it.
    const body = reply.status === 200 && s.given.replyPatch ? { ...(reply.jsonBody as Obj), ...s.given.replyPatch } : reply.jsonBody;
    replies.push({ status: reply.status, body, logs });
  }
  const pending = live.filter((_, k) => replies[k]);
  const results = runExpressions({ Resolve: variable("ccofResolverResult") }, pending.map(({ s }) => {
    const r = replies[live.findIndex((l) => l.s === s)]!;
    return { label: s.id, method: "Resolve", json: true, expected: null, vars: { ccofResolverResponse: { status: r.status, body: r.body } } };
  })) as Obj[];
  const refusal: string[] = live.map((_, k) => (invalid[k] ? "project_header_invalid" : ""));
  const familyVectors: Vector[] = [];
  pending.forEach(({ s }, p) => {
    const k = live.findIndex((l) => l.s === s);
    const r = results[p];
    if (r?.o === "refuse") refusal[k] = String(r.c);
    else if (r?.o !== "allow") refusal[k] = "entitlement_unavailable";
    else familyVectors.push({ label: String(k), method: "Family", expected: null, vars: { ccofFamilyPolicy: replies[k]!.body.familyPolicy,
      ccofClassification: replies[k]!.body.classification, ccofRestrictedFamiliesApproved: replies[k]!.body.restrictedFamiliesApproved, ccofModel: s.when.model } });
  });
  const families = familyVectors.length ? runExpressions({ Family: variable("ccofModelFamily", true) }, familyVectors) as string[] : [];
  familyVectors.forEach((v, f) => { if (families[f] === "") refusal[Number(v.label)] = "model_family_not_allowed"; });
  const refused = live.map((x, k) => ({ ...x, k })).filter(({ k }) => refusal[k] !== "");
  const mapped = refused.length ? runExpressions({ Status: variable("ccofRefusalStatus"), Body: variable("ccofRefusalBody") }, refused.flatMap(({ s, k }) => [
    { label: `${s.id} status`, method: "Status", vars: { ccofRefusal: refusal[k] }, expected: null },
    { label: `${s.id} body`, method: "Body", json: true, expected: null, vars: { ccofRefusal: refusal[k], ccofSelector: selectors[k], ccofModel: s.when.model ?? "" } },
  ])) : [];
  live.forEach(({ i }, k) => {
    const reply = replies[k];
    const r = refused.findIndex((x) => x.k === k);
    const groupName = Object.keys(GROUPS).find((n) => GROUPS[n] === reply?.body?.projectId) ?? null;
    out[i] = r >= 0
      ? { status: mapped[2 * r], errorType: (mapped[2 * r + 1] as Obj)?.error?.type ?? null, refusal: refusal[k] }
      : { status: 200, group: groupName, chargedTo: reply?.body?.personId === CALLER ? "caller" : reply?.body?.personId };
    if (reply) out[i].logs = reply.logs;
  });
  // when.cachedPatch: is this allow, with those fields changed, still a valid cached decision (DATA-01)?
  const cacheChecks = pending.map(({ s }, p) => ({ s, p })).filter(({ s, p }) => s.when.cachedPatch && results[p]?.o === "allow");
  const cacheValid = cacheChecks.length ? runExpressions({ Cached: variable("ccofCachedDecisionValid") }, cacheChecks.map(({ s, p }) => ({
    label: s.id, method: "Cached", expected: null, vars: { ccofCached: JSON.stringify({ ...results[p], d: { ...results[p].d, ...s.when.cachedPatch } }) },
  }))) as boolean[] : [];
  cacheChecks.forEach(({ s }, c) => { out[scenarios.indexOf(s)].cachedDecisionValid = cacheValid[c]; });
  // when.cachedRefusalCodes: the code a cached refusal entry yields (SEC-03: anything unknown collapses).
  const withCodes = scenarios.filter((s) => Array.isArray(s.when.cachedRefusalCodes));
  if (withCodes.length) {
    const expr = attr(all.find((e) => e.name === "set-variable" && attr(e, "name") === "ccofRefusal" && (attr(e, "value") ?? "").includes('["c"]'))!, "value")!;
    const vectors = withCodes.flatMap((s) => (s.when.cachedRefusalCodes as string[]).map((code) => ({ label: `${s.id} ${code}`, method: "Cached", expected: null, vars: { ccofCached: JSON.stringify({ o: "refuse", c: code }) } })));
    const codes = runExpressions({ Cached: expr }, vectors) as string[];
    let n = 0;
    for (const s of withCodes) out[scenarios.indexOf(s)].cachedRefusals = Object.fromEntries((s.when.cachedRefusalCodes as string[]).map((code) => [code, codes[n++]]));
  }
  return out;
}

// ---------------------------------------------------------------- reconciler: pricing and budget state

export function runReconciler(s: Scenario): Obj {
  const computedAt = new Date(s.given.computedAt ?? "2026-10-23T12:00:00Z");
  const rows: Row[] = (s.given.rows ?? []).map((r: Obj) => ({ group: "alpha", usd: String(r.usd), at: r.at, cacheUnknown: r.cacheUnknown }));
  const given = { groups: { alpha: { budget: s.when.budget ?? s.given.budget ?? "10" } }, rateCardChange: s.given.rateCardChange };
  const d = documents(given, rows, computedAt, s.given.guard);
  const doc = d.persons.find((p) => p.personId === CALLER)!;
  return {
    spentUsd: ccuToUsd(doc.spentCcu), budgetUsd: ccuToUsd(doc.budgetCcu), exhausted: doc.exhausted,
    ceiling: doc.realtimeCeilingTokensPerMinute === 0 ? "zero" : "positive", completeness: doc.completeness,
    ...("warning" in doc ? { warning: doc.warning, projectedUsd: ccuToUsd(doc.projectedCcu) } : {}),
  };
}

export function runPricing(s: Scenario): Obj {
  try {
    const usage = Object.entries(s.when.tokens as Record<string, number>).map(([category, tokens]) => ({ model: s.given.model, category, tokens }));
    return { usd: computeSpend(usage as never, { [s.given.model]: s.given.ratesPerThousand }).toString() };
  } catch (e) {
    return { error: (e as Error).message.split(";")[0] };
  }
}

// ---------------------------------------------------------------- sync planner

const PERSONS: Record<string, string> = { A: PERSON_A, B: PERSON_B, C: PERSON_C };
const CLASSIFICATION_GROUPS: Record<string, string> = { STD: GROUP_STD, PRM: GROUP_PRM };

export function runSync(s: Scenario): Obj {
  const now = new Date("2026-10-11T12:00:00Z");
  const reads = new Map(Object.entries(s.given.reads as Record<string, Obj>).map(([code, r]) => [CLASSIFICATION_GROUPS[code], r.failed
    ? { ok: false as const, groupId: CLASSIFICATION_GROUPS[code], reason: "graph_permission_missing" as const, httpStatus: 403, graphErrorCode: "Authorization_RequestDenied", retries: 0 }
    : { ok: true as const, groupId: CLASSIFICATION_GROUPS[code], pages: 1, retries: 0, members: (r.members as (string | Obj)[]).map((m) => typeof m === "string"
      ? { id: PERSONS[m], kind: "user" as const } : { id: PERSONS[m.id], kind: "user" as const, accountEnabled: m.accountEnabled }) }]));
  const existing = Object.entries((s.given.existing ?? {}) as Record<string, string[]>).map(([p, codes]) => ({ etag: `"e-${p}"`, doc: {
    id: PERSONS[p], personId: PERSONS[p], generation: 2, lastVerifiedAt: "2026-10-10T08:00:00.000Z",
    projectMemberships: codes.map((code) => ({ projectId: "PILOT1", classification: code, classificationGroupId: CLASSIFICATION_GROUPS[code],
      familyPolicy: familyPolicy(["claude-haiku-4-5"]), backendId: "foundry-sample-hub", aggregateMode: "notify",
      denormalizedAt: "2026-10-10T08:00:00.000Z", joinedAt: "2026-10-10T08:00:00.000Z", status: "active" })) } }));
  const plan = planSync({ projects: [readProjectDocument(projectDoc("PILOT1"))], groups: reads, existing, memberTypes: ["user"],
    removalLimits: s.given.removalLimits ?? { maxRemovalsPerRun: 10, maxRemovalFraction: 0.5 }, now });
  const holdings: Record<string, string[]> = {};
  for (const [name, id] of Object.entries(PERSONS)) {
    const written = plan.writes.find((w) => w.personId === id)?.document;
    const before = existing.find((e) => e.doc.personId === id)?.doc;
    const doc = (written ?? before) as Obj | undefined;
    if (doc) holdings[name] = (doc.projectMemberships as Obj[]).map((m) => m.classification).sort();
  }
  return {
    holdings, writes: plan.writes.length, projectsFrozen: plan.counts.projectsFrozen,
    events: [...new Set(plan.events.map((e) => `${e.event}:${e.reason}`))].sort(),
  };
}

// ---------------------------------------------------------------- reconciler run: reads before writes (MON-06)

export async function runReconcilerRun(s: Scenario): Promise<Obj> {
  const row = { input: 1000, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, inferenceGeo: "global" };
  const failures: Record<string, Obj> = {
    none: {},
    ledger: { ledger: async () => { throw new LedgerReadError("ledger_http_error", "503"); } },
    registry: { failProjects: new Error("cosmos read failed") },
    entitlements: { failEntitlements: new Error("cosmos read failed") },
  };
  const azure = new FakeAzure({ projects: [pilotProject()], entitlements: [entitlementDoc(REC_PERSON, [{ projectId: "CCOFPILOT01", classification: "STD" }])],
    ledger: ledgerBody([ledgerRow(row)]), ...failures[s.when.failingRead] });
  const read = readReconcilerSettings(validSettings());
  if (!read.ok) throw new Error("reconciler settings");
  const assets: RunAssets = { rateCard: card, schedule, ledgerKql: LEDGER_KQL };
  const lines: string[] = [];
  await runReconcilerJob(read.settings, assets, azure.deps(), { now: new ManualClock("2026-10-11T13:00:00.000Z").now, newRunId: () => "run-1", log: (l) => lines.push(l) });
  const run = lines.map((l) => JSON.parse(l) as Obj).find((l) => l.schema === "ccof.reconciler.run.v1");
  return { writes: azure.writeCount, outcome: run?.outcome ?? null };
}
// ---------------------------------------------------------------- recorded ledger: money from a real query response

export function runLedger(s: Scenario): Obj {
  const body = JSON.parse(readFileSync(new URL(`../fixtures/${s.given.fixture}`, import.meta.url), "utf8"));
  const period = budgetPeriodAt(new Date(s.given.computedAt));
  const rows = parseLedgerResponse(body, 100000).map((r) => classifyRow(r, period, card, schedule));
  const counts: Record<string, number> = { priced: 0, partial: 0, unpriced: 0, no_usage: 0 };
  let ccu = new Decimal(0), listCcu = new Decimal(0);
  for (const r of rows) {
    counts[r.outcome.kind]++;
    if (r.outcome.kind === "priced" || r.outcome.kind === "partial") { ccu = ccu.add(r.outcome.ccu); listCcu = listCcu.add(r.outcome.listCcu); }
  }
  return { rows: rows.length, ...counts, spentUsd: ccu.div(100).toString(), listUsd: listCcu.div(100).toString() };
}