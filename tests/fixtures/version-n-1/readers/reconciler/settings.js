// Reconciler settings (ADR-0018 decision 9). Every value is an administrator's
// decision, written as an app setting by infra/reconciler: there are no
// defaults, and a missing or invalid value refuses the run before any Azure
// call. Problems name the setting and a code, never the value.
export const SETTING_NAMES = [
    "RECONCILER_MANAGED_IDENTITY_CLIENT_ID",
    "RECONCILER_SCHEDULE",
    "RECONCILER_VALIDITY_SECONDS",
    "RECONCILER_LEASE_SECONDS",
    "RECONCILER_LOG_ANALYTICS_WORKSPACE_ID",
    "RECONCILER_LOG_ANALYTICS_ENDPOINT",
    "RECONCILER_LEDGER_GATEWAY_RESOURCE_ID",
    "RECONCILER_LEDGER_TIMEOUT_SECONDS",
    "RECONCILER_LEDGER_MAX_ROWS",
    "RECONCILER_MAX_STATES",
    "RECONCILER_WRITE_CONCURRENCY",
    "COSMOS_ENDPOINT",
    "COSMOS_DATABASE",
    "RECONCILER_PROJECTS_CONTAINER",
    "RECONCILER_ENTITLEMENT_CONTAINER",
    "RECONCILER_BUDGET_STATE_CONTAINER",
    "RECONCILER_AGGREGATE_STATE_CONTAINER",
    "RECONCILER_LEASE_CONTAINER",
];
export const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Only "every N minutes": the interval must be known to check the validity.
const EVERY_N_MINUTES = /^0 \*\/([1-9]|[1-5][0-9]) \* \* \* \*$/;
// The APIM resource id is interpolated into KQL as a string literal, so its
// pattern admits no quote or backslash (WP-ONB's Stage 2 pattern).
const APIM_RESOURCE_ID = /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[A-Za-z0-9._-]+\/providers\/Microsoft\.ApiManagement\/service\/[A-Za-z0-9-]+$/;
const COSMOS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const WHOLE_NUMBER = /^\d{1,10}$/;
// Documented platform bounds: the query API runs a query for at most 10
// minutes and returns at most 500,000 records (Learn, "Azure Monitor service
// limits", retrieved 2026-10-11). The other upper bounds catch typos: a
// validity of more than a day would let stale state pass as fresh
// (ADR-0008, "A wrong validUntil far in the future").
const RANGES = {
    RECONCILER_VALIDITY_SECONDS: [1, 86_400],
    RECONCILER_LEASE_SECONDS: [1, 86_400],
    RECONCILER_LEDGER_TIMEOUT_SECONDS: [1, 600],
    RECONCILER_LEDGER_MAX_ROWS: [1, 500_000],
    RECONCILER_MAX_STATES: [1, 10_000_000],
    RECONCILER_WRITE_CONCURRENCY: [1, 32],
    RECONCILER_BUDGET_WARN_PERCENT: [1, 99],
    RECONCILER_OVERSHOOT_PERCENT: [1, 50],
    RECONCILER_PROJECTION_MINUTES: [1, 60],
    // ADR-0044: closing a day later than a week only delays history; retention allows more (AUD-C5).
    RECONCILER_HISTORY_CLOSE_AFTER_DAYS: [1, 7],
    // The largest Cosmos DB time to live, in seconds, that fits a 32-bit signed number, in whole days.
    RECONCILER_HISTORY_TTL_DAYS: [1, 24855],
};
export const HISTORY_SETTING_NAMES = ["RECONCILER_HISTORY_CONTAINER", "RECONCILER_HISTORY_CLOSE_AFTER_DAYS", "RECONCILER_HISTORY_TTL_DAYS"];
export const GUARD_SETTING_NAMES = ["RECONCILER_BUDGET_WARN_PERCENT", "RECONCILER_OVERSHOOT_PERCENT", "RECONCILER_PROJECTION_MINUTES"];
class Reader {
    problems = [];
    settings;
    constructor(settings) {
        this.settings = settings;
    }
    raw(name) {
        const value = this.settings[name]?.trim();
        if (!value)
            return this.fail(name, "missing");
        return value;
    }
    fail(name, problem) {
        this.problems.push({ setting: name, problem });
        return undefined;
    }
    matching(name, pattern) {
        const value = this.raw(name);
        if (value === undefined)
            return undefined;
        return pattern.test(value) ? value : this.fail(name, "invalid");
    }
    integer(name) {
        const value = this.raw(name);
        if (value === undefined)
            return undefined;
        if (!WHOLE_NUMBER.test(value))
            return this.fail(name, "invalid");
        const n = Number(value);
        const [min, max] = RANGES[name];
        return n >= min && n <= max ? n : this.fail(name, "out_of_range");
    }
}
function isCosmosEndpoint(value) {
    if (!URL.canParse(value))
        return false;
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".documents.azure.com") && url.pathname === "/" && !url.search && !url.username;
}
// An https origin only: the client appends /v1/workspaces/<id>/query, and the
// token is requested for this origin.
function isHttpsOrigin(value) {
    if (!URL.canParse(value))
        return false;
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password && !value.endsWith("/");
}
function readContainers(r) {
    const containers = {
        projects: r.matching("RECONCILER_PROJECTS_CONTAINER", COSMOS_NAME),
        entitlement: r.matching("RECONCILER_ENTITLEMENT_CONTAINER", COSMOS_NAME),
        budgetState: r.matching("RECONCILER_BUDGET_STATE_CONTAINER", COSMOS_NAME),
        aggregateState: r.matching("RECONCILER_AGGREGATE_STATE_CONTAINER", COSMOS_NAME),
        lease: r.matching("RECONCILER_LEASE_CONTAINER", COSMOS_NAME),
    };
    // Each container the reconciler writes must differ from every other one it
    // uses: it must never write into what it reads, or its lease into state.
    const settingOf = {
        projects: "RECONCILER_PROJECTS_CONTAINER",
        entitlement: "RECONCILER_ENTITLEMENT_CONTAINER",
        budgetState: "RECONCILER_BUDGET_STATE_CONTAINER",
        aggregateState: "RECONCILER_AGGREGATE_STATE_CONTAINER",
        lease: "RECONCILER_LEASE_CONTAINER",
    };
    const order = ["projects", "entitlement", "budgetState", "aggregateState", "lease"];
    order.forEach((key, index) => {
        const name = containers[key];
        if (index < 2 || name === undefined)
            return;
        if (order.slice(0, index).some((earlier) => containers[earlier] === name))
            r.fail(settingOf[key], "same_as_other_container");
    });
    return containers;
}
export function readReconcilerSettings(settings) {
    const r = new Reader(settings);
    const managedIdentityClientId = r.matching("RECONCILER_MANAGED_IDENTITY_CLIENT_ID", GUID)?.toLowerCase();
    const schedule = r.matching("RECONCILER_SCHEDULE", EVERY_N_MINUTES);
    const intervalMinutes = schedule === undefined ? undefined : Number(EVERY_N_MINUTES.exec(schedule)?.[1]);
    const validitySeconds = r.integer("RECONCILER_VALIDITY_SECONDS");
    const leaseSeconds = r.integer("RECONCILER_LEASE_SECONDS");
    const workspaceId = r.matching("RECONCILER_LOG_ANALYTICS_WORKSPACE_ID", GUID)?.toLowerCase();
    const endpointLa = r.raw("RECONCILER_LOG_ANALYTICS_ENDPOINT");
    const logAnalyticsEndpoint = endpointLa === undefined ? undefined : isHttpsOrigin(endpointLa) ? endpointLa : r.fail("RECONCILER_LOG_ANALYTICS_ENDPOINT", "invalid");
    const gatewayResourceId = r.matching("RECONCILER_LEDGER_GATEWAY_RESOURCE_ID", APIM_RESOURCE_ID);
    const ledgerTimeoutSeconds = r.integer("RECONCILER_LEDGER_TIMEOUT_SECONDS");
    const ledgerMaxRows = r.integer("RECONCILER_LEDGER_MAX_ROWS");
    const maxStates = r.integer("RECONCILER_MAX_STATES");
    const writeConcurrency = r.integer("RECONCILER_WRITE_CONCURRENCY");
    const endpointRaw = r.raw("COSMOS_ENDPOINT");
    const cosmosEndpoint = endpointRaw === undefined ? undefined : isCosmosEndpoint(endpointRaw) ? endpointRaw : r.fail("COSMOS_ENDPOINT", "invalid");
    const cosmosDatabase = r.matching("COSMOS_DATABASE", COSMOS_NAME);
    const containers = readContainers(r);
    // The budget guard (ADR-0040) is optional, but never half-configured.
    const guardGiven = GUARD_SETTING_NAMES.some((name) => settings[name]?.trim());
    const guard = guardGiven
        ? { warnPercent: r.integer("RECONCILER_BUDGET_WARN_PERCENT"), overshootPercent: r.integer("RECONCILER_OVERSHOOT_PERCENT"), projectionMinutes: r.integer("RECONCILER_PROJECTION_MINUTES") }
        : undefined;
    const historyGiven = HISTORY_SETTING_NAMES.some((name) => settings[name]?.trim());
    const historyContainer = historyGiven ? r.matching("RECONCILER_HISTORY_CONTAINER", COSMOS_NAME) : undefined;
    const ttlDays = settings.RECONCILER_HISTORY_TTL_DAYS?.trim() ? r.integer("RECONCILER_HISTORY_TTL_DAYS") : null;
    const history = historyGiven ? { container: historyContainer, closeAfterDays: r.integer("RECONCILER_HISTORY_CLOSE_AFTER_DAYS"), ttlDays } : undefined;
    if (historyContainer !== undefined && Object.values(containers).includes(historyContainer))
        r.fail("RECONCILER_HISTORY_CONTAINER", "same_as_other_container");
    // A healthy run renews state before the previous run's state lapses only if
    // the validity outlasts the interval plus the longest ledger read.
    if (validitySeconds !== undefined && intervalMinutes !== undefined && ledgerTimeoutSeconds !== undefined) {
        if (validitySeconds <= intervalMinutes * 60 + ledgerTimeoutSeconds) {
            r.fail("RECONCILER_VALIDITY_SECONDS", "not_above_interval_plus_ledger_timeout");
        }
    }
    // The lease is renewed before the writes; one ledger read must not outlast it.
    if (leaseSeconds !== undefined && ledgerTimeoutSeconds !== undefined && leaseSeconds < 2 * ledgerTimeoutSeconds) {
        r.fail("RECONCILER_LEASE_SECONDS", "shorter_than_twice_ledger_timeout");
    }
    if (r.problems.length > 0)
        return { ok: false, problems: r.problems };
    return {
        ok: true,
        settings: {
            managedIdentityClientId: managedIdentityClientId,
            intervalMinutes: intervalMinutes,
            validitySeconds: validitySeconds,
            leaseSeconds: leaseSeconds,
            workspaceId: workspaceId,
            logAnalyticsEndpoint: logAnalyticsEndpoint,
            gatewayResourceId: gatewayResourceId,
            ledgerTimeoutSeconds: ledgerTimeoutSeconds,
            ledgerMaxRows: ledgerMaxRows,
            maxStates: maxStates,
            writeConcurrency: writeConcurrency,
            cosmosEndpoint: cosmosEndpoint,
            cosmosDatabase: cosmosDatabase,
            containers: containers,
            ...(guard ? { guard: guard } : {}),
            ...(history ? { history: history } : {}),
        },
    };
}
