/**
 * Retention for Discord guild scheduled events.
 *
 * Discord's `GET /guilds/{id}/scheduled-events` returns ONLY events whose
 * status is `SCHEDULED` or `ACTIVE`. Both `COMPLETED` and `CANCELED` are
 * terminal states, so the moment an event ends it drops out of that list --
 * and because the Worker's KV cache stores exactly what the list returned,
 * the event disappears from the website and the `.ics` feed with it. Nothing
 * on the website filters past events; there is simply nothing left to render.
 *
 * This module is the archive that closes that gap: each time the Worker
 * refetches Discord it merges the fresh list over the previously stored one
 * and keeps the events that fell out, so past events stay on the calendar.
 *
 * Retention is UNBOUNDED BY DEFAULT -- every event the Worker has ever seen is
 * kept, because "Discord stopped reporting it" is the only signal available
 * and it is also what happens to every event that simply finishes. Age-based
 * pruning is available by setting `RETENTION_DAYS`, but it is opt-in: the team
 * asked to keep the whole history. See `KEEP_FOREVER_MS`.
 *
 * It is deliberately pure -- no bindings, no `fetch`, no KV -- so the merge
 * rules are unit-testable without Cloudflare's ambient types. `index.ts` owns
 * the KV read/write and the freshness decision.
 */

import type { CalendarEvent } from "./events";

/**
 * Sentinel meaning "never drop an archived event for being old".
 *
 * Expressed as `Infinity` rather than a large number so the age comparison in
 * `withinRetention` is always true without a separate boolean flag, and so an
 * accidental arithmetic slip cannot silently reintroduce a cutoff.
 */
export const KEEP_FOREVER_MS = Number.POSITIVE_INFINITY;

/**
 * A stored cache entry: the events plus when they were fetched.
 *
 * The timestamp is what makes retention possible at all. KV's own
 * `expirationTtl` can only expire the whole key, so freshness has to be
 * tracked in the value -- the key itself now outlives the cache TTL.
 */
export interface EventsCacheEntry {
    /** Epoch milliseconds of the Discord fetch that produced `events`. */
    fetchedAt: number;
    events: CalendarEvent[];
}

/**
 * Safety ceiling on the number of events held in one entry.
 *
 * This is NOT a retention policy -- retention is unbounded by default (see
 * `KEEP_FOREVER_MS`). It exists only so an unbounded history cannot grow past
 * what a single KV value can hold: KV values cap at 25 MiB and the whole
 * archive is serialized on every write, so a runaway history would eventually
 * make every write fail, which is the failure mode that blanks the calendar.
 *
 * At a few hundred bytes per event this is roughly a 600 KB ceiling, which is
 * ~50 years of weekly meetings. Reaching it means something is wrong (e.g. a
 * mis-scoped guild), not that the team has too much history.
 */
export const MAX_ARCHIVED_EVENTS = 2000;

/**
 * End of an event in epoch ms. Discord may omit `scheduled_end_time`, and a
 * zero-length or malformed event should still be treated as occupying its
 * start instant, so the start is the floor.
 */
function eventEndMs(event: CalendarEvent): number {
    const start = new Date(event.start).getTime();
    const end = event.end ? new Date(event.end).getTime() : start;
    if (Number.isNaN(start)) return Number.NaN;
    if (Number.isNaN(end)) return start;
    return Math.max(start, end);
}

/**
 * True when a stored event is recent enough to keep.
 *
 * With the default `KEEP_FOREVER_MS` this is always true, so nothing is ever
 * dropped for being old. NaN ends (an event whose dates are unparseable) are
 * still dropped: such a record can never age out under ANY window, so keeping
 * it would let one malformed entry live forever.
 */
function withinRetention(event: CalendarEvent, nowMs: number, retentionMs: number): boolean {
    const endMs = eventEndMs(event);
    if (Number.isNaN(endMs)) return false;
    return endMs >= nowMs - retentionMs;
}

/**
 * Mark an event Discord no longer reports so the calendar can style it as
 * history.
 *
 * Three cases:
 *  - already `canceled` -- kept as-is, since a called-off meeting is styled
 *    differently from one that happened.
 *  - already ended -- rewritten to `completed`.
 *  - not ended yet -- status left ALONE. This is the case that only arises
 *    because retention keeps everything: a future event that vanished from
 *    Discord is kept, but calling it `completed` would claim a meeting
 *    happened that never did. It stays `scheduled` and renders normally.
 */
function asArchived(event: CalendarEvent, nowMs: number): CalendarEvent {
    if (event.status === "canceled") return event;
    const endMs = eventEndMs(event);
    if (Number.isNaN(endMs) || endMs >= nowMs) return event;
    return { ...event, status: "completed" };
}

/**
 * Merge the freshly fetched events over the stored archive.
 *
 * Rules, in order:
 *
 * 1. **Fresh wins.** Any event still present in Discord's list is taken from
 *    `fresh` verbatim -- its name, description, status, and rolling start time
 *    may all have changed since it was cached.
 * 2. **Every event that fell out of the list is kept.** This is the retention
 *    case, and it is deliberately unconditional: Discord drops an event for
 *    exactly two reasons -- it completed, or it was removed -- and the API
 *    cannot tell them apart, so the archive keeps both. An event that had
 *    ended is marked `completed`; one that had not is left as-is (see
 *    `asArchived`).
 * 3. **Malformed events are dropped**, because an entry whose dates cannot be
 *    parsed can never be reasoned about or aged out.
 * 4. **Nothing is dropped for being old** unless a finite `retentionMs` is
 *    passed in, which is opt-in. The result is still held under
 *    `MAX_ARCHIVED_EVENTS`, a safety ceiling rather than a policy.
 *
 * The merge is keyed on Discord's event id, which is stable per event, so an
 * event is never duplicated by being seen twice.
 */
export function mergeArchive(
    stored: CalendarEvent[],
    fresh: CalendarEvent[],
    now: Date,
    retentionMs: number = KEEP_FOREVER_MS,
): CalendarEvent[] {
    const nowMs = now.getTime();
    const freshIds = new Set(fresh.map((e) => e.id));

    const archived = stored
        .filter((e) => !freshIds.has(e.id))
        // Rule 3: a record we cannot date is unusable rather than merely old.
        .filter((e) => !Number.isNaN(eventEndMs(e)))
        // Rule 4: always true at the default KEEP_FOREVER_MS.
        .filter((e) => withinRetention(e, nowMs, retentionMs))
        .map((e) => asArchived(e, nowMs));

    const merged = [...fresh, ...archived];

    if (merged.length <= MAX_ARCHIVED_EVENTS) {
        return merged.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    }

    // Over the safety ceiling: keep everything upcoming, then the most recent
    // past events, and drop the oldest history. Only reachable if the archive
    // has grown absurdly large.
    const upcoming = merged.filter((e) => eventEndMs(e) >= nowMs);
    const past = merged
        .filter((e) => eventEndMs(e) < nowMs)
        .sort((a, b) => eventEndMs(b) - eventEndMs(a))
        .slice(0, Math.max(0, MAX_ARCHIVED_EVENTS - upcoming.length));

    return [...upcoming, ...past].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

/**
 * Parse a stored KV value into an archive entry.
 *
 * Tolerates the pre-retention cache shape (a bare array) by reporting a
 * `fetchedAt` of 0, which reads as infinitely stale -- so an entry written by
 * an older Worker version is simply refetched and rewritten in the new shape
 * on first use, rather than being dropped and leaving the calendar empty.
 *
 * Returns null for anything unrecognisable, which the caller treats as a
 * miss.
 */
export function parseCacheEntry(value: unknown): EventsCacheEntry | null {
    if (Array.isArray(value)) {
        return { fetchedAt: 0, events: value as CalendarEvent[] };
    }
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (!Array.isArray(entry.events)) return null;
    const fetchedAt = typeof entry.fetchedAt === "number" && Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0;
    return { fetchedAt, events: entry.events as CalendarEvent[] };
}

/**
 * Whether a stored entry is still fresh enough to serve without refetching.
 *
 * Freshness is now a property of the value rather than KV's expiry, because
 * the key outlives the cache TTL by design (see `EventsCacheEntry`). A
 * `fetchedAt` of 0 from a legacy entry is always stale.
 */
export function isFresh(entry: EventsCacheEntry, now: Date, ttlMs: number): boolean {
    if (entry.fetchedAt <= 0) return false;
    return now.getTime() - entry.fetchedAt < ttlMs;
}
