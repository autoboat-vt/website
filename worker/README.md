# autoboat-discord-events Worker

Cloudflare Worker that proxies Discord's guild scheduled-events REST API for the
AutoBoat website calendar. The website is a fully static S3 site, so the bot
token cannot live in its bundle -- this Worker holds it server-side and serves
a normalized JSON list of events from a KV cache that doubles as a short
archive, so events survive Discord forgetting them.

```
website (browser)
    |  GET https://<worker>.workers.dev/events          <- public events only
    v
Cloudflare Worker (this repo, `worker/`)
    |  KV get "events:v2"  <- { fetchedAt, events }, the FULL set, all audiences
    |                        fresh while now - fetchedAt < CACHE_TTL_SECONDS
    |  KV put "events:v2"  (on a STALE read)  <- ONE write per miss (write budget!)
    |                        NO expiry by default (retention is unbounded)
    |  stale -> GET https://discord.com/api/v10/guilds/<guild_id>/scheduled-events?with_user_count=true
    |           Authorization: Bot ${DISCORD_BOT_TOKEN}
    |           normalize -> MERGE over the stored events -> write
    v
Discord API

(separately: GET /audiences -> GET .../channels, live and uncached)
```

RETENTION. Discord's list endpoint returns only `SCHEDULED`/`ACTIVE` events,
and both `COMPLETED` and `CANCELED` are terminal -- so an event disappears from
the API the moment it ends. A plain cache would forget it immediately. Each
refresh therefore merges the fresh events OVER the stored ones, keeping every
event Discord has stopped reporting. **Retention is unbounded: every event the
Worker has ever seen is kept.** That is what keeps past events on the calendar;
nothing on the website filters them. Set `RETENTION_DAYS` to opt into pruning.

## Routes

| Route | Contents |
| ----- | -------- |
| `GET /events` | Public events as JSON (the website's month grid). |
| `GET /calendar.ics` | The same public events as an iCalendar feed. |
| `GET /officers/events` | **All** events, including officer-only, as JSON. |
| `GET /officers/calendar.ics` | All events as an iCalendar feed. |
| `GET /audiences` | Diagnostics: the configured officer channel, plus every category and channel the Worker sees with its resolved audience. |

## Officer-only events

The team keeps an event internal by hosting it in a voice channel only the
officers can see. Since voice events have no `location`, the Worker derives the
audience from the channel the event was scheduled in:

```
event.channel_id === OFFICERS_CHANNEL_ID ? "officer" : "public"
```

WARNING: **The channel, not its category.** Every event voice channel -- officer,
subteam, and general member -- lives in the **same** category, so the category
is identical for every event and identifies nothing.

Exactly one officer channel is expected. Everything else is public, including
unrecognised channels -- the filter is deliberately **fail-open**, so a *second*
officer channel would be public until its id replaced the configured one.

### Finding `OFFICERS_CHANNEL_ID`

This is the one value that changes what the public calendar exposes, and a wrong
value **fails silently** -- the filter looks configured while officer events keep
being published. To find it, run the audit script. It is read-only (one `GET`,
nothing written) and never logs the token:

```bash
cd worker
npx wrangler login
DISCORD_BOT_TOKEN=<token> npm run channels
```

The token may instead live in `worker/.dev.vars` (gitignored):

```
DISCORD_BOT_TOKEN=<token>
```

The script prints the channel tree with every channel's id, marks the channel
currently configured as officer-only, and warns when the configured id is not a
channel in the guild or is not a voice/stage channel -- either way no event would
ever match it, so officer events would keep being published. That is the
silent-failure case this script exists to catch.

If the officer voice channel is **missing** from the output, the bot lacks
`VIEW_CHANNEL` on it (an explicit deny for `@everyone` overrides the bot's
server-wide permission). Its events then never reach the Worker at all, so
treat it as a configuration fault rather than a safe state. Fix it with a
channel-level permission override granting the bot `VIEW_CHANNEL`.

### Verifying after deploy

```bash
curl https://<worker-url>/audiences | jq .
```

It prints `officersChannelId` and each channel with the audience it resolves to,
so a wrong `OFFICERS_CHANNEL_ID` is visible rather than silently publishing
officer events.

### If you prefer the Discord UI

Enable **Developer Mode** (User Settings -> Advanced), then right-click the
**voice channel** that hosts officer events -> **Copy Channel ID**.

WARNING: Right-click the *channel* itself, not the category containing it. All event
channels share one category, so copying a category id gives you a value that
identifies nothing.

WARNING: **The `/officers/*` routes are not access-controlled.** They are unguessable
addresses, not protected ones -- anyone with the URL can read them. There is no
key and no login. Treat the URL as the thing to rotate if it spreads, and don't
link it from any public page.

## One-time setup

1. **Create the Discord application + bot.**

   - https://discord.com/developers/applications -> New Application. Name it
     something like "AutoBoat Website".
   - Left sidebar -> **Bot** -> **Reset Token**. Save the token somewhere
     private (a password manager). Do NOT commit it anywhere.
   - All **Privileged Gateway Intents** stay OFF -- this Worker uses REST only.

2. **Invite the bot to the team server.**

   - Left sidebar -> **OAuth2** -> **URL Generator**.
   - Scopes: check `bot`.
   - Bot Permissions: only **View Channels**. (Reading scheduled events
     requires `VIEW_CHANNEL`; no other permission is needed.)
   - Open the generated URL in a browser and pick the team server. You need
     the **Manage Server** permission in that server to complete the invite.

3. **Get the guild (server) ID.**

   - Discord client -> User Settings -> Advanced -> enable **Developer Mode**.
   - Back in the app, right-click the server in the left sidebar -> **Copy
     Server ID**.
   - Paste it into `wrangler.jsonc` under `vars.DISCORD_GUILD_ID` (this is
     public config, NOT a secret -- anyone in the server can see it).

4. **Create the KV namespace.**

   In this directory:

   ```bash
   bun install     # or npm install
   npx wrangler login
   npx wrangler kv namespace create EVENTS_KV
   npx wrangler kv namespace create EVENTS_KV --preview

   ```

   Copy the two `id` values from the output into `wrangler.jsonc`, replacing
   the `REPLACE_ME_KV_ID` / `REPLACE_ME_KV_PREVIEW_ID` placeholders.

5. **Store the bot token as a secret.**

   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   # paste the bot token when prompted -- it is stored encrypted on Cloudflare
   ```

   For local dev (`wrangler dev`), also create a `.dev.vars` file in this
   directory (it is gitignored):

   ```
   DISCORD_BOT_TOKEN=<your-token-here>
   ```

## Local development

```bash
bun install
npx wrangler dev          # starts on http://localhost:8787
curl http://localhost:8787/events | jq .
curl http://localhost:8787/calendar.ics
```

For the website to hit the local Worker, start it with
`VITE_EVENTS_URL=http://localhost:8787 bun run dev` from the website root.

## Deploy

```bash
npx wrangler deploy       # from worker/
```

The output line ends with the production URL, e.g.
`https://autoboat-discord-events.<your-account>.workers.dev`. Paste that into
[src/lib/discord.ts](../src/lib/discord.ts) as the `EVENTS_URL` fallback.

## Subscribing to the calendar

`GET /calendar.ics` serves the same events as an iCalendar feed, so anyone
can add the team calendar to Google Calendar, Apple Calendar, or Outlook:

```
https://autoboat-discord-events.<your-account>.workers.dev/calendar.ics
```

- `webcal://` + the same URL (scheme swapped) hands the feed to the OS
  calendar app as a live subscription.
- Google Calendar: **Other calendars** -> **From URL** -> paste the `https://`
  URL.
- Outlook on the web: **Add calendar** -> **Subscribe from web**.

The `/calendar` page has a **Subscribe** control that offers all of these
plus a copy-link button, so users normally don't need to handle the URL by
hand. Note that real subscriptions only work against the deployed Worker --
`wrangler dev` runs locally and is unreachable from a calendar app on another
machine.

The feed is generated by [src/ics.ts](src/ics.ts). Recurring Discord events
are emitted as a single VEVENT carrying the `RRULE` (clients expand it
natively) rather than being expanded server-side, and everything is
serialized in UTC.

## Configuration reference

Set via `vars` in `wrangler.jsonc` (public, non-secret):

- `DISCORD_GUILD_ID` — Discord server ID.
- `ALLOWED_ORIGIN` — the only browser origin allowed to call this Worker.
  Default: `https://autoboat.aoe.vt.edu`. Do NOT set to `*` in production.
- `CACHE_TTL_SECONDS` — how long a cached payload is considered fresh, in
  seconds. **180** (3 minutes), and must stay at or above it (see "KV write
  budget"). This is the refetch rate, not the key's lifetime.
  Also advertised to calendar clients as the `.ics` refresh interval.
- `RETENTION_DAYS` — **optional**, and left unset by default, which keeps
  **every** event forever. Set it to prune archived events older than N days.
  Discord returns only `SCHEDULED`/`ACTIVE` events, so the archive is what makes
  past events visible at all. It does **not** affect the KV write budget (the
  miss rate is set by `CACHE_TTL_SECONDS`); it only bounds how much history is
  kept. Total history is bounded regardless by `MAX_ARCHIVED_EVENTS`.
  A malformed value keeps everything rather than falling back to a cutoff, since
  discarding history is unrecoverable.
- `CALENDAR_NAME` — display name for the `.ics` feed. Default
  "AutoBoat at Virginia Tech". The `/officers/calendar.ics` route defaults to
  "AutoBoat Officers" instead.
- `OFFICERS_CHANNEL_ID` — the officer-only voice channel id. **The only audience
  setting.** Omit it to use `DEFAULT_OFFICERS_CHANNEL_ID` in `src/audience.ts`;
  a **blank** value means "no officer channel", which makes the Worker serve
  **nothing** (fail-closed) rather than guess. Verify it with `/audiences`.

Set via `wrangler secret put` (secret, never committed):

- `DISCORD_BOT_TOKEN` — the Discord bot's token.

## Behavior notes

- Handles `GET /events` (JSON) and `GET /calendar.ics` (iCalendar feed),
  plus `OPTIONS` preflight for both. Everything else 404s. Trailing slashes
  are ignored, so `/events/` and `/calendar.ics/` work too.
- Both routes share one KV cache via a common `loadEvents()` helper, so the
  JSON payload and the feed can never disagree. The value is an archive
  (`{ fetchedAt, events }`) holding the **full** event set; each route filters
  in memory. See "Event retention" below for why it is an archive and not a
  plain cache.
- While `OFFICERS_CHANNEL_ID` is blank the Worker serves **no** events and
  reports `X-Audience-Configured: false`. It cannot tell an officer event from a
  public one in that state, so serving the public calendar would publish the
  officer one. The KV event write is skipped too, so a poisoned cache cannot
  outlive the misconfiguration.
- Discord upstream failures produce a generic `502` with the CORS headers
  intact. The bot token is never included in responses, logs, or error bodies.
- KV writes are fire-and-forget via `ctx.waitUntil` so the response isn't
  blocked on the write.
- The KV read uses `cacheTtl` equal to the cache TTL -- this keeps KV reads
  served from the Cloudflare edge cache between refreshes.
- `X-Cache: HIT` means the stored entry was still fresh (`now - fetchedAt <
  CACHE_TTL_SECONDS`), not merely that the key existed. The key outlives the
  cache TTL by design.

## Event retention

WARNING: **Discord's scheduled-events endpoint returns only `SCHEDULED` and
`ACTIVE` events.** `COMPLETED` and `CANCELED` are terminal statuses, so an
event drops out of the API the moment it ends (a voice/stage event completes a
few minutes after the last person leaves the channel; an external event
completes at its end time). A cache that mirrors that list therefore forgets
every meeting as soon as it happens.

`src/archive.ts` closes the gap. On each refresh the freshly fetched events
are merged over the stored ones:

1. **Fresh wins** -- an event still in Discord's list is taken verbatim, since
   its name, description, or start time may have changed.
2. **Every event that fell out of the list is kept** -- this is unbounded by
   default. It is deliberately unconditional, because Discord drops an event
   for exactly two reasons (it completed, or it was removed) and the API cannot
   tell them apart.
   - an event that had **ended** is marked `completed`, so the calendar renders
     it as history;
   - an event that had **not ended** keeps its status, since marking it
     `completed` would claim a meeting happened that never did;
   - an already-`canceled` event keeps its status, which is styled differently.
3. **Malformed events are dropped** -- a record whose dates cannot be parsed
   can neither be reasoned about nor aged out.
4. **Nothing is dropped for being old** unless `RETENTION_DAYS` is set. The
   result is still held under `MAX_ARCHIVED_EVENTS`, which is a safety ceiling
   rather than a retention policy (roughly a 600 KB value, ~50 years of weekly
   meetings).

The merge keys on Discord's event id, so a recurring event -- which appears in
every payload under one stable id -- is never duplicated.

WARNING: **Freshness lives in the value, not in KV's expiry.** The key is
written with **no `expirationTtl`** in the default unbounded mode, so a plain
"is the key present?" check would serve stale data forever. A miss is
`now - fetchedAt >= CACHE_TTL_SECONDS`, and it still costs exactly one write.
Do not add a second key. If you set `RETENTION_DAYS`, the key expires on that
window (floored at 2x the cache TTL, capped at KV's 1-year maximum) -- do not
set it below the cache TTL.

WARNING: Do not give the key an expiry while retention is unbounded. The failure
is silent and total: the history lapses, the next request archives only what
Discord still reports, and past events disappear again -- the exact bug this
feature fixes. `routes.test.ts` asserts the write carries no `expirationTtl` in
that mode.

A legacy entry written before retention (a bare array rather than
`{ fetchedAt, events }`) is read as infinitely stale, so it is refetched and
rewritten in the new shape on first use instead of being dropped.

## KV write budget

WARNING: **This Worker runs on the Workers KV FREE tier: 1,000 writes/day.** Reads
are 100,000/day and are never the constraint. Only a cache **miss** costs a
write, so:

```
writes/day = (86400 / CACHE_TTL_SECONDS) * writes-per-miss
```

A 60 s TTL with two writes per miss (the events payload plus a `channels:v1`
cache the event path did not need) came to ~2,880 writes/day -- about 3x the
limit -- and was hit in production.

WARNING: **It does not degrade gracefully.** A rejected write means the entry never
lands, so every following request is also a miss and keeps retrying. The calendar
renders empty and stays empty until the daily limit resets at 00:00 UTC.

Two invariants keep it inside the budget:

1. **One KV write per cache miss**, always the key `events:v2`. The channels
   endpoint is fetched live by `/audiences` only, and never cached.
2. **`CACHE_TTL_SECONDS` >= 180.** At 180 s a continuously-active site costs
   480 writes/day, leaving roughly 2x headroom; the floor exists so the margin
   survives retries and redeploys. `routes.test.ts` reads the value off
   `wrangler.jsonc` and asserts it, so lowering it fails the suite.

Note the website's `EVENTS_POLL_INTERVAL_MS` does **not** affect this: a warm
cache is pure reads. Only the TTL and the writes-per-miss do.

Retention does **not** change the arithmetic either. `RETENTION_DAYS` makes each
stored value larger, not the writes more frequent: that is exactly why
freshness moved into `fetchedAt` rather than being left to KV's expiry. A
separate archive key would double writes/day to ~960 and put the free tier over
budget.

## Why not Discord webhooks?

There is no way to *pull* guild events with an incoming webhook -- channel
webhooks are POST-only. Discord's "outgoing" Webhook Events (push events to
your app over HTTP) do not include guild scheduled-event types in their event
list. Scheduled-event create/update/delete events only exist on the Gateway
(a persistent bot WebSocket connection), which needs an always-on process.
This Worker + KV approach is the smallest server-side surface that works for
a read-only calendar.
