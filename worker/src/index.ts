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
 *   GET /audiences         -- diagnostics: the configured officer channel,
 *                             plus every channel/category the Worker sees.
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
 *   2. Cache fresh (KV, `fetchedAt`) -> render from the cached archive.
 *   3. Cache stale/absent            -> fetch
 *      GET https://discord.com/api/v10/guilds/{DISCORD_GUILD_ID}/scheduled-events?with_user_count=true
 *      with `Authorization: Bot ${DISCORD_BOT_TOKEN}`, normalize +
 *      classify, MERGE over the stored archive, write to KV (waitUntil).
 *   JSON responses report X-Cache: HIT|MISS.
 *
 * RETENTION. Discord's list endpoint returns only `SCHEDULED`/`ACTIVE` events,
 * so an event vanishes from it the moment it reaches the terminal
 * `COMPLETED`/`CANCELED` status. The value stored under `EVENTS_KV_KEY` is
 * therefore an archive (`{ fetchedAt, events }`) and each refresh merges the
 * fresh events over the stored ones, keeping the events Discord has stopped
 * reporting. Retention is UNBOUNDED by default -- every event ever seen is
 * kept, under a `MAX_ARCHIVED_EVENTS` safety ceiling -- and the key is written
 * without an `expirationTtl` so the history never silently lapses. Setting
 * `RETENTION_DAYS` opts into age-based pruning. See archive.ts for the merge
 * rules.
 *
 * Discord upstream errors are returned as a generic 502 with CORS headers
 * intact; the bot token is never logged, echoed, or included in responses.
 *
 * ⚠️ WRITE BUDGET. The `/guilds/{id}/channels` fetch used to run on this path
 * and its result was written to KV too, so every cache miss cost TWO writes.
 * The free tier allows 1,000 writes/day, and a miss is what consumes one, so
 * `CACHE_TTL_SECONDS` is a hard budget: at 60s the Worker exceeded the daily
 * limit and the calendar went empty until 00:00 UTC. Classification no longer
 * needs the channel list, so today a miss costs exactly ONE write. Keep the TTL
 * at >= 180s and preserve the one-write-per-miss invariant; `routes.test.ts`
 * pins it.
 *
 * ⚠️ Retention does NOT change that arithmetic, but it does move freshness out
 * of KV's expiry and into the stored `fetchedAt`: the key outlives the cache
 * TTL (indefinitely, in the default unbounded mode), so a plain "is it in
 * KV?" test would serve stale data forever. A miss is
 * `now - fetchedAt >= CACHE_TTL_SECONDS`, which preserves the write rate
 * exactly. Do not add a second key, and do not lower the key's
 * `expirationTtl` below the cache TTL when one is set.
 *
 * CORS: `ALLOWED_ORIGIN` is a comma-separated allowlist of PUBLIC origins
 * (default: the apex and www hosts). The response echoes the caller's own
 * origin when it is allowed; otherwise `Access-Control-Allow-Origin` is
 * OMITTED, which is what makes the browser reject the response. A blank value
 * allows nothing; a lone `*` allows every origin. Loopback hosts on any port
 * are allowed automatically -- see `LOCAL_DEV_ORIGIN_PATTERN`.
 *
 * WARNING: `www.` must stay on the list. The www host SERVES the site rather than
 * redirecting to the apex, so it is a genuinely different origin; omitting it
 * left the calendar working at the apex and blocked on www.
 *
 * WARNING: Echoing the request origin rather than always sending the configured one
 * is load-bearing. This used to send the configured value verbatim, so any
 * other origin got a header it could never match and the browser failed the
 * request with `NetworkError` (not a CORS message) even though the Worker
 * returned 200 -- the calendar loaded in production and was empty in local dev.
 * Calendar clients fetching the .ics are not browsers and ignore CORS
 * entirely, so the feed works regardless of the allowlist.
 */

import { type EventsCacheEntry, isFresh, KEEP_FOREVER_MS, mergeArchive, parseCacheEntry } from "./archive";
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
    /**
     * Comma-separated allowlist of browser origins (see `resolveAllowedOrigin`).
     * Blank allows none; `*` allows every origin (lockdown off).
     */
    ALLOWED_ORIGIN: string;
    /**
     * The `Access-Control-Allow-Origin` value for THIS request, resolved from
     * the caller's `Origin` header by `resolveAllowedOrigin` at the top of
     * `fetch`. `undefined` means the origin is not allowed, and the header is
     * omitted.
     *
     * WARNING: This is per-request scratch state written by `fetch`, not a binding.
     * It exists so the response helpers can stay env-only -- they are called
     * with `env` everywhere and threading an extra argument through every call
     * site would be noisier and easier to get wrong.
     *
     * WARNING: Do NOT "clean this up" by building a per-request copy with
     * `{ ...env }`. Cloudflare bindings expose their methods on the prototype,
     * so a spread copy drops `EVENTS_KV.get`/`.put` and the cache silently
     * stops working.
     */
    origin?: string;
    CACHE_TTL_SECONDS: string;
    /**
     * Optional age-based pruning, in days. UNSET BY DEFAULT, which keeps every
     * event forever -- see `parseRetentionMs`.
     */
    RETENTION_DAYS?: string;
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
 *
 * WARNING: `EVENTS_KV_KEY` is the ONLY key written. One write per cache miss is
 * what keeps the Worker inside the free tier's 1,000 writes/day; see the write
 * budget note in the module header. Do not add another key here -- a second
 * per-miss write doubles the daily write rate for no benefit.
 *
 * The value is an `EventsCacheEntry` (`{ fetchedAt, events }`), NOT a bare
 * array: the key's `expirationTtl` is the RETENTION window (days) rather than
 * the cache TTL (180 s), so freshness has to be carried in the value. The
 * miss rate -- and therefore the write rate -- is unchanged, because a miss
 * is decided by `fetchedAt`, not by the key expiring. See archive.ts and the
 * retention note above `loadEvents`.
 */
const EVENTS_KV_KEY = "events:v2";
const WORKER_USER_AGENT = "autoboat-website-worker/1.0";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_UPSTREAM_TIMEOUT_MS = 5_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** KV's maximum `expirationTtl`, in seconds (Cloudflare caps this at 1 year). */
const KV_MAX_TTL_SECONDS = 31_536_000;

/** Default display name for the .ics feed when CALENDAR_NAME is unset. */
const DEFAULT_CALENDAR_NAME = "AutoBoat Calendar";
/** XML/JSON-ish content type for the feed. Some clients key off the
 * `text/calendar` type; the charset is explicit because SUMMARY/LOCATION
 * can contain non-ASCII characters. */
const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

/**
 * Build the CORS headers shared by every response.
 *
 * WARNING: `Access-Control-Allow-Origin` is emitted ONLY when `env.origin` is set,
 * and `env.origin` is resolved per request from the caller's own `Origin`
 * header against the allowlist (see `resolveAllowedOrigin`). This function
 * previously always sent the configured `ALLOWED_ORIGIN` verbatim, which meant
 * every origin except that exact one got a header it could never match --
 * browsers block a response whose `Access-Control-Allow-Origin` differs from
 * the origin that was sent, so the request failed with `NetworkError` even
 * though the Worker had returned 200. That is why the calendar was empty in
 * local dev while working in production.
 *
 * `Vary: Origin` is always sent, including for responses with no ACAO, so a
 * shared cache can never serve one origin's response to another.
 */
function corsHeaders(env: Env): HeadersInit {
    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
    // Omitted entirely (rather than set to a non-matching value) when the
    // caller's origin is not allowed -- the absence of the header is what makes
    // the browser reject the response.
    if (env.origin) headers["Access-Control-Allow-Origin"] = env.origin;
    return headers;
}

/**
 * Hostnames treated as local development, which are allowed automatically.
 *
 * WARNING: This list exists because `localhost` and `127.0.0.1` are DISTINCT
 * origins to CORS even though they reach the same dev server, and so is every
 * port. Enumerating spellings in `ALLOWED_ORIGIN` therefore means the calendar
 * silently breaks whenever someone opens the site from the other name or
 * `vite preview` picks a different port -- which is what happened. These hosts
 * can only resolve to the machine the browser is already running on, so
 * allowing them is not a meaningful widening of access.
 *
 * Note the port is deliberately NOT constrained: any local port is allowed for
 * these hosts. A non-loopback origin (including the deployed site) must still
 * be listed explicitly in `ALLOWED_ORIGIN`.
 */
const LOCAL_DEV_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Parse the `ALLOWED_ORIGIN` allowlist (comma-separated, trimmed, no blanks).
 */
function parseAllowedOrigins(raw: string | undefined): Set<string> {
    return new Set(
        (raw ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
}

/**
 * The `Access-Control-Allow-Origin` value to send back, or `null` to omit it.
 *
 * Echoes the caller's own `Origin` when it is allowed. Echoing the REQUEST's
 * origin (rather than always sending the configured value) is the whole point:
 * CORS compares the response header against the origin the browser sent, so a
 * fixed unrelated value can never match for a different caller.
 *
 * Allowed means either an exact entry in the `ALLOWED_ORIGIN` list or a local
 * dev origin (see `LOCAL_DEV_ORIGIN_PATTERN`).
 *
 * WARNING: `*` is honored only as the SOLE entry, and it means "allow every
 * origin". It is a lockdown-off switch, not a wildcard-subdomain pattern, so
 * `*.aoe.vt.edu` never matches anything. A `*` mixed into a longer list is
 * treated as a misconfiguration and allows nothing (fail closed), rather than
 * silently opening the Worker to every origin. A blank value also allows
 * nothing, which is the safe misconfiguration.
 */
export function resolveAllowedOrigin(
    allowedOriginConfig: string | undefined,
    requestOrigin: string | null,
): string | null {
    if (!requestOrigin) return null;
    const allowed = parseAllowedOrigins(allowedOriginConfig);
    // A lone "*" is the whole-config escape hatch.
    if (allowed.size === 1 && allowed.has("*")) return "*";
    // Exact membership, so neither a lookalike host nor a `*` that has been
    // appended to a longer list can widen access by accident.
    if (allowed.has(requestOrigin)) return requestOrigin;
    // Local dev needs no configuration entry: the name and the port both vary.
    if (LOCAL_DEV_ORIGIN_PATTERN.test(requestOrigin)) return requestOrigin;
    return null;
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
 * Fetch the guild's channels.
 *
 * WARNING: Used ONLY by the `/audiences` diagnostics route. Classification does
 * not need this -- it compares `channel_id` against the configured officer
 * channel (see audience.ts) -- so a failure here cannot affect who sees an
 * event. It used to gate the classifier, which is why an earlier version of
 * this comment described a fail-open window; that is no longer true.
 *
 * The result is deliberately NOT written to KV. Caching it cost one write per
 * cache miss, which doubled the Worker's usage against the free tier's 1,000
 * writes/day, for a value only this diagnostics route reads.
 */
async function fetchDiscordChannels(env: Env): Promise<DiscordChannel[] | null> {
    try {
        const data = await discordGet(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`);
        return Array.isArray(data) ? (data as DiscordChannel[]) : null;
    } catch {
        return null;
    }
}

/** Cache TTL in seconds -- how often Discord is refetched. */
function parseTtlSeconds(env: Env): number {
    const n = Number.parseInt(env.CACHE_TTL_SECONDS, 10);
    return Number.isFinite(n) && n > 0 ? n : 180;
}

/**
 * Retention window in ms -- how long a fallen-out event stays on the calendar.
 *
 * UNSET BY DEFAULT, which returns `KEEP_FOREVER_MS`: the team asked to keep
 * EVERY event, and "Discord stopped reporting it" is not a reliable signal
 * that an event is finished (deletion and completion look identical over the
 * API), so discarding by age was throwing away real history.
 *
 * Setting `RETENTION_DAYS` opts back into age-based pruning. This is a
 * READ-side policy with no bearing on the KV write budget: the miss rate is
 * set by the cache TTL alone, and the only cost of a longer window is a
 * larger stored value (held under `MAX_ARCHIVED_EVENTS`).
 */
function parseRetentionMs(env: Env): number {
    const raw = env.RETENTION_DAYS?.trim();
    if (!raw) return KEEP_FOREVER_MS;
    const n = Number.parseFloat(raw);
    // A malformed value keeps everything rather than silently falling back to
    // a window -- erring toward retaining history, since losing it is
    // unrecoverable.
    return Number.isFinite(n) && n > 0 ? n * MS_PER_DAY : KEEP_FOREVER_MS;
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
 * Load the normalized events, serving from the KV cache when fresh and
 * refetching Discord when stale. Shared by the JSON and .ics routes so the
 * two formats can never drift apart.
 *
 * RETENTION. Discord drops an event from its list the moment it reaches the
 * terminal `COMPLETED`/`CANCELED` status, so a plain cache would forget a
 * meeting as soon as it ended. On a refresh the freshly fetched events are
 * therefore merged OVER the stored ones (`mergeArchive`), which keeps the
 * events Discord has stopped reporting. That is the whole mechanism behind
 * "past events stay on the calendar"; the website renders whatever it is
 * handed, and there is no past-event filter on either side.
 *
 * Retention is unbounded by default (see `parseRetentionMs`), so the archive
 * only ever grows within the `MAX_ARCHIVED_EVENTS` safety ceiling.
 *
 * WARNING: The write budget is unchanged by retention, and this is the invariant to
 * protect. A miss is decided by the stored `fetchedAt`, not by the key
 * expiring, and there is still exactly ONE `put` per miss -- so writes/day
 * remains `86400 / CACHE_TTL_SECONDS`. Retention only changes the key's
 * lifetime and the value's size.
 *
 * Throws when Discord is unreachable and the cache is cold; callers map that
 * to a 502.
 */
async function loadEvents(
    env: Env,
    ctx: ExecutionContext,
    now: Date,
    /**
     * Whether the audience config is usable. When false, the loaded events are
     * discarded by the route anyway, so this function must NOT persist them:
     * everything classifies as public while unconfigured, and caching that
     * would poison the cache with `.audience = "public"` on officer events for
     * a correctly-configured request to serve from. See eventsForRoute.
     */
    configured: boolean,
): Promise<{ events: CalendarEvent[]; cache: "HIT" | "MISS" }> {
    const ttlSeconds = parseTtlSeconds(env);
    const retentionMs = parseRetentionMs(env);

    // `cacheTtl` still lets Cloudflare's edge cache the read for the cache TTL
    // so a burst of requests doesn't all pass through to KV.
    const cached = await env.EVENTS_KV.get(EVENTS_KV_KEY, { type: "json", cacheTtl: ttlSeconds });
    const entry = parseCacheEntry(cached);
    if (entry !== null && isFresh(entry, now, ttlSeconds * 1000)) {
        return { events: entry.events, cache: "HIT" };
    }

    const raw = await fetchDiscordEvents(env);
    // Classification needs NO channel list -- it is a string comparison against
    // the configured officer channel id (see audience.ts). The channels fetch
    // used to happen here and its result was written to KV on every miss, which
    // doubled the write cost against the free tier's 1,000 writes/day for a
    // value only `/audiences` reads. It is now fetched lazily there instead.
    const fresh = normalizeEvents(raw, { audienceConfig: audienceConfigFromEnv(env) });
    // Merge over whatever was stored. An unreadable/unrecognised value is
    // treated as an empty archive rather than as a reason to fail -- a cold
    // start costs history, which a cache-shape change should not compound.
    const events = mergeArchive(entry?.events ?? [], fresh, now, retentionMs);

    // Fire-and-forget KV write -- do not block the response on it. Exactly ONE
    // write, always this key.
    if (configured) {
        const next: EventsCacheEntry = { fetchedAt: now.getTime(), events };
        // WARNING: The key must NOT expire while the archive is unbounded, or the
        // whole history (and the point of retention) disappears silently when
        // the TTL lapses -- the next request would see no stored events and
        // only archive what Discord still reports. So `expirationTtl` is
        // omitted entirely at KEEP_FOREVER_MS, which is KV's "no expiry". It is
        // only set when an explicit window was configured, where it is floored
        // at 2x the cache TTL (never below freshness) and capped at KV's max.
        const options = Number.isFinite(retentionMs)
            ? {
                  expirationTtl: Math.min(KV_MAX_TTL_SECONDS, Math.max(ttlSeconds * 2, Math.ceil(retentionMs / 1000))),
              }
            : undefined;
        ctx.waitUntil(env.EVENTS_KV.put(EVENTS_KV_KEY, JSON.stringify(next), options));
    }
    return { events, cache: "MISS" };
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

/**
 * Parse the `?channels=` query parameter into a set of Discord channel ids.
 *
 * The website's channel filter generates `?channels=<id>,<id>` so a user can
 * subscribe to just their subteam's events. The parameter is a plain
 * comma-separated id list; a repeated parameter is also accepted and merged,
 * because query builders differ on which form they emit.
 *
 * Returns an EMPTY set for an absent, blank, or whitespace-only value, which
 * the caller reads as "no filter". Anything unrecognised degrades to no filter
 * rather than to an empty calendar: a malformed query must never be able to
 * blank someone's subscription, and the unfiltered feed is the documented
 * default. Ids are matched as opaque strings -- only non-empty tokens are kept.
 */
export function parseChannelFilter(searchParams: URLSearchParams): Set<string> {
    const ids = new Set<string>();
    for (const raw of searchParams.getAll("channels")) {
        for (const part of raw.split(",")) {
            const id = part.trim();
            if (id) ids.add(id);
        }
    }
    return ids;
}

/**
 * Keep only the events whose channel is one of `channelIds`.
 *
 * WARNING: An EMPTY set means "no filter" and returns `events` UNCHANGED, not an
 * empty list. That is what makes the unfiltered feed the default and what stops
 * a blank `?channels=` from blanking a subscription.
 *
 * An event with no channel (`channelId === null`, e.g. an `EXTERNAL` event)
 * can never match a non-empty filter: there is no channel to compare, and the
 * website's filter treats those events as their own "Other" group rather than
 * quietly including them in every filtered view.
 *
 * This runs AFTER audience filtering and BEFORE serialization, and never
 * touches KV -- the cached value is always the full set (see `loadEvents`), so
 * an arbitrary filter costs no extra writes and every route shares one cache
 * entry. Do NOT move this into `loadEvents`: caching a filtered subset would
 * key the archive on the caller's query and make the officer routes miss on
 * every request.
 */
export function filterByChannels(events: CalendarEvent[], channelIds: Set<string>): CalendarEvent[] {
    if (channelIds.size === 0) return events;
    return events.filter((event) => event.channelId !== null && channelIds.has(event.channelId));
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

async function handleGetEvents(
    env: Env,
    ctx: ExecutionContext,
    audience: Audience,
    channelFilter: Set<string>,
): Promise<Response> {
    const ttl = parseTtlSeconds(env);
    const now = new Date();
    const configured = audienceIsConfigured(audienceConfigFromEnv(env));
    let loaded: { events: CalendarEvent[]; cache: "HIT" | "MISS" };
    try {
        loaded = await loadEvents(env, ctx, now, configured);
    } catch {
        return upstreamUnavailable(env);
    }

    return jsonResponse(
        // Empty when unconfigured -- see eventsForRoute.
        configured ? filterByChannels(eventsForRoute(loaded.events, audience), channelFilter) : [],
        {
            status: 200,
            headers: {
                "X-Cache": loaded.cache,
                "X-Audience": audience,
                // false => no officer channel is configured, so nothing is served.
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
async function handleGetIcs(
    env: Env,
    ctx: ExecutionContext,
    audience: Audience,
    channelFilter: Set<string>,
): Promise<Response> {
    const ttl = parseTtlSeconds(env);
    const now = new Date();
    const configured = audienceIsConfigured(audienceConfigFromEnv(env));
    let loaded: { events: CalendarEvent[]; cache: "HIT" | "MISS" };
    try {
        loaded = await loadEvents(env, ctx, now, configured);
    } catch {
        return upstreamUnavailable(env);
    }

    const visible = configured ? filterByChannels(eventsForRoute(loaded.events, audience), channelFilter) : [];
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

    // Fetched fresh, never cached: this is a low-traffic diagnostics route, and
    // classification does not depend on the channel list at all, so caching it
    // would only add write cost (the free tier allows 1,000 writes/day) for a
    // value nothing on the event path reads.
    const channels = await fetchDiscordChannels(env);

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

        // Resolve CORS for this request BEFORE dispatching, so every response
        // -- including the 404/405/preflight branches below -- carries the same
        // decision. See `Env.origin`.
        env.origin = resolveAllowedOrigin(env.ALLOWED_ORIGIN, request.headers.get("Origin")) ?? undefined;

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
                return handleGetIcs(env, ctx, route.audience, parseChannelFilter(url.searchParams));
            case "audiences":
                return handleGetAudiences(env);
            default:
                return handleGetEvents(env, ctx, route.audience, parseChannelFilter(url.searchParams));
        }
    },
    // Exported so `wrangler types` picks up the Env shape for editor use.
} satisfies ExportedHandler<Env>;
