/**
 * Validation and translation for events created from the website.
 *
 * The browser POSTs a small, friendly payload; this module turns it into
 * Discord's `POST /guilds/{id}/scheduled-events` body. It is pure (no
 * bindings, no `fetch`) so every rule here is unit-testable, and it is the
 * ONLY place that constructs a Discord create payload -- so limits and field
 * requirements cannot drift between the route handler and a future caller.
 *
 * FIELD REQUIREMENTS (from Discord's docs, see "Field Requirements By Entity
 * Type"): a VOICE event needs `channel_id` and must have `entity_metadata:
 * null`; an EXTERNAL event needs `channel_id: null`, a non-null
 * `entity_metadata.location`, AND `scheduled_end_time`. Those are structural,
 * so they are enforced here rather than left to a 400 from Discord.
 *
 * LIMITS: `name` is 1-100 characters, `description` 1-1000 (or null),
 * `location` 1-100. Discord silently accepts some overlong values and
 * truncates others, so they are rejected with a clear message instead.
 *
 * RECURRENCE: Discord's rule object is a constrained subset of RFC 5545, and
 * the constraints are the interesting part -- a WEEKLY rule may name exactly
 * ONE weekday, `interval` may only exceed 1 for WEEKLY (and only up to 2), and
 * `end` / `count` / `by_year_day` CANNOT be set by an application at all. A
 * rule that violates any of those is rejected here rather than producing a
 * 400 that the user cannot interpret, and the form only offers the
 * combinations Discord actually supports.
 *
 * WARNING: `end` and `count` are deliberately absent from the accepted input. They
 * are documented as "cannot be set externally", so accepting them would create
 * an infinite series while the UI claimed it ended. An infinite series is
 * still deletable from the website's point of view only via Discord; see the
 * note on the form.
 */

import type { DiscordRecurrenceRule } from "./recurrence";

/** Discord's documented field limits. */
export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_LOCATION_LENGTH = 100;

/** Discord entity type codes this module can produce. */
export const ENTITY_VOICE = 2;
export const ENTITY_EXTERNAL = 3;

/** Discord privacy level: guild-only. The only value the API accepts. */
export const PRIVACY_GUILD_ONLY = 2;

/** Discord recurrence frequency codes. */
export const FREQUENCY = { YEARLY: 0, MONTHLY: 1, WEEKLY: 2, DAILY: 3 } as const;

/** Discord recurrence weekday codes (0 = Monday .. 6 = Sunday). */
export const WEEKDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** Recurrence as accepted from the browser. */
export interface CreateRecurrenceInput {
    frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
    /** Spacing between occurrences. Discord allows > 1 for WEEKLY only (max 2). */
    interval?: number;
    /** Discord weekday codes, 0 = Monday .. 6 = Sunday. */
    byWeekday?: number[];
    /** Ordinal weekday, e.g. `{ n: 4, day: 2 }` = 4th Wednesday. MONTHLY only. */
    byNWeekday?: { n: number; day: number }[];
    /** MONTHLY/YEARLY month, 1-12. YEARLY requires this AND `byMonthDay`. */
    byMonth?: number[];
    /** Day of month, 1-31. */
    byMonthDay?: number[];
}

/** The payload the browser sends to `POST /manage/events`. */
export interface CreateEventInput {
    name: string;
    description?: string | null;
    /** ISO-8601 instant. */
    start: string;
    /** ISO-8601 instant, or null. Required for EXTERNAL events. */
    end?: string | null;
    /** Discord voice/stage channel id, or null for an EXTERNAL event. */
    channelId?: string | null;
    /** Physical place or link. Required for EXTERNAL events. */
    location?: string | null;
    recurrence?: CreateRecurrenceInput | null;
}

/** The body sent to Discord's create endpoint. */
export interface DiscordCreateEventBody {
    name: string;
    description: string | null;
    scheduled_start_time: string;
    scheduled_end_time?: string;
    channel_id?: string;
    entity_metadata?: { location: string };
    entity_type: number;
    privacy_level: number;
    recurrence_rule?: DiscordRecurrenceRule;
}

/** Validated, Discord-ready output plus what the caller needs for the response. */
export interface ValidatedCreateEvent {
    body: DiscordCreateEventBody;
    /** Whether this event will be officer-only, so the form can say so. */
    officerOnly: boolean;
}

export type ValidationResult = { ok: true; value: ValidatedCreateEvent } | { ok: false; error: string };

/**
 * Collapse whitespace and reject anything that is only whitespace.
 *
 * Discord rejects an all-whitespace name with a 400 that does not say which
 * field was at fault, so this catches it locally.
 */
function cleanText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseInstant(value: unknown): Date | null {
    if (typeof value !== "string" || value.trim() === "") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && /^\d{15,20}$/.test(value);
}

/**
 * Append a `Location:` line to the description.
 *
 * The website only renders a physical venue when the description carries an
 * explicit `Location: <value>` line (see `extractLocationFromDescription` in
 * src/lib/discord.ts) -- Discord's `entity_metadata.location` is always null
 * on VOICE events, which is what team events are. An event created here with a
 * location but no such line would therefore show no venue on the site, which
 * is exactly the kind of silent disagreement between the form and the calendar
 * this module exists to prevent.
 *
 * An existing `Location:` line is left alone: the user already said what they
 * meant, and appending a second one would make the parser pick the first while
 * a reader sees both.
 */
export function withLocationLine(description: string | null, location: string | null): string | null {
    if (!location) return description;
    if (description && /^\s*(?:location|where)\s*[:\u2013\u2014-]/im.test(description)) return description;
    return description ? `${description}\n\nLocation: ${location}` : `Location: ${location}`;
}

/**
 * Validate a recurrence rule against Discord's documented combinations.
 *
 * Every branch returns a human-readable reason: these messages reach the form,
 * and "invalid recurrence" would leave the user guessing which of five
 * constraints they violated.
 */
export function validateRecurrence(
    input: CreateRecurrenceInput,
    start: Date,
): { ok: true; rule: DiscordRecurrenceRule } | { ok: false; error: string } {
    const frequency = FREQUENCY[input.frequency];
    if (frequency === undefined) return { ok: false, error: "Unsupported repeat frequency." };

    const interval = input.interval ?? 1;
    if (!Number.isInteger(interval) || interval < 1) {
        return { ok: false, error: "Repeat interval must be a whole number of at least 1." };
    }
    if (interval > 1 && input.frequency !== "WEEKLY") {
        return { ok: false, error: "Discord only supports an interval greater than 1 for weekly events." };
    }
    if (interval > 2) {
        return { ok: false, error: "Discord supports at most every other week for repeating events." };
    }

    const byWeekday = input.byWeekday ?? [];
    const byNWeekday = input.byNWeekday ?? [];
    const byMonth = input.byMonth ?? [];
    const byMonthDay = input.byMonthDay ?? [];

    // Mutually exclusive per Discord: by_weekday, by_n_weekday, and
    // by_month+by_month_day. Naming more than one produces a 400.
    const families = [byWeekday.length > 0, byNWeekday.length > 0, byMonth.length > 0 || byMonthDay.length > 0].filter(
        Boolean,
    ).length;
    if (families > 1) {
        return {
            ok: false,
            error: "Pick one repeat pattern: days of the week, a week of the month, or a calendar date.",
        };
    }

    for (const day of [...byWeekday, ...byNWeekday.map((e) => e.day)]) {
        if (!Number.isInteger(day) || day < 0 || day > 6) {
            return { ok: false, error: "Repeat day must be a weekday from Monday (0) to Sunday (6)." };
        }
    }

    if (input.frequency === "WEEKLY" && byWeekday.length > 1) {
        return { ok: false, error: "A weekly event repeats on exactly one day. Use daily for several days a week." };
    }

    if (input.frequency === "DAILY" && byWeekday.length > 0) {
        // Discord only accepts a fixed set of weekday combinations for DAILY.
        const ALLOWED_DAILY_SETS = ["0,1,2,3,4", "1,2,3,4,5", "6,0,1,2,3", "4,5", "5,6", "6,0"];
        const asKey = [...new Set(byWeekday)].sort((a, b) => a - b).join(",");
        const normalized = [0, 1, 2, 3, 4, 5, 6].filter((d) => byWeekday.includes(d)).join(",");
        if (!ALLOWED_DAILY_SETS.includes(asKey) && !ALLOWED_DAILY_SETS.includes(normalized)) {
            return { ok: false, error: "Discord only supports a few weekday sets for daily events." };
        }
    }

    if (byNWeekday.length > 0) {
        if (input.frequency !== "MONTHLY") {
            return { ok: false, error: "A week-of-month pattern is only valid for monthly events." };
        }
        if (byNWeekday.length > 1) {
            return { ok: false, error: "Discord supports one week-of-month day per repeating event." };
        }
        const entry = byNWeekday[0];
        if (!entry || !Number.isInteger(entry.n) || entry.n < 1 || entry.n > 5) {
            return { ok: false, error: "Week of month must be from 1 to 5." };
        }
    }

    if (byMonth.length > 0 || byMonthDay.length > 0) {
        if (input.frequency !== "YEARLY") {
            return { ok: false, error: "A calendar date (month and day) is only valid for yearly events." };
        }
        if (byMonth.length !== 1 || byMonthDay.length !== 1) {
            return { ok: false, error: "Discord supports one calendar date per yearly event." };
        }
        const month = byMonth[0];
        const day = byMonthDay[0];
        if (month === undefined || !Number.isInteger(month) || month < 1 || month > 12) {
            return { ok: false, error: "Month must be from 1 to 12." };
        }
        if (day === undefined || !Number.isInteger(day) || day < 1 || day > 31) {
            return { ok: false, error: "Day of month must be from 1 to 31." };
        }
    }

    // WARNING: The rule object's `start` is REQUIRED by Discord even though the
    // event already carries `scheduled_start_time`; omitting it is a 400.
    const rule: DiscordRecurrenceRule = {
        start: start.toISOString(),
        frequency,
        interval,
    };
    if (byWeekday.length > 0) rule.by_weekday = [...byWeekday];
    if (byNWeekday.length > 0) rule.by_n_weekday = byNWeekday.map(({ n, day }) => ({ n, day }));
    if (byMonth.length > 0) rule.by_month = [...byMonth];
    if (byMonthDay.length > 0) rule.by_month_day = [...byMonthDay];

    return { ok: true, rule };
}

/**
 * Validate a browser payload and produce a Discord create body.
 *
 * `officersChannelId` is passed in only so the response can report the
 * resulting audience back to the form ("this will be officer-only"). It does
 * NOT gate anything: only officers can reach this code at all (see
 * permissions.ts), and an officer may schedule into any channel.
 */
export function validateCreateEvent(
    input: unknown,
    officersChannelId: string | null,
    now: Date = new Date(),
): ValidationResult {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, error: "Expected a JSON object." };
    }
    const raw = input as CreateEventInput;

    const name = cleanText(raw.name);
    if (!name) return { ok: false, error: "Event name is required." };
    if (name.length > MAX_NAME_LENGTH) {
        return { ok: false, error: `Event name must be ${MAX_NAME_LENGTH} characters or fewer.` };
    }

    const start = parseInstant(raw.start);
    if (!start) return { ok: false, error: "Start time is required and must be a valid date and time." };
    // A generous grace window rather than a strict "future only": a form that
    // takes a minute to fill in should not reject a start time chosen at the
    // start of that minute, and clock skew is real. Anything further in the
    // past is almost certainly a typo (or a wrong year).
    if (start.getTime() < now.getTime() - 5 * 60 * 1000) {
        return { ok: false, error: "Start time must not be in the past." };
    }

    const end = raw.end === null || raw.end === undefined ? null : parseInstant(raw.end);
    if (raw.end !== null && raw.end !== undefined && !end) {
        return { ok: false, error: "End time must be a valid date and time." };
    }
    if (end && end.getTime() <= start.getTime()) {
        return { ok: false, error: "End time must be after the start time." };
    }

    const rawDescription = cleanText(raw.description);
    if (rawDescription && rawDescription.length > MAX_DESCRIPTION_LENGTH) {
        return { ok: false, error: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` };
    }

    const channelId = raw.channelId === null || raw.channelId === undefined ? null : raw.channelId;
    const location = cleanText(raw.location);
    if (location && location.length > MAX_LOCATION_LENGTH) {
        return { ok: false, error: `Location must be ${MAX_LOCATION_LENGTH} characters or fewer.` };
    }

    const isExternal = channelId === null;

    if (isExternal) {
        // EXTERNAL: no channel, a real venue, and an end time are all required.
        if (!location) {
            return { ok: false, error: "An event without a Discord channel needs a location." };
        }
        if (!end) {
            return { ok: false, error: "An event without a Discord channel needs an end time." };
        }
    } else if (!isSnowflake(channelId)) {
        // Reject a non-numeric channel id here rather than letting Discord 400.
        return { ok: false, error: "Discord channel id is invalid." };
    }

    const description = withLocationLine(rawDescription, isExternal ? null : location);

    const body: DiscordCreateEventBody = {
        name,
        description: description ?? null,
        scheduled_start_time: start.toISOString(),
        entity_type: isExternal ? ENTITY_EXTERNAL : ENTITY_VOICE,
        privacy_level: PRIVACY_GUILD_ONLY,
    };

    if (isExternal) {
        // Discord requires entity_metadata with a location for EXTERNAL and
        // requires it to be NULL for VOICE -- so it is only ever set here.
        body.entity_metadata = { location: location as string };
        body.scheduled_end_time = (end as Date).toISOString();
    } else {
        body.channel_id = channelId as string;
        if (end) body.scheduled_end_time = end.toISOString();
    }

    if (raw.recurrence) {
        const result = validateRecurrence(raw.recurrence, start);
        if (!result.ok) return result;
        body.recurrence_rule = result.rule;
    }

    return {
        ok: true,
        value: {
            body,
            // Keyed on CHANNEL, exactly like the read path's audience rule, so
            // the form reports the same audience the calendar will classify it
            // into. Informational only -- see the note above.
            officerOnly: channelId !== null && officersChannelId !== null && channelId === officersChannelId,
        },
    };
}
