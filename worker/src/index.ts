/**
 * autoboat-discord-events Worker
 *
 * Serves a normalized JSON list of Discord guild scheduled events to the
 * AutoBoat website, without exposing the Discord bot token in the browser.
 * Also serves the same events as an iCalendar (.ics) feed so the team
 * calendar can be subscribed to from Google Calendar / Apple Calendar /
 * Outlook.
 *
 * Routes:
 *   GET /events            -- normalized JSON, PUBLIC events only.
 *   GET /calendar.ics      -- the same public events as an iCalendar feed.
 *   GET /officers/events   -- JSON including officer-only events.
 *   GET /officers/calendar.ics -- the same broader set as a feed.
 *   GET /audiences         -- diagnostics: every category the Worker sees,
 *                             flagged with the audience it maps to.
 *
 * Audience gating (see audience.ts): the team restricts an event inside
 * Discord by hosting it in a voice channel only the intended audience can
 * see. The event's audience is therefore the audience of that channel's
 * PARENT CATEGORY. The public routes serve `audience: "public"` events only;
 * the `/officers` routes serve everything. Because the bot can see every
 * channel, the Worker must filter explicitly -- Discord's own permissions do
 * not apply to it.
 *
 * The officer routes are intentionally NOT secret. They are unguessable
 * addresses, not protected ones: anyone with the URL can read them. This was
 * an explicit product decision -- there is no key or login.
 *
 * Flow per request (JSON + .ics share it):
 *   1. Preflight (`OPTIONS`)         -> 204 with CORS headers.
 *   2. Cache hit (KV)                -> render from the cached events.
 *   3. Cache miss                    -> fetch
 *      GET https://discord.com/api/v10/guilds/{DISCORD_GUILD_ID}/scheduled-events?with_user_count=true
 *      and .../channels, with `Authorization: Bot ${DISCORD_BOT_TOKEN}`,
 *      normalize + classify, write to KV (waitUntil).
 *   JSON responses report X-Cache: HIT|MISS.
 *
 * Both Discord resources are cached, because they change together and a
 * category rename (or adding an officer channel) must not serve stale
 * classification. See EVENTS_KV_KEY / CHANNELS_KV_KEY below.
 *
 * Discord upstream errors are returned as a generic 502 with CORS headers
 * intact; the bot token is never logged, echoed, or included in responses.
 *
 * CORS: the only allowed origin is ALLOWED_ORIGIN (default
 * https://autoboat.aoe.vt.edu). Non-matching browsers are blocked at the
 * browser level; server-side/curl clients can still hit the URL directly.
 * Calendar clients fetching the .ics are not browsers and ignore CORS
 * entirely, so the feed works regardless of the origin lockdown.
 */

import {
    type Audience,
    audienceConfigFromEnv,
    audienceIsConfigured,
    type DiscordChannel,
    listCategories,
    listChannels,
} from "./audience";
import { type CalendarEvent, type DiscordGuildScheduledEvent, normalizeEvents, publicEvents } from "./events";
import { buildCalendar } from "./ics";

interface Env {
    DISCORD_BOT_TOKEN: string;
    DISCORD_GUILD_ID: string;
    ALLOWED_ORIGIN: string;
    CACHE_TTL_SECONDS: string;
    /** Display name subscribers see in their calendar app. Optional. */
    CALENDAR_NAME?: string;
    /**
     * The officer-only voice channel id. Defaults to the committed value in
     * audience.ts. Blank means "no officer channel", which makes the Worker
     * serve nothing (see audienceIsConfigured) rather than guess.
     *
     * WARNING: Classification is by channel, NOT category: every event voice channel
     * shares one category, so the category cannot separate an officer event
     * from a subteam one.
     */
    OFFICERS_CHANNEL_ID?: string;
    /** Comma-separated public category ids. Diagnostics only. Optional. */
    PUBLIC_CATEGORY_IDS?: string;
    EVENTS_KV: KVNamespace;
}

/**
 * KV keys.
 *
 * WARNING: `EVENTS_KV_KEY` holds the **full** normalized set, and each route filters
 * in memory. Storing only the public subset would be smaller, but it would
 * also mean the officer routes could never be served from cache and would hit
 * Discord on every request -- a rate-limit risk (Discord throttles the
 * scheduled-events endpoint aggressively). The full set is a few KB.
 */
const EVENTS_KV_KEY = "events:v2";
const CHANNELS_KV_KEY = "channels:v1";
const WORKER_USER_AGENT = "autoboat-website-worker/1.0";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_UPSTREAM_TIMEOUT_MS = 5_000;

/** Default display name for the .ics feed when CALENDAR_NAME is unset. */
const DEFAULT_CALENDAR_NAME = "AutoBoat at Virginia Tech";
/** XML/JSON-ish content type for the feed. Some clients key off the
 * `text/calendar` type; the charset is explicit because SUMMARY/LOCATION
 * can contain non-ASCII characters. */
const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

/**
 * Build the CORS headers shared by every response. We always send
 * `Vary: Origin` so shared caches don't serve a response carved for a
 * different origin.
 */
function corsHeaders(env: Env): HeadersInit {
    return {
        "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}

/** GET a Discord REST path with the bot token, returning the parsed JSON. */
async function discordGet(env: Env, path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_UPSTREAM_TIMEOUT_MS);
    try {
        const res = await fetch(`${DISCORD_API_BASE}${path}`, {
            method: "GET",
            headers: {
                Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
                "User-Agent": WORKER_USER_AGENT,
                Accept: "application/json",
            },
            signal: controller.signal,
        });
        if (!res.ok) {
            // Include the status only -- never the body, headers, or token.
            throw new Error(`discord upstream returned ${res.status}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchDiscordEvents(env: Env): Promise<DiscordGuildScheduledEvent[]> {
    const data = await discordGet(env, `/guilds/${env.DISCORD_GUILD_ID}/scheduled-events?with_user_count=true`);
    if (!Array.isArray(data)) {
        throw new Error("discord upstream returned a non-array payload");
    }
    return data as DiscordGuildScheduledEvent[];
}

/**
 * Fetch the guild's channels, used to resolve each event's category.
 *
 * WARNING: This must NOT fail the request. If the channel list is unavailable we
 * classify with an empty list, which is fail-open (everything public) -- see
 * `audienceForChannel`. That is a deliberate availability trade-off: a
 * Discord hiccup on this secondary call should not blank the public calendar.
 * The cost is that officer events could be published during that window, which
 * is why the `X-Audience-Source: channels|unavailable` response header exists:
 * if it ever reports `unavailable`, the classifier had no data.
 */
async function fetchDiscordChannels(env: Env): Promise<DiscordChannel[] | null> {
    try {
        const data = await discordGet(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`);
        return Array.isArray(data) ? (data as DiscordChannel[]) : null;
    } catch {
        return null;
    }
}

function parseTtlSeconds(env: Env): number {
    const n = Number.parseInt(env.CACHE_TTL_SECONDS, 10);
    return Number.isFinite(n) && n > 0 ? n : 300;
}

function jsonResponse(body: unknown, init: ResponseInit, env: Env): Response {
    const headers = new Headers(corsHeaders(env));
    if (init.headers) {
        for (const [k, v] of new Headers(init.headers)) {
            headers.set(k, v);
        }
    }
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(body), { ...init, headers });
}

/**
 * Load the normalized events, serving from the KV cache when warm and
 * fetching + repopulating it on a miss. Shared by the JSON and .ics routes
 * so the two formats can never drift apart.
 *
 * Throws when Discord is unreachable and the cache is cold; callers map that
 * to a 502.
 */
async function loadEvents(
    env: Env,
    ctx: ExecutionContext,
    /**
     * Whether the audience config is usable. When false, the loaded events are
     * discarded by the route anyway, so this function must NOT persist them:
     * everything classifies as public while unconfigured, and caching that
     * would poison the cache with `.audience = "public"` on officer events for
     * a correctly-configured request to serve from. See eventsForRoute.
     */
    configured: boolean,
): Promise<{ events: CalendarEvent[]; cache: "HIT" | "MISS"; channelsAvailable: boolean }> {
    const ttl = parseTtlSeconds(env);

    const cached = await env.EVENTS_KV.get(EVENTS_KV_KEY, { type: "json", cacheTtl: ttl });
    if (cached !== null && Array.isArray(cached)) {
        // The channels cache is only consulted on a miss; on a hit the
        // audience on each event is already resolved and stored with it.
        return { events: cached as CalendarEvent[], cache: "HIT", channelsAvailable: true };
    }

    const [raw, channels] = await Promise.all([fetchDiscordEvents(env), fetchDiscordChannels(env)]);
    const events = normalizeEvents(raw, {
        channels: channels ?? [],
        audienceConfig: audienceConfigFromEnv(env),
    });
    // Fire-and-forget KV writes -- do not block the response on them.
    if (configured) {
        ctx.waitUntil(env.EVENTS_KV.put(EVENTS_KV_KEY, JSON.stringify(events), { expirationTtl: ttl }));
    }
    if (channels) {
        ctx.waitUntil(env.EVENTS_KV.put(CHANNELS_KV_KEY, JSON.stringify(channels), { expirationTtl: ttl }));
    }
    return { events, cache: "MISS", channelsAvailable: channels !== null };
}

/**
 * Filter a loaded set down to what the route's audience may see.
 *
 * WARNING: **When the audience config is unconfigured, NO route serves events.** The
 * Worker cannot distinguish officer events from public ones without knowing
 * which channels are officer-only, so serving the public calendar would publish
 * them. This is the one place the design is deliberately fail-CLOSED, and it is
 * a configuration error rather than a normal state -- it is reported via
 * `X-Audience-Configured: false` and by `/audiences`.
 *
 * Contrast with the per-event rule in audience.ts, which is fail-open: a single
 * unrecognised *channel* inside a valid config is public. The two differ because
 * "a channel I don't recognise" is a normal day-to-day event, whereas "no
 * officer channel at all" means the filter was never set up.
 */
function eventsForRoute(events: CalendarEvent[], audience: Audience): CalendarEvent[] {
    // "officer" routes see everything; "public" routes see public only.
    return audience === "officer" ? events : publicEvents(events);
}

/** Generic 502 for a cold cache plus a Discord upstream failure. The real
 * error is never echoed -- it could carry headers or the token. */
function upstreamUnavailable(env: Env): Response {
    return jsonResponse(
        { error: "discord upstream unavailable" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
        env,
    );
}

async function handleGetEvents(env: Env, ctx: ExecutionContext, audience: Audience): Promise<Response> {
    const ttl = parseTtlSeconds(env);
    const configured = audienceIsConfigured(audienceConfigFromEnv(env));
    let loaded: { events: CalendarEvent[]; cache: "HIT" | "MISS"; channelsAvailable: boolean };
    try {
        loaded = await loadEvents(env, ctx, configured);
    } catch {
        return upstreamUnavailable(env);
    }

    return jsonResponse(
        // Empty when unconfigured -- see eventsForRoute.
        configured ? eventsForRoute(loaded.events, audience) : [],
        {
            status: 200,
            headers: {
                "X-Cache": loaded.cache,
                "X-Audience": audience,
                // Surfaces a degraded classifier rather than hiding it.
                "X-Audience-Source": loaded.channelsAvailable ? "channels" : "unavailable",
                // false => no officer channel/category is configured, so
                // nothing is served.
                "X-Audience-Configured": String(configured),
                "Cache-Control": `public, max-age=${ttl}`,
            },
        },
        env,
    );
}

function icsResponse(body: string, init: ResponseInit, env: Env): Response {
    const headers = new Headers(corsHeaders(env));
    if (init.headers) {
        for (const [k, v] of new Headers(init.headers)) {
            headers.set(k, v);
        }
    }
    headers.set("Content-Type", ICS_CONTENT_TYPE);
    return new Response(body, { ...init, headers });
}

/**
 * `GET /calendar.ics` (and `/officers/calendar.ics`) -- the subscribable feed.
 *
 * Responses are cacheable for the KV TTL so calendar clients polling the URL
 * don't hammer the Worker. `Content-Disposition: inline` keeps browsers from
 * force-downloading the file when someone opens the URL directly (a download
 * prompt is what makes users think "subscribe" is broken).
 */
async function handleGetIcs(env: Env, ctx: ExecutionContext, audience: Audience): Promise<Response> {
    const ttl = parseTtlSeconds(env);
    const configured = audienceIsConfigured(audienceConfigFromEnv(env));
    let loaded: { events: CalendarEvent[]; cache: "HIT" | "MISS"; channelsAvailable: boolean };
    try {
        loaded = await loadEvents(env, ctx, configured);
    } catch {
        return upstreamUnavailable(env);
    }

    const visible = configured ? eventsForRoute(loaded.events, audience) : [];
    const defaultName = audience === "officer" ? "AutoBoat Officers" : DEFAULT_CALENDAR_NAME;
    const body = buildCalendar(visible, {
        calendarName: env.CALENDAR_NAME?.trim() || defaultName,
        guildId: env.DISCORD_GUILD_ID,
        refreshIntervalSeconds: ttl,
    });

    return icsResponse(
        body,
        {
            status: 200,
            headers: {
                "X-Cache": loaded.cache,
                "X-Audience": audience,
                "X-Audience-Source": loaded.channelsAvailable ? "channels" : "unavailable",
                "X-Audience-Configured": String(configured),
                "Cache-Control": `public, max-age=${ttl}`,
                "Content-Disposition": 'inline; filename="autoboat.ics"',
            },
        },
        env,
    );
}

/**
 * `GET /audiences` -- diagnostics.
 *
 * Reports the configured officer channels and categories, lists every category
 * with the audience it resolves to, and lists every event-bearing voice channel
 * with its parent category. Auditing the real configuration is otherwise
 * impossible without Discord UI archaeology, and a wrong officer channel id
 * fails open (silently publishing officer events), so this route is how that
 * gets verified.
 *
 * WARNING: Events are classified by CHANNEL, not category, because every event voice
 * channel shares one category here. So the `channels` list below is the one to
 * check, not `categories`.
 *
 * Exposes channel and category NAMES, which are only as sensitive as the
 * Discord server itself. It contains no event data and no secret.
 */
async function handleGetAudiences(env: Env): Promise<Response> {
    const config = audienceConfigFromEnv(env);
    const configured = audienceIsConfigured(config);
    const ttl = parseTtlSeconds(env);

    let channels: DiscordChannel[] | null;
    const cached = await env.EVENTS_KV.get(CHANNELS_KV_KEY, { type: "json", cacheTtl: ttl });
    if (cached !== null && Array.isArray(cached)) {
        channels = cached as DiscordChannel[];
    } else {
        channels = await fetchDiscordChannels(env);
    }

    if (!channels) {
        return jsonResponse(
            { error: "channel list unavailable" },
            { status: 502, headers: { "Cache-Control": "no-store" } },
            env,
        );
    }

    const categories = listCategories(channels).map((c) => ({
        id: c.id,
        name: c.name,
        // Categories are documentary only now: classification is by channel,
        // because every event channel shares one category.
        documentedPublic: config.publicCategoryIds.includes(c.id),
    }));

    const channelList = listChannels(channels).map((c) => ({
        id: c.id,
        name: c.name,
        categoryId: c.categoryId,
        // This is the signal that decides visibility.
        audience: c.id === config.officersChannelId ? ("officer" as const) : ("public" as const),
    }));

    return jsonResponse(
        {
            // The signal. null => not configured, and while unconfigured NO
            // route serves events (see eventsForRoute).
            officersChannelId: config.officersChannelId,
            configured,
            // Present only when unconfigured, so the remedy travels with the
            // symptom rather than living in a doc nobody re-reads.
            ...(configured
                ? {}
                : {
                      warning:
                          "No officer channel is configured, so no events are served (officer-only " +
                          "events cannot be distinguished). Run `cd worker && npm run channels` to list " +
                          "voice channels, then set OFFICERS_CHANNEL_ID in wrangler.jsonc and redeploy.",
                  }),
            categories,
            categoryCount: categories.length,
            channels: channelList,
            channelCount: channelList.length,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
        env,
    );
}

function handlePreflight(env: Env): Response {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
}

/**
 * Route table. Each entry maps a normalized pathname to the audience whose
 * events it serves. `/officers/*` is not a secret: it is an unguessable URL,
 * and anyone who has it can read it.
 */
const ROUTES: Record<string, { kind: "json" | "ics" | "audiences"; audience: Audience }> = {
    "/events": { kind: "json", audience: "public" },
    "/calendar.ics": { kind: "ics", audience: "public" },
    "/officers/events": { kind: "json", audience: "officer" },
    "/officers/calendar.ics": { kind: "ics", audience: "officer" },
    "/audiences": { kind: "audiences", audience: "public" },
};

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        // Normalize a trailing slash so /events/ and /calendar.ics/ work too
        // (calendar clients and users paste URLs with either form).
        const pathname = url.pathname.replace(/\/+$/, "") || "/";
        const method = request.method.toUpperCase();

        const route = ROUTES[pathname];
        if (!route) {
            return jsonResponse({ error: "not found" }, { status: 404 }, env);
        }

        if (method === "OPTIONS") {
            return handlePreflight(env);
        }
        if (method !== "GET") {
            return jsonResponse({ error: "method not allowed" }, { status: 405 }, env);
        }

        switch (route.kind) {
            case "ics":
                return handleGetIcs(env, ctx, route.audience);
            case "audiences":
                return handleGetAudiences(env);
            default:
                return handleGetEvents(env, ctx, route.audience);
        }
    },
    // Exported so `wrangler types` picks up the Env shape for editor use.
} satisfies ExportedHandler<Env>;
