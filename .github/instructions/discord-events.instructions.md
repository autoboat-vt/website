---
description: "Use when working on the calendar page, the Discord events client, or the Cloudflare Worker that serves Discord guild scheduled events. Covers the no-webhook constraint, the Worker architecture, KV caching, VITE_EVENTS_URL, and rrule recurrence expansion."
applyTo: "src/lib/discord.ts, src/pages/Calendar.tsx, src/test/lib/discord.test.ts, src/test/pages/Calendar.test.tsx, worker/**"
---

# Discord events + calendar

The `/calendar` page on the website displays Discord guild scheduled events as a month-grid calendar. Because the site is fully static, the page cannot hold the Discord bot token itself -- a small Cloudflare Worker in `worker/` proxies the API server-side.

## Architecture

```
website (browser)
    |  GET https://<worker>.workers.dev/events
    v
worker/ (Cloudflare Worker)
    |  KV get "events"  (60 s TTL)
    |  miss -> GET https://discord.com/api/v10/guilds/<guild_id>/scheduled-events?with_user_count=true
    |           Authorization: Bot ${DISCORD_BOT_TOKEN}
    v
Discord API
```

The Worker normalizes Discord's `GuildScheduledEvent` shape into a small `CalendarEvent` record (`src/lib/discord.ts`), which is what the website consumes. The Worker owns:

- CORS (locked to `https://autoboat.aoe.vt.edu` via `ALLOWED_ORIGIN` var).
- KV caching (key `"events"`, TTL from `CACHE_TTL_SECONDS` var, 60 s in `wrangler.jsonc`, `parseTtlSeconds` fallback 300 s). KV writes are fire-and-forget via `ctx.waitUntil` so the response isn't blocked on them. Responses also send `Cache-Control: public, max-age=<TTL>` -- the client must fetch with `cache: "no-store"` or the browser cache defeats background polling.
- Pre-mapping Discord's numeric status/entity_type codes to lowercase strings (`scheduled | active | completed | canceled`).

The website owns:

- Background refresh: `Calendar.tsx` polls `fetchEvents` every `EVENTS_POLL_INTERVAL_MS` (60 s, deliberately matching the KV TTL) with the same visibility-aware pattern as `LiveMap.tsx` -- skip while `document.hidden`, immediate repoll on visibility, abort the in-flight poll before starting a new one. Transient poll failures keep the last-good events; the error card only appears when nothing has loaded yet.
- RRULE expansion for recurring events (via the `rrule` package).
- The month-grid UI, day-name headers, and chip rendering.

## No-webhook constraint

Discord incoming webhooks are POST-only on a channel -- they cannot *pull* guild events. Discord's "outgoing" Webhook Events (push to your app over HTTP) do not include any `GUILD_SCHEDULED_EVENT_*` types in their event list. Scheduled-event create/update/delete events only exist on the Gateway (persistent bot WebSocket connection), which requires an always-on process. The Worker + KV approach is the smallest server-side surface that works for a read-only calendar.

## Key exports in `src/lib/discord.ts`

- `EVENTS_URL` — base Worker URL (from `globalThis.__VITE_EVENTS_URL__` or a placeholder default; override with the `VITE_EVENTS_URL` env var).
- `DISCORD_GUILD_ID` — public guild id used to deep-link chips to Discord. Keep in sync with `DISCORD_GUILD_ID` in `worker/wrangler.jsonc`.
- `fetchEvents(signal?)` — GET with `cache: "no-store"`, returns `CalendarEvent[]`. Structural-invalid payloads degrade to `[]` rather than throwing; HTTP/network errors throw `DiscordError`. When the API `location` is null, the event is enriched via `extractLocationFromDescription` (team events are voice-channel events for role-scoped signup, so Discord's `entity_metadata.location` is always empty and the physical location lives in the description).
- `extractLocationFromDescription(description)` — returns `{ location, description }`: pulls the location out (labeled `Location:`/`Where:` line, else first bold span) and strips the matched text from the description so the modal doesn't render it twice.
- `expandRecurrences(events, from, to)` — expands every RRULE event into concrete occurrences inside `[from, to]`. Malformed RRULEs fall back to a single occurrence at the base start.
- `discordEventUrl(event)` — `https://discord.com/channels/<guildId>/<eventId>`.

## Worker env configuration

`worker/wrangler.jsonc` holds public config as `vars`:

- `DISCORD_GUILD_ID` — public, not a secret.
- `ALLOWED_ORIGIN` — deployment origin; do NOT set to `*` in production.
- `CACHE_TTL_SECONDS` — KV TTL, `60` in production config (`parseTtlSeconds` in the worker falls back to `300` for unparseable/missing values). Lower values mean more Discord API hits; keep the website's `EVENTS_POLL_INTERVAL_MS` in sync with this.

Secrets (never committed) go in via `wrangler secret put`:

- `DISCORD_BOT_TOKEN` — the Discord bot's token.

For local `wrangler dev`, drop a `.dev.vars` file in `worker/` (gitignored). See `worker/README.md` for the full one-time setup.

## Route wiring

The `/calendar` route is registered in four places, all of which MUST stay in sync:

1. `src/App.tsx` — `<Route path="/calendar" element={<Calendar />} />`.
2. `src/components/Header.tsx` — `NAV_LINKS` entry `{ to: "/calendar", label: "Calendar" }` (between Sponsors and Live Map).
3. `scripts/spa-fallback.mjs` — `ROUTES` array includes `"/calendar"` so the S3 SPA fallback writes `dist/calendar/index.html`.
4. `README.md` — routes table + `VITE_EVENTS_URL` env var description.

Drop any of the four and the route breaks in a different way (client-side vs S3 vs nav vs docs).

## Recurrence expansion

Discord's `recurrence_rule` is an RFC 5545 RRULE body (no leading `RRULE:` prefix). The client prepends `RRULE:` and calls `rrulestr` with `dtstart` set to the event's base `scheduled_start_time`. Every occurrence inside the current month grid becomes one chip; each occurrence's `end` is shifted by the base event's duration so multi-hour meetings keep their length.

Two edge cases the month-grid rendering handles on top of the recurrence expansion:

1. **Zero-duration events** (start == end, e.g. small announcements without an end time): the grid-cell date filter uses a half-open interval so an event whose start and end coincide with the day's start-of-day boundary still renders on that day. Without this guard the strict `end > dayStart` comparison would drop the chip entirely. See `buildMonthGrid` in `src/pages/Calendar.tsx`.
2. **Variable-row month grids**: `cellCount` is derived from date values (`gridStartOffset + lastOfMonth.getDate() + daysFromSaturdayInMonth`), NOT from `(gridEnd - gridStart) / 86400_000`. Timestamp math crosses DST transitions (23- and 25-hour days) and rounds wrong, leaving the grid a few cells short. Iterate by date so each cell is exactly one calendar day.

Discord's RRULE subset (as of API v10 / 2026) is:

- `frequency`: YEARLY(0), MONTHLY(1), WEEKLY(2), DAILY(3).
- `interval`: 1 (every N) or 2 (every other week, weekly only).
- `by_weekday`: weekly, max length 1; `0=Mon..6=Sun`. Maps to RFC `BYDAY=MO|TU|WE|TH|FR|SA|SU`.
- `by_n_weekday`: monthly Nth-weekday (e.g. `{n:4, day:2}` == "4th Wednesday" == `BYDAY=WE;BYSETPOS=4`).
- `by_month` + `by_month_day`: yearly.

The `rrule` package handles the full RFC 5545 grammar, so all of the above variants work transparently.

## Tests

- `src/test/lib/discord.test.ts` — `fetchEvents` (happy/error/malformed/abort cases, mock fetch with duck-typed responses) and `expandRecurrences` (weekly, daily, UNTIL clip, malformed-RRULE fallback, duration shift, sort order).
- `src/test/pages/Calendar.test.tsx` — page render states (loading, success, error, empty), chip rendering with real Discord URL, recurrence expansion, month nav, error-card behavior.

Both follow the existing `LiveMap.test.tsx` patterns: `MemoryRouter` wrap, `mockFetchOnce` / `mockFetchSequence`, `flushMicrotasks()` to drain the `.then()` chain, restore `global.fetch` in `afterEach`.
