// Budget units (ADR-0011 decision 9). Budgets are configured in CCU or USD,
// as the administrator chooses (owner, 2026-10-11), and every budget stores
// its unit in `currency`, so changing a default can never reinterpret an
// amount already stored. Figures are shown in both units.
import { BudgetConfigError } from "./errors.js";
import { child, readDecimalText, readFields } from "./config-fields.js";
import { Money } from "./money.js";
// The one number in pricing code (owner rule, 2026-10-11), because it is the
// definition of the unit rather than a price: "One hundred (100) CCU
// represents $1.00 USD of fees owed for the Services, calculated at the
// applicable prices ..., after application of any discounts."
// https://platform.claude.com/docs/en/about-claude/pricing (Claude in
// Microsoft Foundry pricing), retrieved 2026-10-11.
export const CCU_PER_USD = new Money(100);
export const BUDGET_CURRENCIES = ["CCU", "USD"];
export const BUDGET_PERIODS = ["monthly"];
const fail = (field, code, detail) => new BudgetConfigError(field, code, detail);
export function usdToCcu(usd) {
    return new Money(usd).times(CCU_PER_USD);
}
export function ccuToUsd(ccu) {
    return new Money(ccu).dividedBy(CCU_PER_USD);
}
// A budget object such as { "amount": 25000, "currency": "CCU", "period": "monthly" }.
// `field` is the budget's path in its document, used to name a faulty field.
export function parseBudget(value, field) {
    const budget = readFields(value, field, fail, ["amount", "currency", "period"]);
    return {
        amount: readAmount(budget.amount, child(field, "amount")),
        currency: readChoice(budget.currency, child(field, "currency"), BUDGET_CURRENCIES),
        period: readChoice(budget.period, child(field, "period"), BUDGET_PERIODS),
    };
}
// An aggregate budget is either a budget or an explicit null, meaning no cap
// (docs/LLD.md). An absent field is refused rather than read as "no cap".
export function parseOptionalBudget(value, field) {
    if (value === undefined)
        throw fail(field, "missing_field", "is required; use null for no cap");
    return value === null ? null : parseBudget(value, field);
}
export function budgetInBothUnits(budget) {
    return budget.currency === "CCU"
        ? { ccu: budget.amount, usd: ccuToUsd(budget.amount) }
        : { ccu: usdToCcu(budget.amount), usd: budget.amount };
}
function readAmount(value, field) {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0)
            throw fail(field, "invalid_value", "must be a non-negative number");
        return new Money(value);
    }
    return readDecimalText(value, field, fail);
}
function readChoice(value, field, choices) {
    if (typeof value !== "string" || !choices.includes(value)) {
        throw fail(field, "invalid_value", `must be one of: ${choices.join(", ")}`);
    }
    return value;
}
