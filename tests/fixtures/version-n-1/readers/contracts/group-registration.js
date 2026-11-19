// An onboarded group (ADR-0034): one existing Entra group with its own budget,
// limits, models, surfaces, priority, chargeback ID and cache profile. Problems
// are field paths with codes, never values.
import { parseBudget, parseOptionalBudget } from "../cost/budget-units.js";
import { CostConfigError } from "../cost/errors.js";
import { GROUP_SCOPE_CODE, parseFamilyPolicy } from "./model-families.js";
export const SURFACES = ["chat", "code", "cowork", "design", "m365"];
export const MAX_PRIORITY = 10_000;
// Lower-case only: `id` and the partition key `projectId` must equal it exactly,
// so Cosmos id uniqueness keeps one document per group, and a baseline project
// with the same GUID collides on create rather than coexisting.
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
// A WBS element or cost-centre code. A leading letter or digit and no quotes,
// commas, spaces or `=+@%` keep it inert in a CSV cell, a KQL string literal and
// a URL query value. It may contain `/` and `..`: never put it in a URL path.
export const CHARGEBACK_ID = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const GROUP_DOCUMENT_KEYS = [
    "id", "kind", "groupId", "projectId", "displayName", "status", "retiredAt", "backendId", "priority", "chargebackId",
    "budget", "restrictedFamiliesApproved", "familyPolicy", "surfaces", "cacheProfile",
];
const KEYS = GROUP_DOCUMENT_KEYS;
// Cosmos system properties (_rid, _self, _etag, _attachments, _ts).
const isSystemKey = (key) => key.startsWith("_");
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function readBudget(value, field, optional, problems) {
    try {
        const parsed = optional ? parseOptionalBudget(value, field) : parseBudget(value, field);
        return parsed === null ? null : value;
    }
    catch (error) {
        if (!(error instanceof CostConfigError))
            throw error;
        problems.push(`${field}:invalid`);
        return undefined;
    }
}
function readBudgetSection(value, problems) {
    if (!isObject(value) || Object.keys(value).some((k) => !["mode", "perUser", "groupCap"].includes(k))) {
        problems.push("budget:invalid");
        return null;
    }
    const before = problems.length;
    const mode = value.mode === "autoScale" || value.mode === "cap" ? value.mode : null;
    if (!mode)
        problems.push("budget.mode:invalid");
    const perUser = readBudget(value.perUser, "budget.perUser", false, problems);
    const groupCap = readBudget(value.groupCap, "budget.groupCap", true, problems);
    if (groupCap !== undefined && mode !== null && (groupCap === null) !== (mode === "autoScale"))
        problems.push("budget.groupCap:invalid");
    if (problems.length > before || !mode || !perUser || groupCap === undefined)
        return null;
    return { mode, perUser, groupCap };
}
function readSurfaces(value, problems) {
    const valid = Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
        && value.every((s) => SURFACES.includes(s));
    if (!valid) {
        problems.push("surfaces:invalid");
        return null;
    }
    return [...value].sort();
}
function readCacheProfile(value, problems) {
    const percent = isObject(value) ? value.expectedCacheReadPercent : undefined;
    const valid = isObject(value) && Object.keys(value).length === 2
        && typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100
        && (value.basis === "suggested" || value.basis === "custom");
    if (!valid) {
        problems.push("cacheProfile:invalid");
        return null;
    }
    return { expectedCacheReadPercent: percent, basis: value.basis };
}
function readRetiredAt(doc, status, problems) {
    const value = doc.retiredAt ?? null;
    const valid = typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
    if (status === "retired" && !valid)
        problems.push("retiredAt:invalid");
    if (status === "active" && value !== null)
        problems.push("retiredAt:invalid");
    return status === "retired" && valid ? value : null;
}
const isPriority = (value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_PRIORITY;
export function readGroupRegistration(doc) {
    if (!isObject(doc))
        return { ok: false, groupId: null, problems: ["document:not_an_object"] };
    const problems = [];
    if (Object.keys(doc).some((k) => !KEYS.includes(k) && !isSystemKey(k)))
        problems.push("document:unexpected_key");
    if (doc.kind !== "group")
        problems.push("kind:invalid");
    const groupId = typeof doc.groupId === "string" && GROUP_ID.test(doc.groupId) ? doc.groupId : null;
    if (!groupId)
        problems.push("groupId:invalid");
    if (groupId && doc.id !== groupId)
        problems.push("id:not_equal_to_groupId");
    if (groupId && doc.projectId !== groupId)
        problems.push("projectId:not_equal_to_groupId");
    const displayName = typeof doc.displayName === "string" && doc.displayName.length >= 1 && doc.displayName.length <= 256 ? doc.displayName : null;
    if (displayName === null)
        problems.push("displayName:invalid");
    const status = doc.status === "active" || doc.status === "retired" ? doc.status : null;
    if (!status)
        problems.push("status:invalid");
    const retiredAt = readRetiredAt(doc, status, problems);
    const backendId = typeof doc.backendId === "string" && ID.test(doc.backendId) ? doc.backendId : null;
    if (!backendId)
        problems.push("backendId:invalid");
    if (!isPriority(doc.priority))
        problems.push("priority:invalid");
    const chargebackOk = doc.chargebackId === null || (typeof doc.chargebackId === "string" && CHARGEBACK_ID.test(doc.chargebackId));
    if (!chargebackOk)
        problems.push("chargebackId:invalid");
    const approved = doc.restrictedFamiliesApproved;
    if (typeof approved !== "boolean")
        problems.push("restrictedFamiliesApproved:invalid");
    const familyPolicy = parseFamilyPolicy(doc.familyPolicy, GROUP_SCOPE_CODE, approved === true);
    if (!familyPolicy.ok)
        problems.push(`familyPolicy:${familyPolicy.detail}`);
    const budget = readBudgetSection(doc.budget, problems);
    const surfaces = readSurfaces(doc.surfaces, problems);
    const cacheProfile = readCacheProfile(doc.cacheProfile, problems);
    if (problems.length > 0 || !groupId || !displayName || !status || !backendId || !familyPolicy.ok || !budget || !surfaces || !cacheProfile) {
        return { ok: false, groupId, problems };
    }
    return {
        ok: true,
        registration: {
            groupId, displayName, status, retiredAt, backendId, priority: doc.priority,
            chargebackId: doc.chargebackId, budget, restrictedFamiliesApproved: approved,
            familyPolicy: familyPolicy.value, surfaces, cacheProfile,
        },
    };
}
