/**
 * Typed client for the AutoBoat Discord-events Cloudflare Worker.
 *
 * The Worker (see `worker/`) proxies Discord's
 *   GET /guilds/{guild_id}/scheduled-events
 * because that endpoint requires a bot token and doesn't support CORS.
 * This module fetches the Worker's single `GET /events` route and expands
 * Discord `recurrence_rule` RRULEs into concrete occurrences for a given
 * time window (used by the calendar month grid).
 *
 * Wire format notes:
 *  - The Worker returns `CalendarEvent[]` (a small, normalized shape --
 *    not Discord's raw GuildScheduledEvent).
 *  - Dates are ISO-8601 strings.
 *  - Events carry a `recurrenceRule` string in RFC 5545 RRULE form (without
 *    the leading `RRULE:` prefix) when the Discord event is recurring.
 *  - Discord event `status` arrives pre-mapped to a lowercase string.
 */

import { rrulestr } from "rrule";

/**
 * Base URL of the Discord-events Worker. Override per-environment with
 * `VITE_EVENTS_URL` (e.g. pointing at `wrangler dev` on localhost:8787).
 *
 * We read this from `globalThis.__VITE_EVENTS_URL__` (populated by Vite's
 * `define` in vite.config.ts) rather than `import.meta.env` so the source
 * parses under Jest's CJS runtime, where `import.meta` is a syntax error.
 */
declare global {
    // eslint-disable-next-line no-var
    var __VITE_EVENTS_URL__: string | undefined;
}

export const EVENTS_URL: string =
    globalThis.__VITE_EVENTS_URL__ || "https://autoboat-discord-events.autoboat-at-virginia-tech.workers.dev";

/**
 * Discord guild (server) ID whose scheduled events we're displaying. Public
 * config -- anyone in the guild can see this value. Used to deep-link event
 * chips to Discord (`https://discord.com/channels/{guildId}/{eventId}`).
 * Keep in sync with `DISCORD_GUILD_ID` in `worker/wrangler.jsonc`.
 */
export const DISCORD_GUILD_ID = "1017960606403416085";

/** One event as served by the Worker's `GET /events` route. */
export interface CalendarEvent {
    id: string;
    name: string;
    description: string | null;
    /** ISO-8601 start time. */
    start: string;
    /** ISO-8601 end time, or null. */
    end: string | null;
    status: "scheduled" | "active" | "completed" | "canceled";
    location: string | null;
    userCount: number | null;
    isRecurring: boolean;
    /** Fully-qualified CDN URL for the event's cover image, or null. */
    image: string | null;
    /** RFC 5545 RRULE body (without the leading "RRULE:" prefix), or null. */
    recurrenceRule: string | null;
}

/** A concrete instance of a CalendarEvent within a specific time window. */
export interface ExpandedOccurrence {
    /** The underlying Discord event. */
    event: CalendarEvent;
    /** Start of this specific occurrence. */
    start: Date;
    /** End of this specific occurrence (start + event duration, or same as start). */
    end: Date;
}

/** Errors raised by this module's network calls. */
export class DiscordError extends Error {
    readonly statusCode?: number;

    constructor(message: string, statusCode?: number) {
        super(message);
        this.name = "DiscordError";
        this.statusCode = statusCode;
    }
}

const FETCH_TIMEOUT_MS = 8_000;

/**
 * Fetch + JSON-parse with a hard timeout and a caller-supplied abort signal,
 * mirroring the wrapper in `src/lib/telemetry.ts`.
 */
async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) {
            controller.abort();
        } else {
            signal.addEventListener("abort", onCallerAbort, { once: true });
        }
    }
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            headers: { Accept: "application/json" },
            mode: "cors",
            // The worker sends `Cache-Control: public, max-age=<TTL>`; without
            // no-store the browser would serve its own cached response and the
            // calendar's background polls would never see fresher data.
            cache: "no-store",
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new DiscordError(
                `Events request failed with status ${response.status} (${response.statusText})`,
                response.status,
            );
        }
        try {
            return (await response.json()) as T;
        } catch {
            throw new DiscordError("Events response was not valid JSON");
        }
    } finally {
        clearTimeout(timer);
        if (signal) {
            signal.removeEventListener("abort", onCallerAbort);
        }
    }
}

function isCalendarEvent(value: unknown): value is CalendarEvent {
    if (typeof value !== "object" || value === null) return false;
    const e = value as Record<string, unknown>;
    return (
        typeof e.id === "string" &&
        typeof e.name === "string" &&
        typeof e.start === "string" &&
        (e.end === null || typeof e.end === "string") &&
        typeof e.status === "string" &&
        typeof e.isRecurring === "boolean"
    );
}

/**
 * Extract a human-readable physical location from the free-text Discord
 * event description, and remove the matched text from the description so the
 * location isn't rendered twice (once in the event modal's location row and
 * again in the description body). Used because the team's events are
 * structured as voice-channel events (so role scoping can be applied during
 * signup), which leaves Discord's native `entity_metadata.location` empty;
 * the physical meetup location is written into the description instead.
 *
 * Heuristics, in priority order:
 *  1. A line labeled `Location:` or `Where:` (case-insensitive) -- the whole
 *     line is removed from the description.
 *  2. The first bold span (`**...**`) -- the team's convention is to bold
 *     the venue; just the span is removed.
 *
 * Returns `{ location, description }`. `location` is null when no pattern
 * matches (the caller then keeps "No location specified" and renders no
 * map). `description` is null when nothing meaningful remains after removal.
 */
export function extractLocationFromDescription(description: string | null): {
    location: string | null;
    description: string | null;
} {
    if (!description) return { location: null, description };

    // Strip Discord bold/underline markers (``**x**``, ``__x__``) so the
    // result is a clean string for display and geocoding.
    const clean = (s: string) => s.replace(/\*\*|__/g, "").trim();

    const lines = description.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const m = (lines[i] ?? "").match(/^\s*(?:location|where)\s*[:\u2013\u2014-]\s*(.+)$/i);
        if (m?.[1]) {
            const value = clean(m[1]);
            const rest = lines
                .filter((_, j) => j !== i)
                .join("\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
            return { location: value, description: rest || null };
        }
    }

    const bold = description.match(/\*\*([^*\n]+)\*\*/);
    if (bold?.[1]) {
        const value = clean(bold[1]);
        // Remove just the bold span, then tidy leftover double spaces and
        // spaces stranded before punctuation.
        const stripped = description
            .replace(bold[0], "")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/[ \t]+([.,!?;:])/g, "$1")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        return { location: value, description: stripped || null };
    }

    return { location: null, description };
}

/**
 * Fetch the current events list from the Worker.
 *
 * Returns an empty array when the payload is structurally invalid (rather
 * than throwing) so the calendar can fall back to its "no events" state.
 * Throws `DiscordError` on network/HTTP errors so the page can surface a
 * specific message.
 */
export async function fetchEvents(signal?: AbortSignal): Promise<CalendarEvent[]> {
    const data = await fetchJson<unknown>(`${EVENTS_URL}/events`, signal);
    if (!Array.isArray(data)) return [];
    return data.filter(isCalendarEvent).map((ev) => {
        if (ev.location != null) return ev;
        const { location, description } = extractLocationFromDescription(ev.description);
        return { ...ev, location, description };
    });
}

/** Build the Discord URL for an event chip's "View in Discord" link. */
export function discordEventUrl(event: CalendarEvent): string {
    return `https://discord.com/channels/${DISCORD_GUILD_ID}/${event.id}`;
}

/**
 * Absolute URL of the Worker's iCalendar feed (`GET /calendar.ics`). This is
 * the URL users subscribe to from a calendar app, and the one the
 * subscription buttons on the calendar page point at.
 */
export const EVENTS_ICS_URL = `${EVENTS_URL}/calendar.ics`;

/**
 * The feed URL rewritten to the `webcals://` scheme. Clicking a `webcals://`
 * link hands the URL to the OS's registered calendar app (Apple Calendar,
 * Outlook on Windows/macOS) instead of the browser downloading the file.
 *
 * Uses the secure `webcals://` form, not `webcal://`: the plain form is
 * increasingly rejected by OS handlers and apps. Derived from
 * `EVENTS_ICS_URL` so both stay in sync automatically.
 */
export function webcalUrl(): string {
    return EVENTS_ICS_URL.replace(/^https?:\/\//, "webcals://");
}

/**
 * Deep link to Google Calendar's "Add by URL" dialog.
 *
 * Deliberately NOT the classic `calendar/render?cid=<feedUrl>` form. Google's
 * `cid` handler is unreliable for external feeds: it commonly reports "Unable
 * to add calendar. Check the URL" (or subscribes with no events) for a feed
 * that the identical URL adds fine via Settings > Add calendar > From URL.
 * Multiple users reported this in Google's support forum starting Sept 2025,
 * across `cid=https://` and `cid=webcal://` forms alike, and the manual dialog
 * remained the only reliable path.
 *
 * So we open that dialog directly and let the user paste the feed URL.
 * `CalendarSubscribe` copies the URL to the clipboard when this link is
 * clicked so it is ready to paste on the next screen.
 */
export function googleCalendarSubscribeUrl(): string {
    return "https://calendar.google.com/calendar/r/settings/addbyurl";
}

/**
 * "Subscribe from web" deep link for Outlook on the web. The desktop and
 * mobile Outlook apps read the same feed via the `webcal://` URL.
 */
export function outlookSubscribeUrl(): string {
    const params = new URLSearchParams({
        url: EVENTS_ICS_URL,
        name: "AutoBoat at Virginia Tech",
    });
    return `https://outlook.live.com/calendar/0/addfromweb?${params.toString()}`;
}

/**
 * Expand Discord events into concrete occurrences intersecting `[from, to]`.
 *
 * Non-recurring events produce a single occurrence (the event itself) when
 * their [start, end] interval overlaps the window. Recurring events are
 * expanded via their RRULE: every recurrence inside the window becomes one
 * occurrence, each shifted by the same start/end duration as the base event.
 *
 * The output is sorted by occurrence start time.
 */
export function expandRecurrences(events: CalendarEvent[], from: Date, to: Date): ExpandedOccurrence[] {
    const out: ExpandedOccurrence[] = [];
    const fromMs = from.getTime();
    const toMs = to.getTime();

    for (const event of events) {
        const baseStart = new Date(event.start);
        const baseEnd = event.end ? new Date(event.end) : baseStart;
        if (Number.isNaN(baseStart.getTime()) || Number.isNaN(baseEnd.getTime())) {
            continue; // Skip events with malformed dates rather than throwing.
        }
        const durationMs = baseEnd.getTime() - baseStart.getTime();

        if (event.isRecurring && event.recurrenceRule) {
            try {
                // Discord's recurrence_rule is the RRULE body without the
                // leading "RRULE:" prefix; rrulestr expects the full value.
                const rule = rrulestr(`RRULE:${event.recurrenceRule}`, {
                    dtstart: baseStart,
                });
                for (const occurrenceStart of rule.between(from, to, true)) {
                    out.push({
                        event,
                        start: occurrenceStart,
                        end: new Date(occurrenceStart.getTime() + durationMs),
                    });
                }
            } catch {
                // Malformed RRULE -- fall back to a single occurrence at the
                // base start time so the event at least shows up once.
                if (baseStart.getTime() <= toMs && baseEnd.getTime() >= fromMs) {
                    out.push({ event, start: baseStart, end: baseEnd });
                }
            }
        } else if (baseStart.getTime() <= toMs && baseEnd.getTime() >= fromMs) {
            out.push({ event, start: baseStart, end: baseEnd });
        }
    }

    out.sort((a, b) => a.start.getTime() - b.start.getTime());
    return out;
}
