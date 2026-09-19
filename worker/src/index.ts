/**
 * autoboat-discord-events Worker
 *
 * Serves a normalized JSON list of Discord guild scheduled events to the
 * AutoBoat website, without exposing the Discord bot token in the browser.
 *
 * Flow per request:
 *   1. Preflight (`OPTIONS /events`)  -> 204 with CORS headers.
 *   2. Cache hit (KV)                -> 200 cached body, X-Cache: HIT.
 *   3. Cache miss                    -> fetch
 *      GET https://discord.com/api/v10/guilds/{DISCORD_GUILD_ID}/scheduled-events?with_user_count=true
 *      with `Authorization: Bot ${DISCORD_BOT_TOKEN}`, normalize the
 *      payload into CalendarEvent[], write to KV (waitUntil), respond 200
 *      with X-Cache: MISS.
 *
 * Discord upstream errors are returned as a generic 502 with CORS headers
 * intact; the bot token is never logged, echoed, or included in responses.
 *
 * CORS: the only allowed origin is ALLOWED_ORIGIN (default
 * https://autoboat.aoe.vt.edu). Non-matching browsers are blocked at the
 * browser level; server-side/curl clients can still hit the URL directly.
 */

interface Env {
    DISCORD_BOT_TOKEN: string;
    DISCORD_GUILD_ID: string;
    ALLOWED_ORIGIN: string;
    CACHE_TTL_SECONDS: string;
    EVENTS_KV: KVNamespace;
}

/** One event in the payload the website consumes. */
interface CalendarEvent {
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
    recurrenceRule: string | null; // RFC-5545 RRULE string (without the leading "RRULE:") or null
}

/** Shape of a Discord Guild Scheduled Event (only the fields we read). */
interface DiscordGuildScheduledEvent {
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
    recurrence_rule?: string | null;
}

const KV_KEY = "events";
const WORKER_USER_AGENT = "autoboat-website-worker/1.0";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_CDN_BASE = "https://cdn.discordapp.com";
const DISCORD_UPSTREAM_TIMEOUT_MS = 5_000;

const STATUS_BY_CODE: Record<number, CalendarEvent["status"]> = {
    1: "scheduled",
    2: "active",
    3: "completed",
    4: "canceled",
};

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

function buildCdnImageUrl(event: DiscordGuildScheduledEvent): string | null {
    if (!event.image) return null;
    return `${DISCORD_CDN_BASE}/guild-events/${event.id}/${event.image}.png?size=512`;
}

function mapStatus(code: number): CalendarEvent["status"] {
    return STATUS_BY_CODE[code] ?? "scheduled";
}

function toCalendarEvent(e: DiscordGuildScheduledEvent): CalendarEvent {
    const rule = typeof e.recurrence_rule === "string" ? e.recurrence_rule : null;
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

async function fetchDiscordEvents(env: Env): Promise<CalendarEvent[]> {
    const url = `${DISCORD_API_BASE}/guilds/${env.DISCORD_GUILD_ID}/scheduled-events?with_user_count=true`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_UPSTREAM_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
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
        const data = (await res.json()) as unknown;
        if (!Array.isArray(data)) {
            throw new Error("discord upstream returned a non-array payload");
        }
        return (data as DiscordGuildScheduledEvent[]).map(toCalendarEvent);
    } finally {
        clearTimeout(timer);
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

async function handleGetEvents(env: Env, ctx: ExecutionContext): Promise<Response> {
    const ttl = parseTtlSeconds(env);

    const cached = await env.EVENTS_KV.get(KV_KEY, { type: "json", cacheTtl: ttl });
    if (cached !== null) {
        return jsonResponse(
            cached,
            {
                status: 200,
                headers: {
                    "X-Cache": "HIT",
                    "Cache-Control": `public, max-age=${ttl}`,
                },
            },
            env,
        );
    }

    let events: CalendarEvent[];
    try {
        events = await fetchDiscordEvents(env);
    } catch (err) {
        // Never include the upstream error message -- it could echo headers
        // or the token in some Discord error bodies.
        const message =
            err instanceof Error && err.message.startsWith("discord upstream returned")
                ? "discord upstream unavailable"
                : "discord upstream unavailable";
        return jsonResponse(
            { error: message },
            {
                status: 502,
                headers: { "Cache-Control": "no-store" },
            },
            env,
        );
    }

    // Fire-and-forget KV write -- do not block the response on it.
    ctx.waitUntil(env.EVENTS_KV.put(KV_KEY, JSON.stringify(events), { expirationTtl: ttl }));

    return jsonResponse(
        events,
        {
            status: 200,
            headers: {
                "X-Cache": "MISS",
                "Cache-Control": `public, max-age=${ttl}`,
            },
        },
        env,
    );
}

function handlePreflight(env: Env): Response {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const { pathname } = url;
        const method = request.method.toUpperCase();

        if (pathname !== "/events") {
            return jsonResponse({ error: "not found" }, { status: 404 }, env);
        }

        if (method === "OPTIONS") {
            return handlePreflight(env);
        }
        if (method === "GET") {
            return handleGetEvents(env, ctx);
        }
        return jsonResponse({ error: "method not allowed" }, { status: 405 }, env);
    },
    // Exported so `wrangler types` picks up the Env shape for editor use.
} satisfies ExportedHandler<Env>;
