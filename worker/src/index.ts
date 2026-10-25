/**
 * autoboat-cloudflare-helper Worker
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
import { driveTileKey, hiddenEntries, renderableEntries } from "./gallery";
import {
    loadManifest,
    loadOrder,
    manifestIsStale,
    setGalleryOrder,
    setPhotoHidden,
    syncGallery,
    uploadGalleryImage,
} from "./gallerySync";
import { checkImageBytes, validateGalleryUpload } from "./galleryUpload";
import { missingDriveConfig } from "./googleAuth";
import { buildCalendar } from "./ics";
import {
    buildAuthorizeUrl,
    createOAuthState,
    DISCORD_TOKEN_URL,
    type OAuthUser,
    parseRedirectUris,
    parseTokenResponse,
    parseUser,
    redirectUriFor,
    resolveReturnPath,
    verifyOAuthStatePayload,
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
     * Where Discord redirects the browser back to after authorization.
     *
     * COMMA-SEPARATED, and every entry must be registered in the Discord
     * developer portal char-for-char (including the trailing slash). The entry
     * whose path matches the page that started the login is the one used, so
     * the sign-in completes on that page instead of bouncing through the
     * calendar. The first entry is the fallback.
     *
     * WARNING: The redirect URI is never constructed from request input -- it is
     * SELECTED from this list (see `redirectUriFor`). Building one from a path
     * would make any path a redirect target.
     */
    OAUTH_REDIRECT_URI?: string;
    /**
     * R2 bucket holding the mirrored gallery images.
     *
     * WARNING: The gallery is served from R2, NOT from Drive. Drive is the archive
     * and the upload target, but its API is quota-limited and its download URLs
     * are not meant for embedding, so a public page view must never depend on
     * it. See gallerySync.ts.
     */
    GALLERY_BUCKET: R2Bucket;
    /**
     * Id of the Drive folder whose images make up the gallery.
     *
     * Public, non-secret (a folder id is not a capability on its own -- the
     * service account still has to be granted access). Everything directly
     * inside this folder that is a displayable image appears on /gallery,
     * because Drive is the source of truth.
     */
    DRIVE_GALLERY_FOLDER_ID?: string;
    /**
     * The service account's email (`client_email` from its JSON key).
     *
     * NOT a secret -- it is an address, and it is the thing an operator shares
     * the Drive folder with. The private key is the secret.
     */
    GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
    /**
     * The service account's PEM private key (`private_key` from the JSON key).
     *
     * A SECRET -- set with `wrangler secret put GOOGLE_PRIVATE_KEY`. Accepts
     * either literal newlines or `\n` escapes; see `pemToPkcs8`.
     */
    GOOGLE_PRIVATE_KEY?: string;
    /**
     * Optional Workspace user for domain-wide delegation.
     *
     * WARNING: Needed only when the gallery folder lives in a person's My Drive.
     * A service account has no storage quota of its own, so uploading there
     * fails with a quota error unless the service account is impersonating a
     * real user. Leave unset when the folder is in a Shared Drive, which owns
     * its own quota.
     */
    GOOGLE_IMPERSONATE_EMAIL?: string;
    /**
     * Optional shared secret that lets CI or a script force a gallery sync.
     * A SECRET. Unset disables `POST /manage/gallery/sync`.
     */
    GALLERY_SYNC_TOKEN?: string;
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
        // PATCH is here for the gallery's hide/restore route. A method missing
        // from this list fails at the PREFLIGHT with a generic network error,
        // not a 405, so it reads as "the server is down".
        // PATCH is here for the gallery's hide/restore route, and PUT for setting
        // the display order. A method missing from this list fails at the
        // PREFLIGHT with a generic network error, not a 405, so it reads as
        // "the server is down".
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
async function handleAuthUrl(env: Env, url: URL): Promise<Response> {
    const missing = missingOAuthConfig(env);
    // `missing` already includes SESSION_SECRET, so no separate check here --
    // two checks would let the message disagree with the gate.
    if (missing.length > 0) return oauthNotConfigured(env);
    // Narrowed by the check above; `createOAuthState` needs a real string.
    const secret = env.SESSION_SECRET as string;

    // WARNING: The redirect URI is CHOSEN from the registered list, never built from
    // request input. Discord rejects a redirect_uri that is not registered
    // char-for-char, so the destination page has to correspond to a real
    // registered entry -- which is also what keeps an unexpected path from
    // becoming a redirect target. `return` is allowlisted in oauth.ts.
    const returnPath = resolveReturnPath(url.searchParams.get("return") ?? undefined);
    const redirectUri = redirectUriFor(
        returnPath,
        parseRedirectUris(env.OAUTH_REDIRECT_URI),
        env.OAUTH_REDIRECT_URI as string,
    );
    const state = await createOAuthState(secret, new Date(), returnPath);
    return managementJson(
        {
            url: buildAuthorizeUrl({
                clientId: env.DISCORD_CLIENT_ID as string,
                redirectUri,
                state,
            }),
            returnPath,
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

    // Verify BEFORE spending a token exchange on the code. The verification
    // also recovers the page to return to, which the browser needs because the
    // redirect URI is a single fixed URL shared by every sign-in.
    const stateResult = await verifyOAuthStatePayload(secret, state);
    if (!stateResult.ok) {
        return managementError(env, 400, "Invalid or expired login attempt. Please try again.");
    }

    // Discord requires form encoding and rejects JSON with an error that does
    // not explain itself.
    //
    // WARNING: The redirect URI must be the SAME value the authorize request used,
    // or Discord rejects the exchange with `invalid_grant`. It is re-derived
    // from the signed return path rather than passed through the browser, so a
    // caller cannot substitute one.
    const exchangeRedirectUri = redirectUriFor(
        stateResult.returnPath,
        parseRedirectUris(env.OAUTH_REDIRECT_URI),
        env.OAUTH_REDIRECT_URI as string,
    );
    const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: exchangeRedirectUri,
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

    // Both refusals carry `reason` (a stable code the UI branches on) AND
    // `error` (a sentence for anything that only logs), plus the account name
    // and the server name so the message can be specific about WHICH account
    // was refused. A user signed into the wrong Discord account is the
    // commonest cause of both, and the generic wording never revealed it.
    if (!membership.member) {
        return managementJson(
            {
                reason: "not-a-member",
                error: `You are not a member of ${membership.guildName ?? "the team's Discord server"}.`,
                member: false,
                canCreateEvents: false,
                // Echo the account so the UI can say "signed in as X".
                account: user.name,
                guildName: membership.guildName,
            },
            { status: 403 },
            env,
        );
    }
    if (!membership.canCreateEvents) {
        return managementJson(
            {
                reason: "missing-role",
                error: "Only officers can add events. Ask an officer to grant you the role.",
                member: true,
                canCreateEvents: false,
                account: user.name,
                guildName: membership.guildName,
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
            // Where the page should go now. Signed inside the state, so it
            // cannot be steered by the callback's query string.
            returnPath: stateResult.returnPath,
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
 * DELETE a Discord path with the bot token.
 *
 * Discord returns `204 No Content` on success, so there is no body to parse.
 * Errors are reported the same way as create: the status plus Discord's
 * `message`, which explains which field or permission was at fault and contains
 * no credentials.
 */
async function discordDeleteAsBot(
    env: Env,
    path: string,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_UPSTREAM_TIMEOUT_MS);
    try {
        const res = await fetch(`${DISCORD_API_BASE}${path}`, {
            method: "DELETE",
            headers: {
                Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
                "User-Agent": WORKER_USER_AGENT,
                Accept: "application/json",
                // Recorded in the guild audit log alongside the bot's delete.
                "X-Audit-Log-Reason": "Deleted from the AutoBoat website",
            },
            signal: controller.signal,
        });
        if (!res.ok) {
            let detail =
                res.status === 404 ? "That event no longer exists in Discord." : `Discord returned ${res.status}.`;
            try {
                const parsed = (await res.json()) as { message?: unknown };
                if (typeof parsed.message === "string" && parsed.message) detail = parsed.message;
            } catch {
                // Keep the status-based message.
            }
            return { ok: false, status: res.status, detail };
        }
        // 204: nothing to read.
        return { ok: true };
    } catch {
        return { ok: false, status: 502, detail: "Could not reach Discord." };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * `DELETE /manage/events/{id}` -- delete a guild scheduled event.
 *
 * WARNING: Same reasoning as create: the DELETE is sent with the BOT's token, so
 * Discord enforces the BOT's permissions and will delete anything. The session's
 * `canCreateEvents` claim is the only gate. It is reused rather than a separate
 * `canDeleteEvents` flag because "may manage the calendar" is one decision --
 * splitting it would let the two drift apart for no product benefit.
 *
 * WARNING: The archive is updated by REMOVING the id, rather than relying on the
 * audit log. The audit-log path (`fetchDeletedEventIds`) is best-effort and can
 * lag or 403 -- and a delete the user just performed must take effect
 * immediately, not "within a refresh, if the bot has VIEW_AUDIT_LOG". The audit
 * path stays as the backstop for deletions done in the Discord client.
 */
async function handleDeleteEvent(
    env: Env,
    ctx: ExecutionContext,
    request: Request,
    eventId: string,
): Promise<Response> {
    const auth = await verifySession(env.SESSION_SECRET, bearerToken(request.headers.get("Authorization")));
    if (!auth.ok) return managementError(env, 401, auth.reason);
    if (!auth.payload.canCreateEvents) {
        return managementError(env, 403, "Only officers can remove events.");
    }
    // `resolveRoute` only produces this handler for a validated snowflake, so a
    // non-numeric id was already answered with a 404 before reaching here.

    const deleted = await discordDeleteAsBot(env, `/guilds/${env.DISCORD_GUILD_ID}/scheduled-events/${eventId}`);
    if (!deleted.ok) {
        const status = deleted.status === 502 ? 502 : deleted.status === 429 ? 429 : deleted.status === 404 ? 404 : 400;
        return managementError(env, status, deleted.detail);
    }

    // Drop it from the archive so the calendar stops showing it immediately.
    // One write, on an operator-initiated path -- the read path's
    // one-write-per-miss invariant is untouched (see handleCreateEvent).
    ctx.waitUntil(
        (async () => {
            const cached = await env.EVENTS_KV.get(EVENTS_KV_KEY, { type: "json" });
            const entry = parseCacheEntry(cached);
            // Cold cache: nothing stored to correct, and the next read refetches
            // from Discord without the deleted event anyway. Writing an empty
            // archive here would mark it fresh and hide everything else.
            if (entry === null) return;
            const remaining = entry.events.filter((e) => e.id !== eventId);
            // Nothing changed means the event was not in the archive (already
            // gone, or never fetched). Skip the write rather than burn budget.
            if (remaining.length === entry.events.length) return;
            await env.EVENTS_KV.put(EVENTS_KV_KEY, JSON.stringify({ fetchedAt: entry.fetchedAt, events: remaining }));
        })().catch(() => {
            // The delete itself succeeded; the next refresh reconciles.
        }),
    );

    return managementJson({ deleted: eventId }, { status: 200 }, env);
}

/**
 * `GET /gallery` -- the public gallery manifest.
 *
 * Serves the list of images whose bytes are already mirrored, plus a freshness
 * stamp so the page knows whether to ask for a refresh. Never touches Drive: a
 * public page view must not spend a Drive API call (see gallerySync.ts).
 *
 * A cold or stale manifest is refreshed in the BACKGROUND (`waitUntil`) and the
 * caller gets whatever is stored right now. Blocking the first visitor on a
 * full Drive listing would make the page's time-to-first-image depend on
 * Google, and a Drive outage would render an error where a stale gallery would
 * have been fine.
 */
async function handleGetGalleryManifest(env: Env, ctx: ExecutionContext, now: Date): Promise<Response> {
    const missing = missingDriveConfig(env);
    if (missing.length > 0) {
        // Fail CLOSED but legibly: an unconfigured Worker must not pretend the
        // gallery is empty, because that reads as "all the photos are gone".
        // NAMES only -- never values, since this reaches a public response.
        return jsonResponse(
            {
                error: `Gallery is not configured. Missing: ${missing.join(", ")}.`,
                images: [],
            },
            { status: 503, headers: { "Cache-Control": "no-store" } },
            env,
        );
    }

    const manifest = await loadManifest(env);
    const stale = manifestIsStale(manifest, now);
    if (stale) {
        // One refresh per stale read at most; the manifest's own `syncedAt`
        // throttles it, so a burst of visitors results in a single Drive call.
        ctx.waitUntil(syncGallery(env, now).catch(() => undefined));
    }

    return jsonResponse(
        {
            syncedAt: manifest?.syncedAt ?? null,
            images: manifest ? renderableEntries(manifest) : [],
            // Surfaced so the page can say "N more on the way" rather than
            // silently showing a shorter gallery than exists in Drive.
            pending: manifest?.pending.length ?? 0,
            warning: manifest?.warning ?? null,
            // The officer-chosen display order, by tile key.
            //
            // WHY IT IS PUBLIC AND NOT FOLDED INTO `images`: curated photos are
            // compiled into the site, not stored here, so this Worker has no
            // entry for them and cannot sort the whole grid itself. The keys are
            // opaque (`drive:<id>` / `site:<src>`) and reveal nothing a visitor
            // cannot already see in the page, so handing the sequence over and
            // letting the browser apply it is both simpler and the only way to
            // keep ONE order across both sources.
            order: await loadOrder(env),
        },
        { status: 200, headers: { "Cache-Control": "public, max-age=60" } },
        env,
    );
}

/**
 * `GET /gallery/image/:fileId` -- one mirrored image's bytes.
 *
 * Streams from R2 rather than buffering, so a large photo does not occupy the
 * isolate's memory. The object's stored `contentType` and `cacheControl` are
 * applied as-is, which is what lets the browser cache an image forever: the key
 * is a Drive id and ids never change.
 *
 * Returns 404 for an id that has not been mirrored yet. That is deliberate --
 * the manifest only advertises mirrored images, so a 404 here means a stale tab,
 * not a normal state.
 */
async function handleGetGalleryImage(env: Env, fileId: string): Promise<Response> {
    if (!env.GALLERY_BUCKET) {
        return jsonResponse({ error: "gallery not configured" }, { status: 503 }, env);
    }
    const key = `gallery/${fileId}`;
    const object = await env.GALLERY_BUCKET.get(key);
    if (!object) {
        return jsonResponse({ error: "not found" }, { status: 404 }, env);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    // The bucket stores these, but a value written by an older version or by
    // `wrangler r2 object put` may lack them; the fallbacks keep the response
    // usable rather than serving an unknown-type blob.
    if (!headers.get("Content-Type")) headers.set("Content-Type", "application/octet-stream");
    if (!headers.get("Cache-Control")) headers.set("Cache-Control", "public, max-age=31536000, immutable");
    // An id addresses one immutable object, so a validator is free and makes a
    // conditional revalidation a 304 instead of a re-download.
    headers.set("ETag", object.httpEtag);
    headers.set("Vary", "Origin");

    return new Response(object.body, { status: 200, headers });
}

/**
 * `POST /manage/gallery` -- an officer uploads a photo.
 *
 * THE PERMISSION CHECK IS THE ONLY GATE. The Drive write uses the service
 * account's credentials, so Google enforces nothing about the caller -- exactly
 * the same shape as event creation, and the same reasoning as permissions.ts.
 * It reuses `canCreateEvents` rather than adding a parallel flag: "may manage
 * the team's public presence" is one decision, and two flags would drift (see
 * the note on the session claim).
 *
 * The bytes are read ONCE into memory because both Drive and R2 need them and a
 * Worker request body can only be consumed once. The size ceiling in
 * `validateGalleryUpload` is what keeps that bounded.
 */
/**
 * `PATCH /manage/gallery/{id}` -- hide or restore a photo.
 *
 * WARNING: NOTHING IS DELETED. This is the whole point of the endpoint: an officer can
 * take a photo off the public gallery and put it back later, and the Drive file
 * is never touched. Deleting from Drive is a destructive, hard-to-undo action
 * that belongs in the Drive UI where the person can see what they are doing --
 * not behind a button on a public page.
 *
 * Gated on the same `canCreateEvents` claim as every other write, for the same
 * reason: "may manage the team's public presence" is one decision, and a
 * separate flag would drift.
 *
 * Writes the hidden set (authoritative, survives a Drive re-list) and the
 * manifest (so the page reflects it immediately). Both are officer-initiated,
 * so the read path's one-write-per-miss invariant is untouched.
 */
async function handleGalleryHide(env: Env, request: Request, fileId: string, now: Date): Promise<Response> {
    const auth = await verifySession(env.SESSION_SECRET, bearerToken(request.headers.get("Authorization")));
    if (!auth.ok) return managementError(env, 401, auth.reason);
    if (!auth.payload.canCreateEvents) {
        return managementError(env, 403, "Only officers can change which photos are shown.");
    }

    let body: { hidden?: unknown };
    try {
        body = (await request.json()) as typeof body;
    } catch {
        return managementError(env, 400, "Expected a JSON body.");
    }
    // WARNING: Strict boolean, no truthiness. `{"hidden": "false"}` is a string and
    // would otherwise read as `true`, silently hiding a photo the caller meant
    // to restore.
    if (typeof body.hidden !== "boolean") {
        return managementError(env, 400, 'Expected { "hidden": true } or { "hidden": false }.');
    }

    const updated = await setPhotoHidden(env, fileId, body.hidden, now);
    if (updated === null) {
        return managementError(env, 404, "That photo is not in the gallery.");
    }

    return managementJson({ id: fileId, hidden: body.hidden }, { status: 200 }, env);
}

/**
 * `GET /manage/gallery/hidden` -- the photos an officer has removed.
 *
 * Exists so removal is REVERSIBLE from the page: without this list, hiding a
 * photo would be a one-way door short of opening Drive and matching filenames
 * by hand. Officer-only, like every other `/manage` read.
 */
async function handleGalleryHiddenList(env: Env, request: Request): Promise<Response> {
    const auth = await verifySession(env.SESSION_SECRET, bearerToken(request.headers.get("Authorization")));
    if (!auth.ok) return managementError(env, 401, auth.reason);
    if (!auth.payload.canCreateEvents) {
        return managementError(env, 403, "Only officers can see removed photos.");
    }
    const manifest = await loadManifest(env);
    return managementJson(
        {
            images: manifest
                ? hiddenEntries(manifest).map((entry) => ({
                      id: entry.id,
                      name: entry.name,
                      width: entry.width,
                      height: entry.height,
                      modifiedTime: entry.modifiedTime,
                  }))
                : [],
        },
        { status: 200 },
        env,
    );
}

/**
 * `GET /manage/gallery/order` -- the photos an officer can reorder.
 *
 * Returns the visible photos in their CURRENT display order, which is what the
 * reorder panel renders and what it sends back after a move. Officer-only: the
 * public manifest already implies this order, but the panel also needs the
 * human-readable names, and it must not reveal hidden photos.
 *
 * The ids come from the manifest's order rather than the saved preference list,
 * so an officer sees what a visitor sees -- including photos uploaded since the
 * order was last set, which live at the end.
 */
async function handleGalleryOrderList(env: Env, request: Request): Promise<Response> {
    const auth = await verifySession(env.SESSION_SECRET, bearerToken(request.headers.get("Authorization")));
    if (!auth.ok) return managementError(env, 401, auth.reason);
    if (!auth.payload.canCreateEvents) {
        return managementError(env, 403, "Only officers can reorder photos.");
    }
    const manifest = await loadManifest(env);
    // Hidden photos are excluded: arranging a position for one would be
    // invisible work, and it would suggest the position is remembered while it
    // is off the page.
    const visible = manifest ? renderableEntries(manifest) : [];
    return managementJson(
        {
            images: visible.map((entry) => ({
                id: entry.id,
                name: entry.name,
                width: entry.width,
                height: entry.height,
                modifiedTime: entry.modifiedTime,
            })),
        },
        { status: 200 },
        env,
    );
}

/**
 * `PUT /manage/gallery/order` -- set the display order.
 *
 * Body: `{ "keys": ["drive:<id>", "site:<path>", ...] }`, most-prominent first.
 *
 * WHY KEYS. The grid is half Drive photos and half curated photos compiled into
 * the site, and this Worker only knows about the Drive half. An id-only sequence
 * could therefore only ever describe part of the page -- which is exactly why
 * "some images can't be reordered". Tile keys are unique across both sources, so
 * one sequence expresses the whole grid; this Worker sorts its own entries and
 * the browser applies the rest.
 *
 * WARNING: The list is sent WHOLE, not as a single (from, to) move. A partial move
 * would be ambiguous the moment another officer uploaded a photo between the
 * render and the request, and applying it would shuffle unrelated photos. Sending
 * the full sequence means "this is the order", which is idempotent and safe to
 * retry.
 *
 * A partial or unknown list is accepted: keys that match nothing are ignored, and
 * photos not named keep the default newest-first order AFTER the named ones. That
 * is what lets an upload land without rewriting the order.
 *
 * `ids` is still accepted for a hand-written curl body; bare Drive ids are
 * treated as if they were `drive:<id>` keys.
 */
async function handleGallerySetOrder(env: Env, request: Request, now: Date): Promise<Response> {
    const auth = await verifySession(env.SESSION_SECRET, bearerToken(request.headers.get("Authorization")));
    if (!auth.ok) return managementError(env, 401, auth.reason);
    if (!auth.payload.canCreateEvents) {
        return managementError(env, 403, "Only officers can reorder photos.");
    }

    let body: { keys?: unknown; ids?: unknown };
    try {
        body = (await request.json()) as typeof body;
    } catch {
        return managementError(env, 400, "Expected a JSON body.");
    }

    // `keys` is the real field; `ids` is the legacy/hand-written form.
    const raw = body.keys ?? body.ids;
    if (!Array.isArray(raw)) {
        return managementError(env, 400, 'Expected { "keys": ["drive:<id>", ...] }.');
    }
    // Reject a non-string entry rather than filtering it out: silently dropping
    // part of the submitted order would apply a sequence the officer never saw.
    if (raw.some((entry) => typeof entry !== "string")) {
        return managementError(env, 400, "Every entry in keys must be a string.");
    }
    // Bare Drive ids become `drive:<id>` keys, so an older client or a curl body
    // keeps working instead of silently matching nothing.
    const keys = (raw as string[]).map((entry) => (entry.includes(":") ? entry : driveTileKey(entry)));

    const updated = await setGalleryOrder(env, keys, now);
    if (updated === null) {
        return managementError(env, 404, "The gallery has not been synced yet.");
    }

    return managementJson({ keys, count: keys.length }, { status: 200 }, env);
}

async function handleGalleryUpload(env: Env, request: Request, now: Date): Promise<Response> {
    const auth = await verifySession(env.SESSION_SECRET, bearerToken(request.headers.get("Authorization")));
    if (!auth.ok) return managementError(env, 401, auth.reason);
    if (!auth.payload.canCreateEvents) {
        return managementError(env, 403, "Only officers can add photos.");
    }
    if (missingDriveConfig(env).length > 0) {
        return managementError(env, 503, "The gallery is not configured yet.");
    }

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return managementError(env, 400, "Expected a multipart form upload.");
    }

    const candidate = form.get("file");
    if (!candidate || typeof candidate === "string") {
        return managementError(env, 400, "No file was included.");
    }

    // Metadata is validated BEFORE the bytes are read, so an oversized or
    // wrong-type file is refused without being pulled into memory.
    const declared = validateGalleryUpload({
        name: candidate.name,
        mimeType: candidate.type,
        size: candidate.size,
    });
    if (!declared.ok) return managementError(env, 400, declared.error);

    const bytes = new Uint8Array(await candidate.arrayBuffer());
    // The declared type comes from the operating system's guess at the
    // extension, so the bytes get the final say.
    const sniffed = checkImageBytes(bytes);
    if (!sniffed.ok) return managementError(env, 400, sniffed.error);

    try {
        const created = await uploadGalleryImage(
            env,
            { name: declared.value.name, mimeType: sniffed.mimeType, bytes },
            now,
        );
        return managementJson(
            {
                id: created.id,
                name: created.name,
                // `mirrored: false` is not an error: the photo is safely in
                // Drive and the next sync will publish it. Reporting it lets
                // the UI say "saved, appearing shortly".
                mirrored: created.mirrored,
            },
            { status: 201 },
            env,
        );
    } catch (err) {
        const detail = err instanceof Error ? err.message : "The upload failed.";
        return managementError(env, 502, detail);
    }
}

/**
 * `POST /manage/gallery/sync` -- force a sync now.
 *
 * For an operator who has just bulk-copied photos into Drive and does not want
 * to wait for the cron, and for the CI step that seeds the bucket after a
 * deploy. Gated by `GALLERY_SYNC_TOKEN` rather than a Discord session so it can
 * be called from a script with no browser present; an unset token disables the
 * route entirely (fail closed).
 */
async function handleGallerySync(env: Env, request: Request, now: Date): Promise<Response> {
    const expected = env.GALLERY_SYNC_TOKEN;
    if (!expected) return managementError(env, 503, "Gallery sync is not enabled.");
    const provided = bearerToken(request.headers.get("Authorization"));
    // Constant-time comparison: a length-dependent early exit leaks how much of
    // a guessed token matched.
    if (!provided || !timingSafeEqualStrings(provided, expected)) {
        return managementError(env, 401, "Invalid sync token.");
    }
    const result = await syncGallery(env, now);
    return managementJson(
        {
            syncedAt: result.manifest.syncedAt,
            images: result.manifest.entries.length,
            mirrored: result.mirrored,
            deleted: result.deleted,
            pending: result.manifest.pending.length,
            warning: result.manifest.warning,
        },
        { status: 200 },
        env,
    );
}

/**
 * Compare two strings without short-circuiting on the first difference.
 *
 * Kept local because the manual loop is the whole point -- `===` on a secret is
 * a timing side channel.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
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
    | { kind: "auth-callback" | "session" | "create-event"; methods: string[] }
    | { kind: "delete-event"; methods: string[] }
    | { kind: "gallery-manifest" }
    | { kind: "gallery-image"; methods: string[] }
    | { kind: "gallery-upload"; methods: string[] }
    | { kind: "gallery-sync"; methods: string[] }
    | { kind: "gallery-hidden-list"; methods: string[] }
    | { kind: "gallery-hide"; methods: string[] }
    | { kind: "gallery-order"; methods: string[] };

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
    // Gallery. The manifest is public and read-only; the upload is officer-only
    // and lives under `/manage` like the other write routes. `/manage/gallery/sync`
    // is token-gated rather than session-gated so CI can seed the mirror with no
    // browser present.
    "/gallery": { kind: "gallery-manifest" },
    "/manage/gallery": { kind: "gallery-upload", methods: ["POST"] },
    "/manage/gallery/sync": { kind: "gallery-sync", methods: ["POST"] },
    // Hiding and restoring. `/manage/gallery/hidden` is listed BEFORE the
    // parameterized path is considered, and the id matcher below rejects a
    // non-id segment, so "hidden" can never be mistaken for a file id.
    "/manage/gallery/hidden": { kind: "gallery-hidden-list", methods: ["GET"] },
    // The display order. Same reasoning: listed before the parameterized prefix,
    // so "order" is claimed by this entry rather than treated as a file id.
    "/manage/gallery/order": { kind: "gallery-order", methods: ["GET", "PUT"] },
};

/**
 * Path prefix for a single event. Deletion addresses one event by id, which the
 * exact-match `ROUTES` table above cannot express, so it is matched separately
 * rather than turned into a regex entry -- keeping the table exact-match means a
 * typo'd path can never accidentally route to a handler.
 *
 * WARNING: The id is validated HERE, as part of matching, and not only inside the
 * handler. Two reasons: an unknown path must stay a 404 (a `/manage/events/admin`
 * typo should not answer 405 "method not allowed", which implies the path is
 * real), and this is the single place the value is checked before it is
 * interpolated into a Discord URL, so a crafted suffix cannot add path segments.
 */
const MANAGE_EVENT_PREFIX = "/manage/events/";

/**
 * Path prefix for one mirrored gallery image.
 *
 * WARNING: The id is validated as part of MATCHING, exactly like the event delete
 * path, and for the same reason: an unknown path must stay a 404 rather than
 * answering "method not allowed" (which implies the path is real), and this is
 * the single place the value is checked before it is used as an R2 key. R2 keys
 * are flat strings, so an unvalidated suffix could address a different object.
 */
const GALLERY_IMAGE_PREFIX = "/gallery/image/";

/**
 * Path prefix for hiding/restoring one photo.
 *
 * WARNING: Matched AFTER the exact-match table, so `/manage/gallery/hidden` and
 * `/manage/gallery/sync` are claimed before this prefix is considered. A
 * literal segment that happens to look like an id would otherwise be treated as
 * one.
 */
const MANAGE_GALLERY_PREFIX = "/manage/gallery/";

/**
 * Drive file ids: alphanumerics, hyphens and underscores.
 *
 * WARNING: This is deliberately BROADER than `^[A-Za-z0-9_-]+$` applied to a strict
 * length. Real Drive ids are 28-44 characters, but a Shared Drive id, an id
 * copied from a URL, and ids in test fixtures all differ in length. Rejecting a
 * short-but-legal id would 404 a real image, so only the CHARACTER SET is
 * enforced here -- which is what actually matters, since this value becomes an
 * R2 key and a URL path segment. Length is bounded on both ends purely to keep
 * a pathological key out of the bucket.
 */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{4,128}$/;

/** Discord snowflake: 15-20 decimal digits. */
const SNOWFLAKE = /^\d{15,20}$/;

/** Resolve a request path to a route, including the parameterized paths. */
function resolveRoute(pathname: string): { entry: RouteEntry; eventId?: string; fileId?: string } | null {
    const exact = ROUTES[pathname];
    if (exact) return { entry: exact };

    if (pathname.startsWith(MANAGE_EVENT_PREFIX)) {
        const eventId = pathname.slice(MANAGE_EVENT_PREFIX.length);
        // Exactly one snowflake segment, so `/manage/events/1/2` and
        // `/manage/events/not-an-id` are both simply unknown paths.
        if (SNOWFLAKE.test(eventId)) {
            return { entry: { kind: "delete-event", methods: ["DELETE"] }, eventId };
        }
    }

    if (pathname.startsWith(GALLERY_IMAGE_PREFIX)) {
        const fileId = pathname.slice(GALLERY_IMAGE_PREFIX.length);
        if (DRIVE_FILE_ID.test(fileId)) {
            return { entry: { kind: "gallery-image", methods: ["GET"] }, fileId };
        }
    }

    if (pathname.startsWith(MANAGE_GALLERY_PREFIX)) {
        const fileId = pathname.slice(MANAGE_GALLERY_PREFIX.length);
        if (DRIVE_FILE_ID.test(fileId)) {
            return { entry: { kind: "gallery-hide", methods: ["PATCH"] }, fileId };
        }
    }
    return null;
}

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

        const resolved = resolveRoute(pathname);
        if (!resolved) {
            return jsonResponse({ error: "not found" }, { status: 404 }, env);
        }
        const { entry: route, eventId, fileId } = resolved;
        const now = new Date();

        // Management routes carry the write-side CORS headers (which allow
        // POST/DELETE + Authorization) and must never be cached. The read routes
        // keep their own header set -- widening theirs would advertise a write
        // surface on endpoints that have none.
        //
        // WARNING: `gallery-manifest` and `gallery-image` are READ routes and must
        // stay out of this group. Putting them in would advertise POST/DELETE and
        // an Authorization header on public image endpoints, and would make the
        // browser preflight every image request.
        const isManagement =
            route.kind !== "json" &&
            route.kind !== "ics" &&
            route.kind !== "audiences" &&
            route.kind !== "gallery-manifest" &&
            route.kind !== "gallery-image";

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
                    return handleAuthUrl(env, url);
                case "auth-callback":
                    return handleAuthCallback(env, request);
                case "session":
                    return handleGetSession(env, request);
                case "delete-event":
                    return handleDeleteEvent(env, ctx, request, eventId ?? "");
                case "gallery-upload":
                    return handleGalleryUpload(env, request, now);
                case "gallery-sync":
                    return handleGallerySync(env, request, now);
                case "gallery-hidden-list":
                    return handleGalleryHiddenList(env, request);
                case "gallery-order":
                    return method === "PUT"
                        ? handleGallerySetOrder(env, request, now)
                        : handleGalleryOrderList(env, request);
                case "gallery-hide":
                    return handleGalleryHide(env, request, fileId ?? "", now);
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
            case "gallery-manifest":
                return handleGetGalleryManifest(env, ctx, now);
            case "gallery-image":
                return handleGetGalleryImage(env, fileId ?? "");
            default:
                return handleGetEvents(env, ctx, route.audience, parseChannelFilter(url.searchParams));
        }
    },

    /**
     * Cron entry point: keep the gallery mirror in step with the Drive folder.
     *
     * This is what makes "put a photo in Drive and it appears on the site" true
     * without anyone deploying. Scheduled in wrangler.jsonc.
     *
     * WARNING: A cron failure is logged and swallowed. Throwing would surface in the
     * Workers dashboard as an error on every run for what is usually a
     * transient Google problem, and the next run repairs it -- the manifest keeps
     * serving throughout.
     */
    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        if (missingDriveConfig(env).length > 0) {
            console.warn("gallery sync skipped: Drive is not configured");
            return;
        }
        ctx.waitUntil(
            syncGallery(env)
                .then((result) => {
                    console.log(
                        `gallery sync: ${result.manifest.entries.length} images, ` +
                            `${result.mirrored} mirrored, ${result.deleted} deleted, ` +
                            `${result.manifest.pending.length} pending` +
                            (result.manifest.warning ? ` (${result.manifest.warning})` : ""),
                    );
                })
                .catch((err: unknown) => {
                    console.error(`gallery sync failed: ${err instanceof Error ? err.message : "unknown error"}`);
                }),
        );
    },
    // Exported so `wrangler types` picks up the Env shape for editor use.
} satisfies ExportedHandler<Env>;
