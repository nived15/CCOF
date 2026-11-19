// Resolver core decision logic (ADR-0003). Pure, framework-free: every
// Cosmos read and the clock are injected, so this module is testable without a
// Functions host or a real Cosmos account (tests/resolver-*.test.ts).
//
// Given a person and, optionally, a subscription key or a project selector,
// it selects one of the person's memberships (select-membership.ts: the key
// is cross-checked against entitlement, ADR-0002; a selector only chooses,
// docs/PILOT.md C-1) and returns a routing, limits and budget decision or a
// named, fail-closed refusal.
//
// Freshness (ADR-0008): entitlement records persist until a sync changes them,
// and stale budget state is served, marked degraded, until the configured hard
// limit. In token-limits-only mode (docs/PILOT.md C-3) no budget document is
// read at all.
import { checkBackendRecord } from "./backend.js";
import { classifyBudgetValidity, MAX_TOKENS_PER_MINUTE, validateMembership } from "./freshness.js";
import { refuse, settledValue } from "./refusals.js";
import { selectByKey, selectBySelector } from "./select-membership.js";
export { refusalStatus } from "./refusals.js";
// Applies ADR-0008's staleness table to one present record. The same policy
// covers the person's state and a strict scope's aggregate state. The
// exhausted flag must be a boolean: a record without it cannot show that
// budget remains (C-7).
function checkBudgetState(record, scope, nowMs, policy, requireCompleteUsage = false) {
    const prefix = scope === "aggregate" ? "aggregate_" : "";
    if (typeof record.exhausted !== "boolean")
        return { ok: false, reason: `${prefix}budget_state_invalid` };
    if (requireCompleteUsage && record.completeness !== "complete")
        return { ok: false, reason: `${prefix}budget_state_invalid` };
    if (scope === "person") {
        const ceiling = record.realtimeCeilingTokensPerMinute;
        if (typeof ceiling !== "number" || !Number.isSafeInteger(ceiling) || ceiling < 0 || ceiling > MAX_TOKENS_PER_MINUTE) {
            return { ok: false, reason: "budget_state_invalid" };
        }
    }
    switch (classifyBudgetValidity(record.validUntil, nowMs, policy)) {
        case "fresh":
            return { ok: true, degradedReason: null };
        case "stale_within_grace":
            return { ok: true, degradedReason: `${prefix}budget_state_stale_within_grace` };
        case "stale_beyond_grace":
            return { ok: true, degradedReason: `${prefix}budget_state_stale_beyond_grace` };
        case "stale":
            return { ok: false, reason: `${prefix}budget_state_stale` };
        case "invalid":
            return { ok: false, reason: `${prefix}budget_state_invalid` };
    }
}
export async function resolveRequest(input, deps, context) {
    // Trust boundary (ADR-0009): `input.personId` is trusted only because only
    // APIM's managed identity can call the resolver (App Service Authentication
    // on the Function App), and APIM sets it from the `oid` of the developer
    // token it validated. This function decides authorization only: is this
    // person entitled to the project the request names or implies.
    const nowMs = context.now.getTime();
    const { signal } = context;
    const selection = input.subscriptionId !== undefined
        ? await selectByKey({ ...input, subscriptionId: input.subscriptionId }, deps, nowMs, signal)
        : await selectBySelector(input, deps, nowMs, signal);
    if ("refused" in selection)
        return selection;
    // Every field the gateway routes, filters or limits on is checked here; a
    // record the gateway could not apply is that person's 503, not a 200.
    const checked = validateMembership(selection.membership);
    const claimedProjectId = typeof selection.membership.projectId === "string" ? selection.membership.projectId : undefined;
    if (!checked.ok)
        return refuse("entitlement_record_invalid", checked.detail === "invalid_project_id" ? undefined : claimedProjectId, checked.detail);
    const membership = checked.value;
    const resolved = {
        refused: false,
        decisionVersion: 3,
        personId: input.personId,
        projectId: membership.projectId,
        classification: membership.classification,
        classificationGroupId: membership.classificationGroupId,
        ...(membership.classificationGroupDisplayName !== undefined
            ? { classificationGroupDisplayName: membership.classificationGroupDisplayName }
            : {}),
        backendId: membership.backendId,
        familyPolicy: membership.familyPolicy,
        ...(membership.group !== undefined
            ? {
                surfaces: membership.group.surfaces,
                chargebackId: membership.group.chargebackId,
                restrictedFamiliesApproved: membership.group.restrictedFamiliesApproved,
            }
            : {}),
        personBudgetScope: `${input.personId}:${membership.projectId}`,
    };
    // Wave 2 (docs/ARCHITECTURE.md §3): every read keyed by the verified
    // membership starts together. allSettled observes each read, so one that
    // fails after a refusal is decided never becomes an unhandled rejection.
    const enforcement = context.budgetEnforcement;
    if (enforcement.mode === "token-limits-only") {
        const [backendRead] = await Promise.allSettled([deps.readBackend(membership.backendId, signal)]);
        return withBackend(backendRead, membership, {
            ...resolved,
            budgetEnforcement: "token-limits-only",
            aggregateStrict: false,
            aggregateState: null,
            personCeilingTokensPerMinute: null,
            degraded: false,
            degradedReasons: [],
            budgetState: null,
        });
    }
    return resolveBudgetState(resolved, membership, deps, nowMs, enforcement.staleness, signal, enforcement.requireCompleteUsage);
}
// C-8: the descriptor from the backend registry, checked last, so a budget
// refusal stands even when the registry read fails.
function withBackend(read, membership, success) {
    const verdict = checkBackendRecord(settledValue(read), membership.backendId);
    switch (verdict.kind) {
        case "legacy":
            return success;
        case "active":
            return { ...success, backend: verdict.descriptor };
        case "not_active":
            return refuse("backend_not_active", membership.projectId);
        case "invalid":
            return refuse("backend_record_invalid", membership.projectId, verdict.detail);
    }
}
function refuseExhausted(reason, membership, staleReasons) {
    return {
        ...refuse(reason, membership.projectId),
        classification: membership.classification,
        budgetState: staleReasons.length > 0 ? "degraded" : "fresh",
    };
}
// Records a promise's outcome as soon as it settles, without waiting for it;
// the attached handlers also keep a later rejection from going unhandled.
function observe(promise) {
    const box = {};
    promise.then((value) => (box.result = { status: "fulfilled", value }), (reason) => (box.result = { status: "rejected", reason }));
    return box;
}
// ADR-0047: the pacing counter restarts when the budget or the month changes, not when the ceiling moves with spend.
const CEILING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const CEILING_BUDGET = /^\d{1,20}(\.\d{1,12})?$/;
function ceilingKeyOf(budget) {
    const { period, budgetCcu } = budget;
    if (typeof period !== "string" || !CEILING_PERIOD.test(period))
        return {};
    if (typeof budgetCcu !== "string" || !CEILING_BUDGET.test(budgetCcu))
        return {};
    return { personCeilingKey: `${period}_${budgetCcu}` };
}
async function resolveBudgetState(resolved, membership, deps, nowMs, staleness, signal, requireCompleteUsage = false) {
    const aggregateStrict = membership.aggregateMode === "strict";
    const scopeId = `${resolved.projectId}:${membership.classification}`;
    // The aggregate is read in both modes since C-7: notify reads it to flag an
    // exhausted group. Only strict waits for it; a notify request is answered
    // when the reads it needs are in, with the flag if the group read is too.
    const budgetPromise = deps.readBudgetState(resolved.personId, resolved.projectId, signal);
    const aggregatePromise = deps.readAggregateBudgetState(scopeId, signal);
    const backendPromise = deps.readBackend(membership.backendId, signal);
    const notifyAggregate = aggregateStrict ? undefined : observe(aggregatePromise);
    const [budgetRead, aggregateRead, backendRead] = await Promise.allSettled([
        budgetPromise,
        aggregateStrict ? aggregatePromise : Promise.resolve(null),
        backendPromise,
    ]);
    // Fail closed: missing, invalid or too-stale reconciler state is never
    // evidence the person has budget left. Validity is checked before the
    // exhausted flag (C-7).
    const staleReasons = [];
    const budget = settledValue(budgetRead);
    if (!budget)
        return refuse("budget_state_missing", resolved.projectId);
    const personCheck = checkBudgetState(budget, "person", nowMs, staleness, requireCompleteUsage);
    if (!personCheck.ok)
        return refuse(personCheck.reason, resolved.projectId);
    if (personCheck.degradedReason)
        staleReasons.push(personCheck.degradedReason);
    if (budget.exhausted)
        return refuseExhausted("budget_exhausted", membership, staleReasons);
    const notices = [];
    let aggregateState = null;
    if (aggregateStrict) {
        aggregateState = settledValue(aggregateRead);
        if (!aggregateState)
            return refuse("aggregate_budget_state_missing", resolved.projectId);
        const aggregateCheck = checkBudgetState(aggregateState, "aggregate", nowMs, staleness, requireCompleteUsage);
        if (!aggregateCheck.ok)
            return refuse(aggregateCheck.reason, resolved.projectId);
        if (aggregateCheck.degradedReason)
            staleReasons.push(aggregateCheck.degradedReason);
        if (aggregateState.exhausted)
            return refuseExhausted("aggregate_budget_exhausted", membership, staleReasons);
    }
    else {
        // Notify never refuses: an unfinished, unreadable, missing, invalid or
        // too-stale aggregate is ignored, and only a trustworthy exhausted flag is
        // noted.
        const settled = notifyAggregate?.result;
        const notifyState = settled?.status === "fulfilled" ? settled.value : null;
        if (notifyState && checkBudgetState(notifyState, "aggregate", nowMs, staleness).ok && notifyState.exhausted) {
            notices.push("aggregate_budget_exhausted_notify");
        }
    }
    const degradedReasons = [...staleReasons, ...notices];
    return withBackend(backendRead, membership, {
        ...resolved,
        budgetEnforcement: "budget-state",
        aggregateStrict,
        aggregateState,
        // The last-known ceiling, also while degraded (ADR-0008 decision 3).
        personCeilingTokensPerMinute: budget.realtimeCeilingTokensPerMinute,
        ...ceilingKeyOf(budget),
        degraded: degradedReasons.length > 0,
        degradedReasons,
        budgetState: staleReasons.length > 0 ? "degraded" : "fresh",
    });
}
