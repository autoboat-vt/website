/**
 * iCalendar (RFC 5545) serialization for the AutoBoat events feed.
 *
 * The Worker exposes the same KV-cached Discord events in two formats:
 * JSON for the website's month grid (`GET /events`) and an .ics feed for
 * calendar apps (`GET /calendar.ics`). This module owns the second format.
 *
 * Recurring Discord events are emitted as a single VEVENT carrying the RRULE
 * body rather than being expanded server-side: Google, Apple, and Outlook all
 * expand RRULEs natively, and shipping the rule keeps the feed small and
 * stable as occurrences roll forward. (The website expands recurrences itself
 * because it needs concrete occurrences for the month grid -- see
 * `expandRecurrences` in `src/lib/discord.ts`.)
 *
 * Everything is serialized in UTC (`...Z` timestamps). Calendar clients
 * render those in the viewer's local timezone.
 *
 * Per-occurrence cancellations are handled by *omitting* them: the dates from
 * the description's `Cancelled:` note become `EXDATE` entries, so a subscriber
 * simply never sees those occurrences. The website takes the opposite view --
 * it renders them as visibly-cancelled chips -- because a visitor scanning the
 * month grid benefits from knowing a meeting was called off, whereas a
 * subscribed calendar should stay clean.
 */

import { toExdateValue } from "./cancellations";

/** The subset of the Worker's `CalendarEvent` this module needs. */
export interface IcsEvent {
    id: string;
    name: string;
    description: string | null;
    /** ISO-8601 start time. */
    start: string;
    /** ISO-8601 end time, or null. */
    end: string | null;
    status: "scheduled" | "active" | "completed" | "canceled";
    location: string | null;
    isRecurring: boolean;
    /** RFC 5545 RRULE body without the leading `RRULE:` prefix. */
    recurrenceRule: string | null;
    /**
     * ISO `YYYY-MM-DD` dates whose occurrence is cancelled. Emitted as
     * `EXDATE` so subscribers' calendar apps omit them. Optional: an event
     * with no cancellations may omit the field entirely.
     */
    cancelledDates?: string[];
}

export interface IcsOptions {
    /** Human-readable name shown by calendar clients, e.g. `X-WR-CALNAME`. */
    calendarName: string;
    /** Discord guild id, used to build each event's `URL` deep link. */
    guildId: string;
    /** Advertised client refresh interval in seconds. */
    refreshIntervalSeconds?: number;
    /** Injectable clock so tests can pin `DTSTAMP`. Defaults to `new Date()`. */
    now?: Date;
}

/** RFC 5545 requires CRLF line endings. */
const CRLF = "\r\n";
const PRODID = "-//AutoBoat at Virginia Tech//Events//EN";

/**
 * Fallback block length for events with no usable end time. Discord's
 * zero-duration announcements (start == end) would otherwise serialize to
 * `DTEND == DTSTART`, which violates RFC 5545 (DTEND must be later than
 * DTSTART). A one-hour block matches what most clients show for such events
 * and avoids feeds that some clients reject outright.
 */
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

/** Discord status -> iCalendar STATUS. */
const ICS_STATUS: Record<IcsEvent["status"], string> = {
    scheduled: "CONFIRMED",
    active: "CONFIRMED",
    completed: "CONFIRMED",
    canceled: "CANCELLED",
};

const encoder = new TextEncoder();

/**
 * Escape a value for an iCalendar TEXT property (RFC 5545 §3.3.11).
 * The backslash pass must run first or it would double-escape the escapes
 * added by the later passes.
 */
function escapeText(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r\n|\n|\r/g, "\\n");
}

/**
 * Fold a content line to <= 75 octets, with continuation lines starting with
 * a single space (RFC 5545 §3.1). The limit is in octets, so count UTF-8
 * bytes rather than UTF-16 code units -- splitting a multi-byte character
 * would corrupt the feed. `for...of` iterates code points, so each `ch` is a
 * whole character.
 */
function foldLine(line: string): string {
    const segments: string[] = [];
    let current = "";
    let currentBytes = 0;
    // A continued line spends one octet on its leading space, leaving 74.
    let limit = 75;
    for (const ch of line) {
        const size = encoder.encode(ch).length;
        if (currentBytes + size > limit) {
            segments.push(current);
            current = ch;
            currentBytes = size;
            limit = 74;
        } else {
            current += ch;
            currentBytes += size;
        }
    }
    segments.push(current);
    return segments.join(`${CRLF} `);
}

/** Format a Date as an iCalendar UTC timestamp: `20260920T190000Z`. */
function formatUtc(date: Date): string {
    return date
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
}

/** Build a plain (un-escaped) property line -- used for non-TEXT value types. */
function prop(name: string, value: string): string {
    return foldLine(`${name}:${value}`);
}

/** Build an escaped TEXT property line (SUMMARY, DESCRIPTION, LOCATION). */
function textProp(name: string, value: string): string {
    return foldLine(`${name}:${escapeText(value)}`);
}

function buildEvent(event: IcsEvent, options: IcsOptions, now: Date): string[] {
    const start = new Date(event.start);
    if (Number.isNaN(start.getTime())) return []; // Skip unparseable events.

    const rawEnd = event.end ? new Date(event.end) : null;
    const hasUsableEnd = rawEnd !== null && !Number.isNaN(rawEnd.getTime()) && rawEnd.getTime() > start.getTime();
    const end = hasUsableEnd && rawEnd ? rawEnd : new Date(start.getTime() + DEFAULT_DURATION_MS);

    // UID is stable per Discord event so a client updating an existing
    // subscription rewrites the event in place instead of duplicating it.
    // Recurring events keep a single UID -- RRULE drives the repetitions.
    const lines: string[] = [
        "BEGIN:VEVENT",
        prop("UID", `discord-${event.id}@autoboat.aoe.vt.edu`),
        prop("DTSTAMP", formatUtc(now)),
        prop("DTSTART", formatUtc(start)),
        prop("DTEND", formatUtc(end)),
        textProp("SUMMARY", event.name),
    ];

    if (event.description) lines.push(textProp("DESCRIPTION", event.description));
    if (event.location) lines.push(textProp("LOCATION", event.location));

    lines.push(prop("STATUS", ICS_STATUS[event.status]));
    // URL is a URI value type -- do not run it through escapeText, which
    // would mangle any comma or semicolon in the query string.
    lines.push(prop("URL", `https://discord.com/channels/${options.guildId}/${event.id}`));

    // Only emit an RRULE that looks like an RRULE body. Discord sends the
    // body without the leading "RRULE:" prefix (matching the JSON payload's
    // `recurrenceRule` field); anything else is dropped rather than risking
    // a rule that makes clients reject the whole calendar.
    if (event.isRecurring && event.recurrenceRule && /^FREQ=/i.test(event.recurrenceRule)) {
        lines.push(prop("RRULE", event.recurrenceRule));
    }

    // Per-occurrence cancellations parsed from the description's `Cancelled:`
    // convention. A subscriber should not see a meeting that was called off,
    // so these dates are excluded rather than described. EXDATE only makes
    // sense alongside an RRULE -- without one there are no generated
    // occurrences to exclude -- so it is emitted in the same branch and
    // deliberately not on one-off events.
    //
    // Each value borrows the event's own DTSTART time-of-day: clients match
    // EXDATE against DTSTART by value, so a midnight timestamp would fail to
    // exclude an evening meeting. Unparseable values are skipped rather than
    // emitted, since a malformed EXDATE can make some clients reject the
    // whole VEVENT.
    if (event.isRecurring && event.recurrenceRule) {
        const exdates = (event.cancelledDates ?? [])
            .map((d) => toExdateValue(d, event.start))
            .filter((v): v is string => v !== null);
        if (exdates.length > 0) lines.push(prop("EXDATE", exdates.join(",")));
    }

    lines.push("END:VEVENT");
    return lines;
}

/**
 * Serialize events into a complete VCALENDAR document. Malformed events are
 * skipped individually so one bad record can't break the whole feed.
 */
export function buildCalendar(events: IcsEvent[], options: IcsOptions): string {
    const now = options.now ?? new Date();
    const refresh = options.refreshIntervalSeconds ?? 3600;

    const lines: string[] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        prop("PRODID", PRODID),
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        textProp("X-WR-CALNAME", options.calendarName),
        prop("X-WR-TIMEZONE", "UTC"),
        // Hints for clients that honor them (Outlook uses X-PUBLISHED-TTL,
        // RFC 7986 clients use REFRESH-INTERVAL). Others fall back to their
        // own polling schedule.
        prop("REFRESH-INTERVAL;VALUE=DURATION", `PT${refresh}S`),
        prop("X-PUBLISHED-TTL", `PT${refresh}S`),
    ];

    for (const event of events) {
        lines.push(...buildEvent(event, options, now));
    }

    lines.push("END:VCALENDAR");
    return `${lines.join(CRLF)}${CRLF}`;
}
