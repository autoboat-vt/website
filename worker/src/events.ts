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
 */

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
    return {
        id: e.id,
        name: e.name,
        description: e.description ?? null,
        start: e.scheduled_start_time,
        end: e.scheduled_end_time ?? null,
        status: mapStatus(e.status),
        location: e.entity_metadata?.location ?? null,
        userCount: typeof e.user_count === "number" ? e.user_count : null,
        isRecurring: rule !== null,
        image: buildCdnImageUrl(e),
        recurrenceRule: rule,
    };
}

/** Normalize a raw Discord scheduled-events array. */
export function normalizeEvents(events: DiscordGuildScheduledEvent[]): CalendarEvent[] {
    return events.map(toCalendarEvent);
}
