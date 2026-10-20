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
 * DELETION. The list endpoint cannot distinguish a finished event from a
 * deleted one, but the guild audit log can: an entry of action type 102
 * (`GUILD_SCHEDULED_EVENT_DELETE`) names the deleted event's id. Each refresh
 * therefore also reads `GET /guilds/{id}/audit-logs?action_type=102`, and the
 * ids it reports are dropped from the archive -- so deleting an event in
 * Discord removes it from the calendar instead of leaving it behind as history.
 * See audit.ts. The audit read is best-effort: if it fails (or the bot lacks
 * VIEW_AUDIT_LOG) the archive keeps its default keep-everything behavior, which
 * is the same as before this signal existed.
 *
 * Discord upstream errors are returned as a generic 502 with CORS headers
 * intact; the bot token is never logged, echoed, or included in responses.
 *
 * WARNING: WRITE BUDGET. The `/guilds/{id}/channels` fetch used to run on this
 * path and its result was written to KV too, so every cache miss cost TWO writes.
 * The free tier allows 1,000 writes/day, and a miss is what consumes one, so
 * `CACHE_TTL_SECONDS` is a hard budget: at 60s the Worker exceeded the daily
 * limit and the calendar went empty until 00:00 UTC. Classification no longer
 * needs the channel list, so today a miss costs exactly ONE write. Keep the TTL
 * at >= 180s and preserve the one-write-per-miss invariant; `routes.test.ts`
 * pins it.
 *
 * WARNING: Retention does NOT change that arithmetic, but it does move freshness
 * out of KV's expiry and into the stored `fetchedAt`: the key outlives the cache
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
import { GUILD_SCHEDULED_EVENT_DELETE, parseDeletedEventIds } from "./audit";
import { validateCreateEvent } from "./eventCreate";
import { type CalendarEvent, type DiscordGuildScheduledEvent, normalizeEvents, publicEvents } from "./events";
import { buildCalendar } from "./ics";
import {
    buildAuthorizeUrl,
    createOAuthState,
    DISCORD_TOKEN_URL,
    type OAuthUser,
    parseTokenResponse,
    parseUser,
    verifyOAuthState,
} from "./oauth";
import { type DiscordUserGuild, evaluateMembership } from "./permissions";
import { bearerToken, createSession, SESSION_TTL_SECONDS, verifySession } from "./session";

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
    /**
     * Discord application OAuth2 client id. Public (it appears in the
     * authorize URL the browser visits).
     */
    DISCORD_CLIENT_ID?: string;
    /**
     * Discord application client secret. A SECRET -- set with
     * `wrangler secret put DISCORD_CLIENT_SECRET`, never in wrangler.jsonc.
     * Used only by the authorization-code exchange, which must happen
     * server-side; the browser never sees it.
     */
    DISCORD_CLIENT_SECRET?: string;
    /**
     * HMAC key for session tokens and OAuth `state` values. A SECRET, and
     * deliberately NOT the bot token or the client secret: rotating one must
     * not force a bot re-deploy or an OAuth app reset, and sharing a key
     * across two purposes makes the blast radius of a leak unclear.
     *
     * WARNING: When this is unset, every management route fails closed (401), which
     * disables event creation but leaves the read-only calendar working. Do
     * not fall back to an empty-string key -- that would let anyone mint a
     * valid token.
     */
    SESSION_SECRET?: string;
    /**
     * The exact URL Discord redirects the browser back to after authorization.
     * Must match an entry in the Discord developer portal EXACTLY, including
     * the trailing slash.
     */
    OAUTH_REDIRECT_URI?: string;
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
 * The ids of events the guild audit log says were deleted.
 *
 * WHY THIS EXISTS. The scheduled-events list drops a completed event and a
 * deleted one identically, so the archive (which keeps everything Discord stops
 * reporting, see archive.ts) cannot tell them apart and would keep a deleted
 * event forever. The audit log is the only place the distinction exists: an
 * entry of action type 102 names the deleted event's id.
 *
 * WARNING: Best-effort, and the failure must stay silent. When this returns null
 * (request failed, or the bot lacks VIEW_AUDIT_LOG) the caller passes an empty
 * set, which is exactly the pre-deletion-signal behavior -- a deleted event
 * lingers as history, which is the archive's default. Failing the whole response
 * because an enhancement's source was unavailable would blank the calendar.
 *
 * `action_type` is filtered server-side, so this asks for the smallest useful
 * page. `limit=100` is Discord's maximum; a busy 45-day window could hold more
 * deletions than that, but a missed deletion merely falls back to the archive's
 * keep-everything default, and 45 days of >100 event deletions is not a real
 * case for this team.
 */
async function fetchDeletedEventIds(env: Env): Promise<Set<string> | null> {
    try {
        const data = await discordGet(
            env,
            `/guilds/${env.DISCORD_GUILD_ID}/audit-logs?action_type=${GUILD_SCHEDULED_EVENT_DELETE}&limit=100`,
        );
        return parseDeletedEventIds(data);
    } catch {
        // Deliberately swallowed: see the WARNING above.
        return null;
    }
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
    // Deletions, from the audit log. This is a SECOND Discord request, but only
    // on the miss path and with NO extra KV write, so the write budget (one
    // write per miss) is unchanged. It is best-effort: a failed audit fetch
    // yields an empty set, which is the archive's keep-everything default, so
    // an event the team deleted survives as history exactly as it did before
    // this signal existed. See fetchDeletedEventIds.
    const deletedIds = (await fetchDeletedEventIds(env)) ?? new Set<string>();
    // Merge over whatever was stored. An unreadable/unrecognised value is
    // treated as an empty archive rather than as a reason to fail -- a cold
    // start costs history, which a cache-shape change should not compound.
    const events = mergeArchive(entry?.events ?? [], fresh, now, retentionMs, deletedIds);

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
 * CORS headers for the management routes.
 *
 * WARNING: These must advertise `Authorization` and `POST`, which the read-only
 * routes do not. A preflight for `POST` with an `Authorization` header fails if
 * the response omits either, and the browser reports it as a network error with
 * no useful detail -- so the management routes build their own header set
 * rather than reusing `corsHeaders`.
 *
 * `Access-Control-Allow-Credentials` is deliberately NOT set. The session is a
 * bearer token, not a cookie, so credentials mode is unnecessary; enabling it
 * would only widen what a mis-scoped allowlist exposes.
 */
function managementCorsHeaders(env: Env): HeadersInit {
    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
        // The response varies by token, so a shared cache must not reuse one
        // user's body for another.
        "Cache-Control": "no-store",
    };
    if (env.origin) headers["Access-Control-Allow-Origin"] = env.origin;
    return headers;
}

/** JSON response with the management CORS headers. */
function managementJson(body: unknown, init: ResponseInit, env: Env): Response {
    const headers = new Headers(managementCorsHeaders(env));
    if (init.headers) {
        for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
    }
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(body), { ...init, headers });
}

function managementError(env: Env, status: number, error: string): Response {
    return managementJson({ error }, { status }, env);
}

/**
 * Configuration required for the OAuth login, in the order a new operator
 * should set them. `secret: true` marks values that live in `wrangler secret
 * put` rather than `vars` -- the distinction matters because putting a secret
 * in `wrangler.jsonc` would commit it.
 */
const OAUTH_REQUIRED_CONFIG = [
    { name: "DISCORD_CLIENT_ID", secret: false },
    { name: "DISCORD_CLIENT_SECRET", secret: true },
    { name: "OAUTH_REDIRECT_URI", secret: false },
    { name: "SESSION_SECRET", secret: true },
] as const;

/**
 * Which required values are ABSENT or blank.
 *
 * WARNING: Reports the NAMES only -- never the values. `DISCORD_CLIENT_SECRET` and
 * `SESSION_SECRET` pass through here, and this string reaches an HTTP response
 * and the client UI, so returning values (or even a length/prefix) would leak
 * them.
 *
 * This exists because the previous version returned a single boolean and the
 * caller printed one fixed sentence naming all four variables. An operator who
 * had just set one of them would set it, see the identical message, and have no
 * way to tell whether their change landed -- which is exactly the report this
 * replaced. Naming only the missing entries makes the next step unambiguous.
 */
export function missingOAuthConfig(env: Partial<Env>): string[] {
    return OAUTH_REQUIRED_CONFIG.filter(({ name }) => {
        const value = env[name];
        // A var present but set to "" counts as missing: wrangler.jsonc ships
        // `"DISCORD_CLIENT_ID": ""` as a placeholder, and an empty client id
        // produces a Discord authorize URL that fails with no explanation.
        return typeof value !== "string" || value.trim() === "";
    }).map(({ name }) => name);
}

/** The `wrangler` command that sets one of these, chosen by where it lives. */
function howToSet(name: string): string {
    const entry = OAUTH_REQUIRED_CONFIG.find((c) => c.name === name);
    return entry?.secret ? `wrangler secret put ${name}` : `"${name}" in wrangler.jsonc vars`;
}

/**
 * A 503 whose message names the specific missing configuration, plus how to
 * set each one.
 */
function oauthNotConfigured(env: Env): Response {
    const missing = missingOAuthConfig(env);
    const remedy = missing.map((name) => `${name} (${howToSet(name)})`).join(", ");
    return managementError(env, 503, `Event creation is not configured. Missing: ${remedy}.`);
}

/**
 * `GET /manage/auth/url` -- where the browser should send the user to log in.
 *
 * Built server-side so the client id and redirect URI come from configuration
 * and cannot be tampered with by a crafted link. The `state` is a signed,
 * short-lived nonce that the callback verifies (see oauth.ts).
 *
 * Returns 503 when OAuth is not configured. That is deliberate: the read-only
 * calendar keeps working, and the failure names the specific missing value
 * rather than a broken redirect.
 */
async function handleAuthUrl(env: Env): Promise<Response> {
    const missing = missingOAuthConfig(env);
    // `missing` already includes SESSION_SECRET, so no separate check here --
    // two checks would let the message disagree with the gate.
    if (missing.length > 0) return oauthNotConfigured(env);
    // Narrowed by the check above; `createOAuthState` needs a real string.
    const secret = env.SESSION_SECRET as string;

    const state = await createOAuthState(secret);
    return managementJson(
        {
            url: buildAuthorizeUrl({
                clientId: env.DISCORD_CLIENT_ID as string,
                redirectUri: env.OAUTH_REDIRECT_URI as string,
                state,
            }),
        },
        { status: 200 },
        env,
    );
}

/** GET a Discord endpoint with a USER bearer token. Never logs the token. */
async function discordGetAsUser(path: string, accessToken: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_UPSTREAM_TIMEOUT_MS);
    try {
        const res = await fetch(`${DISCORD_API_BASE}${path}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "User-Agent": WORKER_USER_AGENT,
                Accept: "application/json",
            },
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`discord upstream returned ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * `POST /manage/auth/callback` -- exchange an authorization code for a session.
 *
 * The code is exchanged here, not in the browser, because the exchange requires
 * the client secret. The user's access token is used for exactly two reads
 * (`/users/@me` and `/users/@me/guilds`) and then discarded -- it is never
 * logged, returned, or stored.
 *
 * A user who is in the guild but lacks `MANAGE_EVENTS` gets a 403 with
 * `member: true`, so the UI can say "ask an officer for the role" instead of
 * "you are not in the server".
 */
async function handleAuthCallback(env: Env, request: Request): Promise<Response> {
    // Same diagnostic as /manage/auth/url, so the two routes can never name
    // different missing values for the same broken configuration.
    if (missingOAuthConfig(env).length > 0) return oauthNotConfigured(env);
    const secret = env.SESSION_SECRET as string;

    let body: { code?: unknown; state?: unknown };
    try {
        body = (await request.json()) as typeof body;
    } catch {
        return managementError(env, 400, "Expected a JSON body.");
    }

    const code = typeof body.code === "string" ? body.code : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!code) return managementError(env, 400, "Missing authorization code.");

    // Verify BEFORE spending a token exchange on the code.
    if (!(await verifyOAuthState(secret, state))) {
        return managementError(env, 400, "Invalid or expired login attempt. Please try again.");
    }

    // Discord requires form encoding and rejects JSON with an error that does
    // not explain itself.
    const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: env.OAUTH_REDIRECT_URI as string,
    });

    let tokenData: unknown;
    try {
        const res = await fetch(DISCORD_TOKEN_URL, {
            method: "POST",
            headers: {
                // HTTP Basic with the app's credentials. `btoa` is fine here:
                // both values are ASCII.
                Authorization: `Basic ${btoa(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`)}`,
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": WORKER_USER_AGENT,
                Accept: "application/json",
            },
            body: form.toString(),
        });
        if (!res.ok) return managementError(env, 401, "Discord rejected the login. Please try again.");
        tokenData = await res.json();
    } catch {
        return managementError(env, 502, "Could not reach Discord. Please try again.");
    }

    const token = parseTokenResponse(tokenData);
    if (!token) return managementError(env, 401, "Discord returned an unusable login response.");

    // Both reads are needed: identity for the session, guilds for the gate.
    let user: OAuthUser | null;
    let guilds: DiscordUserGuild[];
    try {
        const [userData, guildData] = await Promise.all([
            discordGetAsUser("/users/@me", token.accessToken),
            discordGetAsUser("/users/@me/guilds", token.accessToken),
        ]);
        user = parseUser(userData);
        guilds = Array.isArray(guildData) ? (guildData as DiscordUserGuild[]) : [];
    } catch {
        // The user token is never echoed, so a failure here is indistinguishable
        // from any other upstream problem to the caller.
        return managementError(env, 502, "Could not read your Discord profile. Please try again.");
    }

    if (!user) return managementError(env, 401, "Discord returned an unusable profile.");

    const membership = evaluateMembership(guilds, env.DISCORD_GUILD_ID);
    if (!membership.member) {
        return managementJson(
            { error: "You are not a member of the team's Discord server.", member: false },
            { status: 403 },
            env,
        );
    }
    if (!membership.canCreateEvents) {
        return managementJson(
            {
                error: "Only officers can add events. Ask an officer to grant you the role.",
                member: true,
                canCreateEvents: false,
            },
            { status: 403 },
            env,
        );
    }

    const session = await createSession(secret, {
        id: user.id,
        name: user.name,
        canCreateEvents: membership.canCreateEvents,
    });

    return managementJson(
        {
            token: session.token,
            name: session.payload.name,
            // Seconds, so the client can schedule its own expiry handling.
            expiresIn: SESSION_TTL_SECONDS,
        },
        { status: 200 },
        env,
    );
}

/**
 * `GET /manage/session` -- who the bearer token belongs to.
 *
 * Exists so the page can restore a login across a reload without re-running
 * OAuth. It re-verifies the signature and expiry on every call; a token that
 * fails is reported as 401 and the client starts a fresh login.
 */
async function handleGetSession(env: Env, request: Request): Promise<Response> {
    const result = await verifySession(env.SESSION_SECRET, bearerToken(request.headers.get("Authorization")));
    if (!result.ok) return managementError(env, 401, result.reason);
    return managementJson(
        { name: result.payload.name, canCreateEvents: result.payload.canCreateEvents },
        { status: 200 },
        env,
    );
}

/** POST a JSON body to Discord with the bot token, returning the parsed JSON. */
async function discordPostAsBot(
    env: Env,
    path: string,
    body: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_UPSTREAM_TIMEOUT_MS);
    try {
        const res = await fetch(`${DISCORD_API_BASE}${path}`, {
            method: "POST",
            headers: {
                Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
                "Content-Type": "application/json",
                "User-Agent": WORKER_USER_AGENT,
                Accept: "application/json",
                // Shows up in the guild audit log, so a bot-created event is
                // attributable to the person who actually asked for it.
                "X-Audit-Log-Reason": "Created from the AutoBoat website",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) {
            // Discord's error body explains WHICH field was wrong (e.g.
            // "scheduled_start_time: Value must be in the future"). That is
            // safe to surface -- it contains no credentials -- and it is the
            // difference between a fixable form and "something went wrong".
            let detail = `Discord returned ${res.status}.`;
            try {
                const parsed = (await res.json()) as { message?: unknown; errors?: unknown };
                if (typeof parsed.message === "string" && parsed.message) {
                    detail = parsed.message;
                } else if (parsed.errors) {
                    detail = "Discord rejected the event details.";
                }
            } catch {
                // Keep the status-only message.
            }
            return { ok: false, status: res.status, detail };
        }
        return { ok: true, data: await res.json() };
    } catch {
        return { ok: false, status: 502, detail: "Could not reach Discord." };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * `POST /manage/events` -- create a guild scheduled event.
 *
 * WARNING: THE PERMISSION CHECK IS NOT OPTIONAL. The event is created with the
 * BOT's token, so Discord enforces the BOT's permissions -- and the bot holds
 * `MANAGE_EVENTS`. Discord will happily create an event for any caller. The
 * `canCreateEvents` claim in the session token is therefore the only thing
 * gating writes; see permissions.ts.
 *
 * WARNING: A successful create writes the event into the KV archive immediately
 * (one write, on a write path that is rare by nature). Without it the new event
 * would be invisible for up to `CACHE_TTL_SECONDS`, which reads as "the form is
 * broken". This does not affect the read path's one-write-per-miss invariant --
 * it is a separate, operator-initiated write, not a cache miss.
 */
async function handleCreateEvent(env: Env, ctx: ExecutionContext, request: Request): Promise<Response> {
    const auth = await verifySession(env.SESSION_SECRET, bearerToken(request.headers.get("Authorization")));
    if (!auth.ok) return managementError(env, 401, auth.reason);
    if (!auth.payload.canCreateEvents) {
        return managementError(env, 403, "Only officers can add events.");
    }

    let payload: unknown;
    try {
        payload = await request.json();
    } catch {
        return managementError(env, 400, "Expected a JSON body.");
    }

    const config = audienceConfigFromEnv(env);
    // 5-minute past grace is inside validateCreateEvent; `now` is injectable
    // there so the rule is testable without freezing the clock.
    const validated = validateCreateEvent(payload, config.officersChannelId);
    if (!validated.ok) return managementError(env, 400, validated.error);

    const created = await discordPostAsBot(
        env,
        `/guilds/${env.DISCORD_GUILD_ID}/scheduled-events`,
        validated.value.body,
    );
    if (!created.ok) {
        // Discord 4xx are the caller's fault (bad field values); 5xx/502 are
        // ours to report as an upstream failure.
        const status = created.status === 502 ? 502 : created.status === 429 ? 429 : 400;
        return managementError(env, status, created.detail);
    }

    // Turn the Discord response into the same shape the read routes serve, so
    // the website can merge it into its grid without a second fetch.
    const normalized = normalizeEvents([created.data as DiscordGuildScheduledEvent], { audienceConfig: config })[0];

    if (normalized) {
        // Merge into the archive so the new event is visible immediately.
        // Read-modify-write, deliberately NOT inside loadEvents: this must not
        // change the read path's miss logic.
        ctx.waitUntil(
            (async () => {
                const cached = await env.EVENTS_KV.get(EVENTS_KV_KEY, { type: "json" });
                const entry = parseCacheEntry(cached);
                // WARNING: Nothing stored means the archive has never been populated, so
                // there is no history to merge into. Writing `[created]` here would
                // mark a one-event archive FRESH for a whole TTL, and the calendar
                // would show only the event just created until it expired. Leave the
                // cache cold instead -- the next read fetches the full set from
                // Discord, which includes this event.
                if (entry === null) return;
                const now = new Date();
                const events = mergeArchive(entry.events, [normalized], now, parseRetentionMs(env));
                await env.EVENTS_KV.put(EVENTS_KV_KEY, JSON.stringify({ fetchedAt: now.getTime(), events }));
            })().catch(() => {
                // A failed warm write is not worth failing the request over --
                // the event exists in Discord and the next poll will pick it
                // up within one cache TTL.
            }),
        );
    }

    return managementJson(
        {
            event: normalized ?? null,
            officerOnly: validated.value.officerOnly,
        },
        { status: 201 },
        env,
    );
}

/**
 * Route table. Each entry maps a normalized pathname to what it serves.
 * `/officers/*` is not a secret: it is an unguessable URL, and anyone who has
 * it can read it.
 *
 * The `manage:*` kinds are the write side. They are listed here rather than in
 * a separate router so a new path cannot be added to one table and forgotten
 * in the other, which is exactly how an unauthenticated write endpoint would
 * end up published.
 */
type RouteEntry =
    | { kind: "json" | "ics"; audience: Audience }
    | { kind: "audiences" }
    | { kind: "auth-url" }
    | { kind: "auth-callback" | "session" | "create-event"; methods: string[] };

const ROUTES: Record<string, RouteEntry> = {
    "/events": { kind: "json", audience: "public" },
    "/calendar.ics": { kind: "ics", audience: "public" },
    "/officers/events": { kind: "json", audience: "officer" },
    "/officers/calendar.ics": { kind: "ics", audience: "officer" },
    "/audiences": { kind: "audiences" },
    // Event creation. `/manage/auth/url` is a GET so the browser can fetch it
    // like any other resource; the rest are POST because they carry a body.
    "/manage/auth/url": { kind: "auth-url" },
    "/manage/auth/callback": { kind: "auth-callback", methods: ["POST"] },
    "/manage/session": { kind: "session", methods: ["GET"] },
    "/manage/events": { kind: "create-event", methods: ["POST"] },
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

        // Management routes carry the write-side CORS headers (which allow
        // POST + Authorization) and must never be cached. The read routes keep
        // their own header set -- widening theirs would advertise a POST
        // surface on endpoints that have none.
        const isManagement = route.kind !== "json" && route.kind !== "ics" && route.kind !== "audiences";

        if (isManagement) {
            if (method === "OPTIONS") {
                return new Response(null, { status: 204, headers: managementCorsHeaders(env) });
            }
            const allowed = "methods" in route ? route.methods : ["GET"];
            if (!allowed.includes(method)) {
                return managementError(env, 405, "method not allowed");
            }
            switch (route.kind) {
                case "auth-url":
                    return handleAuthUrl(env);
                case "auth-callback":
                    return handleAuthCallback(env, request);
                case "session":
                    return handleGetSession(env, request);
                default:
                    return handleCreateEvent(env, ctx, request);
            }
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
