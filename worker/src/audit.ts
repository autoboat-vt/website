/**
 * Guild audit-log parsing for scheduled-event deletions.
 *
 * `GET /guilds/{id}/scheduled-events` returns only `SCHEDULED`/`ACTIVE` events,
 * so a completed event and a deleted one both simply vanish from it -- an event
 * either way, and exactly why the archive keeps BOTH by default (see
 * archive.ts). The audit log is the one place that tells them apart: an entry
 * of action type 102 (`GUILD_SCHEDULED_EVENT_DELETE`) is written when an event
 * is removed, and its `target_id` is the deleted event's id.
 *
 * Discord's own description of 102 is "Event was cancelled", which is
 * misleading here: in the scheduled-event model "canceled" (status 4) is a
 * terminal status that also drops the event from the list endpoint, and the
 * audit action is specifically the DELETE endpoint (it fires a
 * `GUILD_SCHEDULED_EVENT_DELETE` Gateway event). Either way its `target_id`
 * names an event the team deliberately removed, which is exactly the case the
 * calendar should honor.
 *
 * Deliberately pure -- no bindings, no `fetch` -- so the payload shape is
 * unit-testable without Cloudflare's ambient types. `index.ts` owns the fetch.
 */

/** Discord's audit-log action type for a deleted guild scheduled event. */
export const GUILD_SCHEDULED_EVENT_DELETE = 102;

/** The subset of an audit-log entry this module reads. */
interface AuditLogEntry {
    action_type?: unknown;
    target_id?: unknown;
}

/** The subset of Discord's audit-log response this module reads. */
interface AuditLogResponse {
    audit_log_entries?: unknown;
}

/**
 * Collect the ids of events the guild audit log says were deleted.
 *
 * Returns an EMPTY set for anything unrecognisable rather than throwing: the
 * audit log is an enhancement layered on the archive's default
 * keep-everything behavior, so a malformed or absent payload must degrade to
 * "no deletions known" and leave the archive exactly as it was.
 *
 * WARNING: `target_id` is passed through opaquely -- any non-empty string is
 * accepted, with no attempt to validate that it names a scheduled event. An id
 * that names something else simply never matches an event id in the archive,
 * which is harmless, whereas rejecting an id that IS an event would silently
 * keep a deleted event on the calendar. Match ids, not shapes.
 */
export function parseDeletedEventIds(payload: unknown): Set<string> {
    const entries = (payload as AuditLogResponse | null | undefined)?.audit_log_entries;
    if (!Array.isArray(entries)) return new Set<string>();

    const ids = new Set<string>();
    for (const raw of entries) {
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as AuditLogEntry;
        if (typeof entry.action_type !== "number" || entry.action_type !== GUILD_SCHEDULED_EVENT_DELETE) continue;
        if (typeof entry.target_id === "string" && entry.target_id) {
            ids.add(entry.target_id);
        }
    }
    return ids;
}
