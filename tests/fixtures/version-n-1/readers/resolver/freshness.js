// Validity and freshness rules for registry records (ADR-0008). Pure functions
// of a record and the resolver's clock, so decide.ts can compose them and the
// tests can drive every boundary without a real clock.
import { GROUP_SCOPE_CODE, parseFamilyPolicy } from "../contracts/model-families.js";
import { CHARGEBACK_ID, MAX_PRIORITY, SURFACES } from "../contracts/group-registration.js";
// ISO 8601 date-time with `Z` or a UTC offset. A date-time without a zone is
// refused because Date.parse reads it as local time, which differs per host.
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export function parseZonedTimestamp(value) {
    if (typeof value !== "string" || !ZONED_DATE_TIME.test(value))
        return null;
    const epochMs = Date.parse(value);
    return Number.isFinite(epochMs) ? epochMs : null;
}
// Records persist until a sync changes them (reference ADR-0051), so age alone
// never makes a record unusable: a stopped sync must not deny anyone. Only a
// problem with this one record does. WP-SYNC can run this before each write.
export function checkEntitlementRecord(record, nowMs) {
    const invalid = (detail) => ({ usable: false, reason: "entitlement_record_invalid", detail });
    if (typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation < 0) {
        return invalid("invalid_generation");
    }
    const verifiedAt = parseZonedTimestamp(record.lastVerifiedAt);
    if (verifiedAt === null)
        return invalid("invalid_last_verified_at");
    if (verifiedAt > nowMs)
        return invalid("last_verified_at_in_future");
    if (!Array.isArray(record.projectMemberships))
        return invalid("memberships_not_array");
    // Legacy lease from before ADR-0008. Ignoring a passed one would let records
    // left expired by an old writer grant access again (reference ADR-0051,
    // council round 1), so a passed lease reads as no record.
    if (record.expiresAt !== undefined && record.expiresAt !== null) {
        const expiresAt = parseZonedTimestamp(record.expiresAt);
        if (expiresAt === null)
            return invalid("invalid_expires_at");
        if (expiresAt < nowMs)
            return { usable: false, reason: "entitlement_legacy_expired" };
    }
    return { usable: true };
}
// The identifier patterns onboarding writes (WP-ONB) and the gateway checks
// (WP-GW), so every 200 passes the gateway's own validation.
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isIdentifier = (value) => typeof value === "string" && IDENTIFIER.test(value);
function readGroupFields(membership) {
    const { priority, surfaces, chargebackId, restrictedFamiliesApproved } = membership;
    const surfacesOk = Array.isArray(surfaces) && surfaces.length > 0 && new Set(surfaces).size === surfaces.length
        && surfaces.every((s) => SURFACES.includes(s));
    const chargebackOk = chargebackId === null || (typeof chargebackId === "string" && CHARGEBACK_ID.test(chargebackId));
    const priorityOk = Number.isSafeInteger(priority) && priority >= 1 && priority <= MAX_PRIORITY;
    if (!surfacesOk || !chargebackOk || !priorityOk || typeof restrictedFamiliesApproved !== "boolean")
        return null;
    return { surfaces: [...surfaces], chargebackId: chargebackId, restrictedFamiliesApproved };
}
// Validates the fields the resolver returns or acts on, and returns a copy
// holding exactly those fields. WP-SYNC can run this before each write.
export function validateMembership(membership) {
    const { projectId, classification, classificationGroupId, classificationGroupDisplayName, backendId, aggregateMode } = membership;
    if (!isIdentifier(projectId))
        return { ok: false, detail: "invalid_project_id" };
    if (!isIdentifier(classification))
        return { ok: false, detail: "invalid_classification" };
    if (!isIdentifier(backendId))
        return { ok: false, detail: "invalid_backend_id" };
    if (typeof classificationGroupId !== "string" || !GROUP_ID.test(classificationGroupId)) {
        return { ok: false, detail: "invalid_classification_group_id" };
    }
    // Anything but the two known modes is malformed, never "notify": reading it
    // as notify would silently skip the aggregate check.
    if (aggregateMode !== "strict" && aggregateMode !== "notify")
        return { ok: false, detail: "invalid_aggregate_mode" };
    // Group attributes are read only under the group code, so a baseline
    // membership's approval flag grants nothing.
    const group = classification === GROUP_SCOPE_CODE ? readGroupFields(membership) : undefined;
    if (group === null)
        return { ok: false, detail: "invalid_group_attributes" };
    const familyPolicy = parseFamilyPolicy(membership.familyPolicy, classification, group?.restrictedFamiliesApproved ?? false);
    if (!familyPolicy.ok)
        return familyPolicy;
    return {
        ok: true,
        value: {
            projectId,
            classification,
            classificationGroupId: classificationGroupId.toLowerCase(),
            ...(typeof classificationGroupDisplayName === "string" ? { classificationGroupDisplayName } : {}),
            backendId,
            aggregateMode,
            familyPolicy: structuredClone(familyPolicy.value),
            ...(group !== undefined ? { group } : {}),
        },
    };
}
// Lateness is measured from the record's own validUntil. Both bounds are
// inclusive: at exactly validUntil + grace the state is still within grace.
export function classifyBudgetValidity(validUntil, nowMs, policy) {
    const until = parseZonedTimestamp(validUntil);
    if (until === null)
        return "invalid";
    const lateMs = nowMs - until;
    if (lateMs <= 0)
        return "fresh";
    if (lateMs <= policy.graceSeconds * 1000)
        return "stale_within_grace";
    if (lateMs <= policy.hardLimitSeconds * 1000)
        return "stale_beyond_grace";
    return "stale";
}
// APIM types tokens-per-minute as a 32-bit integer (WP-GW, U-35 measurement).
export const MAX_TOKENS_PER_MINUTE = 2147483647;
