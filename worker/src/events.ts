/**
 * Normalization of Discord's raw GuildScheduledEvent payloads into the small
 * `CalendarEvent` shape both the website's month grid (`GET /events`) and the
 * iCalendar feed (`GET /calendar.ics`) consume.
 *
 * This module is deliberately pure -- no bindings, no `fetch`, no KV -- so the
 * raw-payload -> calendar-feed path can be exercised in a unit test without
 * Cloudflare's ambient types. `index.ts` owns the HTTP/KV/caching concerns.
 *
 * Recurrence: Discord sends `recurrence_rule` as a structured object, not an
 * RRULE string. It is converted here (via `formatRecurrenceRule`) so the JSON
 * and .ics representations can never disagree about whether an event recurs.
 *
 * Per-occurrence cancellations are parsed from the description (see
 * `cancellations.ts`) because Discord's API cannot express them. The note
 * line is stripped from the description here so it is not rendered twice.
 */

import {
    type Audience,
    type AudienceConfig,
    audienceConfigFromEnv,
    type DiscordChannel,
    isOfficerEvent,
} from "./audience";
import { parseCancelledDates, stripCancelledNote } from "./cancellations";
import { type DiscordRecurrenceRule, formatRecurrenceRule } from "./recurrence";

/** One event in the payload the website consumes. */
export interface CalendarEvent {
    id: string;
    name: string;
    description: string | null;
    start: string; // ISO-8601
    end: string | null; // ISO-8601 or null
    status: "scheduled" | "active" | "completed" | "canceled";
    location: string | null;
    userCount: number | null;
    isRecurring: boolean;
    image: string | null; // fully-qualified CDN url, or null
    /** RFC 5545 RRULE body (without the leading "RRULE:"), or null. */
    recurrenceRule: string | null;
    /**
     * Discord voice/stage channel hosting the event, or null for a channel-less
     * event. This is the field audience gating keys off: the channel's parent
     * category encodes who is allowed to see the event (see `audience.ts`).
     */
    channelId: string | null;
    /**
     * Who may see this event. Derived from `channelId`'s category, NOT from
     * Discord's `privacy_level` (which only ever means "guild members" and
     * cannot express a role-scoped audience).
     */
    audience: Audience;
    /**
     * ISO `YYYY-MM-DD` dates whose occurrence is cancelled, parsed from the
     * description's `Cancelled:` convention. The website renders these as
     * cancelled chips (they are shown, not hidden) and the `.ics` feed omits
     * them entirely. Always an array so consumers never have to null-check.
     */
    cancelledDates: string[];
}

/** Shape of a Discord Guild Scheduled Event (only the fields we read). */
export interface DiscordGuildScheduledEvent {
    id: string;
    guild_id: string;
    channel_id?: string | null;
    creator_id?: string | null;
    name: string;
    description?: string | null;
    scheduled_start_time: string;
    scheduled_end_time?: string | null;
    privacy_level: number;
    status: number;
    entity_type: number;
    entity_id?: string | null;
    entity_metadata?: { location?: string } | null;
    creator?: unknown;
    user_count?: number;
    image?: string | null;
    recurrence_rule?: DiscordRecurrenceRule | null;
}

const DISCORD_CDN_BASE = "https://cdn.discordapp.com";

/** Discord status code -> the lowercase string the website renders. */
const STATUS_BY_CODE: Record<number, CalendarEvent["status"]> = {
    1: "scheduled",
    2: "active",
    3: "completed",
    4: "canceled",
};

export function buildCdnImageUrl(event: DiscordGuildScheduledEvent): string | null {
    if (!event.image) return null;
    return `${DISCORD_CDN_BASE}/guild-events/${event.id}/${event.image}.png?size=512`;
}

export function mapStatus(code: number): CalendarEvent["status"] {
    return STATUS_BY_CODE[code] ?? "scheduled";
}

export function toCalendarEvent(e: DiscordGuildScheduledEvent): CalendarEvent {
    // Discord sends a structured recurrence rule object, not an RRULE
    // string; formatRecurrenceRule() converts it to an RFC 5545 body and
    // returns null for anything unusable. isRecurring is derived from the
    // converted rule, so a rule we cannot express never claims recurs.
    const rule = formatRecurrenceRule(e.recurrence_rule);
    const start = e.scheduled_start_time;
    // The description may carry a `Cancelled:` line listing skipped dates.
    // The event's own start year is the reference for dates written without
    // one, so parsing does not depend on today's date.
    const startYear = new Date(start).getUTCFullYear();
    const cancelledDates = parseCancelledDates(e.description, Number.isNaN(startYear) ? null : startYear);
    // Strip the note from the description: the dates are surfaced as chips on
    // the calendar, so leaving the raw line in would render them twice and
    // leak the convention into the modal body.
    const description = stripCancelledNote(e.description ?? null);
    return {
        id: e.id,
        name: e.name,
        description,
        start,
        end: e.scheduled_end_time ?? null,
        status: mapStatus(e.status),
        location: e.entity_metadata?.location ?? null,
        userCount: typeof e.user_count === "number" ? e.user_count : null,
        isRecurring: rule !== null,
        image: buildCdnImageUrl(e),
        recurrenceRule: rule,
        cancelledDates,
        channelId: e.channel_id ?? null,
        // Provisionally public. `normalizeEvents` reclassifies against the
        // channel list; a caller that uses this directly gets the fail-open
        // default (see audience.ts).
        audience: "public",
    };
}

/** Options for `normalizeEvents`. */
export interface NormalizeOptions {
    /**
     * Discord channels, used to resolve each event's category -> audience.
     * Omitted by callers that only want the raw normalization (e.g. the
     * `.ics` builder tests); an empty list means nothing can be classified as
     * officer, so everything is public (see audience.ts).
     */
    channels?: DiscordChannel[];
    /**
     * Resolved audience config. Defaults to the committed defaults.
     *
     * WARNING: Deliberately an explicit `AudienceConfig` (`officersChannelId`) and
     * NOT the raw `AudienceEnv` (`OFFICERS_CHANNEL_ID`). An earlier version
     * accepted the env shape here and callers spread the resolved config into
     * it, which silently ignored the override -- the keys differ only by
     * casing, so every event classified as public against the default id.
     * Keep the two conventions apart.
     */
    audienceConfig?: AudienceConfig;
}

/**
 * Normalize a raw Discord scheduled-events array and classify each event's
 * audience from its channel's parent category.
 *
 * Classification lives here, not in the route handlers, so the JSON and `.ics`
 * consumers can never disagree about who may see an event -- and so the filter
 * runs BEFORE the KV write, meaning a newly-hidden event can never be served
 * from a warm cache that predates the change.
 */
export function normalizeEvents(events: DiscordGuildScheduledEvent[], options: NormalizeOptions = {}): CalendarEvent[] {
    const config = options.audienceConfig ?? audienceConfigFromEnv({});
    const channels = options.channels ?? [];
    return events.map((e) => {
        const event = toCalendarEvent(e);
        return {
            ...event,
            audience: isOfficerEvent(event, config, channels) ? "officer" : "public",
        };
    });
}

/** Keep only the events the public calendar may show. */
export function publicEvents(events: CalendarEvent[]): CalendarEvent[] {
    return events.filter((e) => e.audience === "public");
}
