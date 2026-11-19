// Named errors for the cost configuration (ADR-0011 decision 2). Each one
// names the configuration field at fault as a path such as
// "entries[3].promptTiers[0].rates.cacheWrite1h" (owner rule, 2026-10-11).
export class CostConfigError extends Error {
    config;
    field;
    code;
    constructor(config, field, code, detail) {
        super(`${config}: ${field} ${detail} (${code})`);
        this.name = new.target.name;
        this.config = config;
        this.field = field;
        this.code = code;
    }
}
export class RateCardError extends CostConfigError {
    constructor(field, code, detail) {
        super("rate card", field, code, detail);
    }
}
export class ContractScheduleError extends CostConfigError {
    constructor(field, code, detail) {
        super("contract schedule", field, code, detail);
    }
}
export class BudgetConfigError extends CostConfigError {
    constructor(field, code, detail) {
        super("budget", field, code, detail);
    }
}
// A ledger row handed to pricing is malformed (not merely incomplete: missing
// token counts are a pricing outcome, not an error).
export class UsageRowError extends Error {
    field;
    constructor(field, detail) {
        super(`usage row: ${field} ${detail}`);
        this.name = "UsageRowError";
        this.field = field;
    }
}
