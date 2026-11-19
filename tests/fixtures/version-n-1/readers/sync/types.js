export const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// ISO 8601 date-time with `Z` or an offset: the form the resolver accepts
// (src/resolver/freshness.ts on wp/res). A zone-less value is local time.
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export function parseZonedTimestamp(value) {
    if (typeof value !== "string" || !ZONED_DATE_TIME.test(value))
        return null;
    const epochMs = Date.parse(value);
    return Number.isFinite(epochMs) ? epochMs : null;
}
