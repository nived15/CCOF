// Version-skew artifacts (BUILD-PLAN P5): what one version of CCOF writes and answers, produced with that version's
// own code from its own test helpers. Run against the current repository by tests/harness-version-skew.test.ts and
// against the customer's deployed commit by harness/capture-version.mjs (in a temporary git worktree).
//
// The chain is the one tests/budget-acceptance.test.ts exercises: group documents → the sync's planSync
// (entitlement documents) → the reconciler (budget-state documents) → the resolver's HTTP handler (replies), plus the
// gateway policy that version renders.
import path from "node:path";
import { pathToFileURL } from "node:url";

type Doc = Record<string, unknown>;
export interface Documents { projects: Doc[]; entitlements: Doc[]; budgetStates: Doc[]; aggregateStates: Doc[] }
export interface Scenario { name: string; request: Doc; documents: Documents; status: number; body: Doc }
export interface Artifacts { scenarios: Scenario[]; policyXml: string }

export const SKEW_NOW = new Date("2026-10-23T12:00:00Z");
export const UNKNOWN_PERSON = "99999999-9999-4999-8999-999999999999";

// The resolver's readiness for every scenario: budget-state enforcement with complete usage required.
export const SKEW_ENFORCEMENT = { mode: "budget-state", staleness: { graceSeconds: 0, hardLimitSeconds: 0 }, requireCompleteUsage: true };

// Reads over a set of documents, in the shape the resolver's fakeReads helper takes.
export function readsOver(d: Documents) {
  return {
    readEntitlement: async (personId: string) => d.entitlements.find((e) => e.personId === personId) ?? null,
    readBudgetState: async (personId: string, projectId: string) =>
      d.budgetStates.find((b) => b.personId === personId && b.projectId === projectId) ?? null,
    readAggregateBudgetState: async (scopeId: string) => d.aggregateStates.find((g) => g.scopeId === scopeId) ?? null,
  };
}

export async function capture(root: string): Promise<Artifacts> {
  const load = (rel: string) => import(pathToFileURL(path.join(root, rel)).href);
  const [{ planSync }, { readProjectDocument }, { reconcile }, { readRegistry }, { classifyRow }, { budgetPeriodAt },
    { handleResolveRequest }, { renderPolicy }, groups, families, rec, res, gw] = await Promise.all([
    load("src/sync/plan.ts"), load("src/sync/projects.ts"), load("src/reconciler/reconcile.ts"), load("src/reconciler/registry.ts"),
    load("src/reconciler/price-rows.ts"), load("src/reconciler/period.ts"), load("src/resolver/http-handler.ts"),
    load("infra/gateway/render.ts"), load("tests/helpers/group-fixtures.ts"), load("tests/helpers/sync-fakes.ts"),
    load("tests/helpers/reconciler-fixtures.ts"), load("tests/helpers/resolver-fixtures.ts"), load("tests/helpers/gateway-fixtures.ts"),
  ]);
  const card = rec.packagedRateCard();
  const schedule = rec.packagedSchedule(card);
  const period = budgetPeriodAt(SKEW_NOW);
  const dollars = (amount: string) => ({ amount, currency: "USD", period: "monthly" });
  const policy = families.familyPolicy(["claude-haiku-4-5"]);

  function world(aRequests: number, bRequests: number, partial: boolean): Documents {
    const projects: Doc[] = [groups.GROUP_A, groups.GROUP_B].map((id: string, i: number) => groups.groupDoc(id, {
      priority: i + 1, familyPolicy: policy, budget: { mode: "cap", perUser: dollars("10"), groupCap: dollars("20") },
    }));
    const sync = planSync({
      projects: projects.map(readProjectDocument), existing: [], memberTypes: ["user"],
      groups: new Map(projects.map((d) => [String(d.id), { ok: true, groupId: String(d.id),
        members: [{ id: rec.PERSON_A, kind: "user" }, { id: rec.PERSON_B, kind: "user" }], pages: 1, retries: 0 }])),
      removalLimits: { maxRemovalsPerRun: 10, maxRemovalFraction: 0.5 }, now: SKEW_NOW,
    });
    const entitlements: Doc[] = sync.writes.map((w: { document: Doc }) => w.document);
    const rows = [groups.GROUP_A, groups.GROUP_B].flatMap((projectId: string, i: number) =>
      Array.from({ length: i ? bRequests : aRequests }, () => classifyRow(rec.ledgerRow({
        timestamp: "2026-10-23T11:55:00Z", ingestedAt: "2026-10-23T11:56:00Z", projectId, classification: "group",
        personId: rec.PERSON_A, model: "claude-haiku-4-5", input: 100000, output: 0, cacheRead: partial ? null : 0,
        cacheWrite5m: 0, cacheWrite1h: 0, inferenceGeo: "global",
      }), period, card, schedule)));
    const result = reconcile({ registry: readRegistry(projects, entitlements), rows, rateCard: card,
      contractScheduleVersion: schedule.version, period, computedAt: SKEW_NOW, validUntil: new Date(SKEW_NOW.getTime() + 600000) });
    return { projects, entitlements, budgetStates: result.persons.map((p: { doc: Doc }) => p.doc),
      aggregateStates: result.groups.map((g: { doc: Doc }) => g.doc) };
  }

  const plans: { name: string; world: [number, number, boolean]; request: Doc }[] = [
    { name: "allow-explicit-group", world: [1, 0, false], request: { personId: rec.PERSON_A, projectId: groups.GROUP_A } },
    { name: "allow-automatic-selection", world: [80, 20, false], request: { personId: rec.PERSON_A } },
    { name: "refuse-budget-exhausted", world: [100, 0, false], request: { personId: rec.PERSON_A, projectId: groups.GROUP_A } },
    { name: "refuse-no-entitlement", world: [1, 0, false], request: { personId: UNKNOWN_PERSON } },
    { name: "unavailable-incomplete-usage", world: [1, 0, true], request: { personId: rec.PERSON_A, projectId: groups.GROUP_A } },
  ];
  const scenarios: Scenario[] = [];
  for (const p of plans) {
    const documents = world(...p.world);
    const reply = await handleResolveRequest({ platformAuthEnabled: true, authenticatedPrincipal: true, body: p.request }, {
      readiness: { ready: true, requestDeadlineMs: 5000, reads: res.fakeReads(readsOver(documents)), budgetEnforcement: SKEW_ENFORCEMENT },
      now: () => SKEW_NOW, log: () => {},
    });
    scenarios.push({ name: p.name, request: p.request, documents, status: reply.status, body: reply.jsonBody });
  }
  return { scenarios, policyXml: renderPolicy(gw.sampleConfig()).policyXml };
}
