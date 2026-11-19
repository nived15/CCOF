// The one scope code of every onboarded group (ADR-0034). It is stable, so the
// budget scope "<groupId>:group" does not move when the group's settings
// change, and it is reserved: a baseline project may not use it.
export const GROUP_SCOPE_CODE = "group";
// Fable and Mythos: under the baseline CYB classification (ADR-0033), or in a
// group whose owner approved them (ADR-0034 decision 3). The approval is an
// explicit flag, never inferred from a code a document can choose.
export function restrictedFamiliesAllowed(classification, restrictedApproved) {
    return classification === "CYB" || (classification === GROUP_SCOPE_CODE && restrictedApproved);
}
const families = ["haiku", "sonnet", "opus", "fable", "mythos"];
const periods = ["Hourly", "Daily", "Weekly", "Monthly", "Yearly"];
const canonicalModel = /^claude-(haiku|sonnet|opus|fable|mythos)-[A-Za-z0-9][A-Za-z0-9._-]{0,105}$/;
const aliasModel = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function positiveInteger(value, max) {
    return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max);
}
function tokenLimit(value) {
    if (!object(value) || !exactKeys(value, ["tokensPerMinute", "tokenQuota", "tokenQuotaPeriod"]))
        return null;
    if (!positiveInteger(value.tokensPerMinute, 2147483647) || !positiveInteger(value.tokenQuota, Number.MAX_SAFE_INTEGER))
        return null;
    if (value.tokenQuotaPeriod !== null && !periods.includes(value.tokenQuotaPeriod))
        return null;
    if ((value.tokenQuota === null) !== (value.tokenQuotaPeriod === null))
        return null;
    return {
        tokensPerMinute: value.tokensPerMinute,
        tokenQuota: value.tokenQuota,
        tokenQuotaPeriod: value.tokenQuotaPeriod,
    };
}
function validModel(model, family) {
    if (typeof model !== "string")
        return false;
    if (model.startsWith("claude-")) {
        const match = canonicalModel.exec(model);
        // Prefix consistency never substitutes for matching the entire registered ID.
        return match !== null && match[0] === model && match[1] === family;
    }
    return aliasModel.exec(model)?.[0] === model;
}
export function parseFamilyPolicy(value, classification, restrictedApproved = false) {
    const invalid = { ok: false, detail: "invalid_family_policy" };
    if (!object(value) || !exactKeys(value, ["aggregateLimits", "families"]) || !object(value.families))
        return invalid;
    if (!restrictedFamiliesAllowed(classification, restrictedApproved) && (Object.hasOwn(value.families, "fable") || Object.hasOwn(value.families, "mythos"))) {
        return { ok: false, detail: "family_classification_forbidden" };
    }
    if (!object(value.aggregateLimits) || !exactKeys(value.aggregateLimits, ["person", "group"]))
        return invalid;
    const person = tokenLimit(value.aggregateLimits.person);
    const group = tokenLimit(value.aggregateLimits.group);
    if (!person || !group)
        return invalid;
    const keys = Object.keys(value.families);
    if (keys.length === 0 || keys.some((key) => !families.includes(key)))
        return invalid;
    const parsed = { aggregateLimits: { person, group }, families: {} };
    const registered = new Set();
    for (const key of keys) {
        const family = key;
        const entry = value.families[key];
        if (!object(entry) || !exactKeys(entry, ["models", "person", "group"]) || !Array.isArray(entry.models) || entry.models.length === 0)
            return invalid;
        const familyPerson = tokenLimit(entry.person);
        const familyGroup = tokenLimit(entry.group);
        if (!familyPerson || !familyGroup)
            return invalid;
        const models = [];
        for (const model of entry.models) {
            if (!validModel(model, family) || registered.has(model))
                return invalid;
            registered.add(model);
            models.push(model);
        }
        parsed.families[family] = { models, person: familyPerson, group: familyGroup };
    }
    return { ok: true, value: parsed };
}
export function admittedModelFamily(policy, classification, model, restrictedApproved = false) {
    const parsed = parseFamilyPolicy(policy, classification, restrictedApproved);
    if (!parsed.ok)
        return null;
    for (const family of families) {
        if (parsed.value.families[family]?.models.includes(model))
            return family;
    }
    return null;
}
