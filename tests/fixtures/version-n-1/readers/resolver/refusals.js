// Refusal reasons and their HTTP statuses, in one place (ADR-0008, docs/PILOT.md
// C-1): http-handler.ts derives the external category from the status, so a
// new reason cannot drift from its category.
const REFUSAL_STATUS = {
    unknown_subscription: 403,
    subscription_person_mismatch: 403,
    no_entitlement: 403,
    entitlement_legacy_expired: 403,
    project_mismatch: 403,
    classification_mismatch: 403,
    project_selection_required: 400,
    // C-7: the budget refusals follow a verified membership.
    budget_exhausted: 403,
    aggregate_budget_exhausted: 403,
    // C-8: the gateway routes only to backends the resolver returns.
    backend_not_active: 403,
    backend_record_invalid: 503,
    entitlement_record_invalid: 503,
    budget_state_missing: 503,
    budget_state_invalid: 503,
    budget_state_stale: 503,
    aggregate_budget_state_missing: 503,
    aggregate_budget_state_invalid: 503,
    aggregate_budget_state_stale: 503,
};
export function refusalStatus(reason) {
    return Object.hasOwn(REFUSAL_STATUS, reason) ? REFUSAL_STATUS[reason] : undefined;
}
const REFUSAL_BUDGET_STATE = {
    budget_state_missing: "missing",
    aggregate_budget_state_missing: "missing",
    budget_state_invalid: "stale",
    aggregate_budget_state_invalid: "stale",
    budget_state_stale: "stale",
    aggregate_budget_state_stale: "stale",
};
export function refuse(reason, projectId, detail) {
    const refusal = { refused: true, reason, httpStatus: REFUSAL_STATUS[reason] };
    if (projectId !== undefined)
        refusal.projectId = projectId;
    if (detail !== undefined)
        refusal.detail = detail;
    const budgetState = REFUSAL_BUDGET_STATE[reason];
    if (budgetState)
        refusal.budgetState = budgetState;
    return refusal;
}
// A read the decision depends on that failed is raised to the caller, which
// owns error translation (http-handler.ts answers 503).
export function settledValue(result) {
    if (result.status === "rejected")
        throw result.reason;
    return result.value;
}
