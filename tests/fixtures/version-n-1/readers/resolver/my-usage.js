// The caller's own budget figures (owner request 2026-10-23; docs/USAGE.md). The gateway calls
// POST /api/me/usage with the person ID it took from the caller's validated token (oid); this module
// reads only that person's documents and their scopes' totals, all by point read:
//   - entitlement/<personId>                       which scopes the person is in now (partition /personId),
//   - budgetState/<personId>:<projectId>           the reconciler's spend and budget (partition /personId),
//   - aggregateBudgetState/<projectId>:<code>      the scope's remaining budget, only when the deployment allows
//                                                  it (partition /scopeId, the person's own scope).
// Amounts are the reconciler's exact decimal strings (src/reconciler/reconcile-person.ts); USD is derived at
// 100 CCU = 1 USD (src/cost/budget-units.ts). Figures are as of the reconciler's last run (computedAt) and
// cover priced requests only, so spend is a lower bound. A failed read fails the whole answer: partial
// figures could read as "nothing spent".
import { ccuToUsd } from "../cost/budget-units.js";
import { Money } from "../cost/money.js";
import { checkEntitlementRecord } from "./freshness.js";
export const USAGE_SCHEMA = "ccof.usage.v1";
// A person is in a handful of scopes; the bound keeps one request to a known number of reads.
export const MAX_USAGE_SCOPES = 25;
export class UsageReadError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
// A non-negative plain decimal, as Decimal.toFixed() writes it.
const DECIMAL = /^\d+(\.\d+)?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const decimalOf = (value) => (typeof value === "string" && DECIMAL.test(value) ? new Money(value) : null);
const timestampOf = (value) => (typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) ? value : null);
const amount = (ccu) => ({ ccu: ccu.toFixed(), usd: ccuToUsd(ccu).toFixed() });
const percent = (spent, budget) => budget.isZero() ? null : Number(spent.dividedBy(budget).times(100).toDecimalPlaces(1).toFixed());
const remainingOf = (spent, budget) => (spent.greaterThan(budget) ? new Money(0) : budget.minus(spent));
function personFigures(doc, personId, m, period) {
    const empty = { spent: null, budget: null, remaining: null, percentUsed: null, exhausted: null, period, asOf: null, completeness: null };
    if (doc === null || doc === undefined)
        return { status: "not_computed", ...empty };
    // The document must be this person's, for this scope: a state left from another classification of the
    // same project (budgetState's id is <personId>:<projectId>) is not this scope's figure.
    if (!isObject(doc) || doc.personId !== personId || doc.projectId !== m.projectId || doc.classification !== m.classification)
        return { status: "invalid", ...empty };
    if (doc.period !== period)
        return { status: "not_computed", ...empty };
    const spent = decimalOf(doc.spentCcu);
    const budget = decimalOf(doc.budgetCcu);
    const asOf = timestampOf(doc.computedAt);
    const completeness = doc.completeness === "complete" || doc.completeness === "partial" ? doc.completeness : null;
    if (!spent || !budget || !asOf || !completeness || typeof doc.exhausted !== "boolean")
        return { status: "invalid", ...empty };
    const guarded = "warning" in doc || "projectedCcu" in doc;
    const projected = decimalOf(doc.projectedCcu);
    if (guarded && (typeof doc.warning !== "boolean" || !projected))
        return { status: "invalid", ...empty };
    return {
        status: "current",
        spent: amount(spent),
        budget: amount(budget),
        remaining: amount(remainingOf(spent, budget)),
        percentUsed: percent(spent, budget),
        exhausted: doc.exhausted,
        period,
        asOf,
        completeness,
        ...(guarded ? { warning: doc.warning, projectedPercent: percent(projected, budget) } : {}),
    };
}
// The scope's remaining budget (src/reconciler/reconcile-group.ts), and nothing else: no spend, cap, mode,
// member count or other per-person figure. The aggregate document has no period field, so its computedAt
// must fall in this UTC month; before the first run of a month the previous month's figure is not shown.
function groupRemaining(doc, scopeId, period) {
    if (!isObject(doc) || doc.scopeId !== scopeId)
        return null;
    const spent = decimalOf(doc.spentCcu);
    const budget = doc.budgetCcu === null ? null : decimalOf(doc.budgetCcu);
    const asOf = timestampOf(doc.computedAt);
    if (!spent || (doc.budgetCcu !== null && !budget) || !asOf || new Date(asOf).toISOString().slice(0, 7) !== period)
        return null;
    return { remaining: budget ? amount(remainingOf(spent, budget)) : null };
}
export async function readMyUsage(personId, deps, options) {
    const { now, showGroupTotals, signal } = options;
    // The budget period label, "YYYY-MM" in UTC, as the reconciler writes it (src/reconciler/period.ts).
    const period = now.toISOString().slice(0, 7);
    const base = { schema: USAGE_SCHEMA, period, groupTotals: showGroupTotals ? "shown" : "hidden" };
    const record = await deps.readEntitlement(personId, signal);
    if (!record)
        return { ...base, truncated: false, scopes: [] };
    const verdict = checkEntitlementRecord(record, now.getTime());
    if (!verdict.usable) {
        if (verdict.reason === "entitlement_legacy_expired")
            return { ...base, truncated: false, scopes: [] };
        throw new UsageReadError(verdict.reason);
    }
    if (record.personId !== personId)
        throw new UsageReadError("entitlement_record_invalid");
    const seen = new Set();
    const active = record.projectMemberships.filter((m) => {
        if (!isObject(m) || m.status !== "active" || !IDENTIFIER.test(String(m.projectId)) || !IDENTIFIER.test(String(m.classification)))
            return false;
        const key = `${m.projectId}:${m.classification}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    const chosen = active.slice(0, MAX_USAGE_SCOPES);
    const scopes = await Promise.all(chosen.map(async (m) => {
        const scopeId = `${m.projectId}:${m.classification}`;
        const [state, aggregate] = await Promise.all([
            deps.readBudgetState(personId, m.projectId, signal),
            showGroupTotals ? deps.readAggregateBudgetState(scopeId, signal) : Promise.resolve(undefined),
        ]);
        const scope = {
            projectId: m.projectId,
            classification: m.classification,
            ...personFigures(state, personId, m, period),
        };
        if (showGroupTotals)
            scope.group = groupRemaining(aggregate, scopeId, period);
        return scope;
    }));
    return { ...base, truncated: active.length > chosen.length, scopes };
}
