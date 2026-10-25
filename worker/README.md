# autoboat-cloudflare-helper Worker

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

DELETION is the one exception. The list endpoint cannot tell a finished event
from a deleted one, but the guild audit log can: an entry of action type 102
(`GUILD_SCHEDULED_EVENT_DELETE`) names the deleted event's id. Each refresh also
reads `GET .../audit-logs?action_type=102` and drops those ids from the
archive, so deleting an event in Discord removes it from the calendar. The
audit read is best-effort and costs no extra KV write; if it fails the archive
keeps everything, exactly as before.

## Routes

| Route | Contents |
| ----- | -------- |
| `GET /events` | Public events as JSON (the website's month grid). |
| `GET /calendar.ics` | The same public events as an iCalendar feed. |
| `GET /officers/events` | **All** events, including officer-only, as JSON. |
| `GET /officers/calendar.ics` | All events as an iCalendar feed. |
| `GET /audiences` | Diagnostics: the configured officer channel, plus every category and channel the Worker sees with its resolved audience. |
| `GET /manage/auth/url` | The Discord OAuth authorize URL to send a browser to. |
| `POST /manage/auth/callback` | Exchanges an authorization code for a session token. |
| `GET /manage/session` | Confirms a bearer token is still valid. |
| `POST /manage/events` | Creates a guild scheduled event. **Officers only.** |
| `DELETE /manage/events/{id}` | Deletes a guild scheduled event. **Officers only.** |
| `GET /gallery` | Public gallery manifest: every image in the Drive folder whose bytes are already mirrored to R2. |
| `GET /gallery/image/{id}` | One mirrored image's bytes, streamed from R2. |
| `POST /manage/gallery` | Uploads a photo to Drive and mirrors it. **Officers only.** |
| `PATCH /manage/gallery/{id}` | Hides or restores a photo. **Officers only.** Nothing is deleted. |
| `GET /manage/gallery/hidden` | The photos an officer has removed. **Officers only.** |
| `GET /manage/gallery/order` | The visible photos, in their current display order. **Officers only.** |
| `PUT /manage/gallery/order` | Sets the display order. **Officers only.** |
| `POST /manage/gallery/sync` | Forces a Drive sync. Token-gated, for CI or an operator. |

## Creating events from the website

Officers can add events to the calendar without opening Discord. The flow is a
standard OAuth2 authorization-code grant, with the code exchanged here because
the exchange requires the client secret.

```
browser                      Worker                        Discord
  | GET /manage/auth/url         |                              |
  |<--- authorize URL -----------|                              |
  |------ navigate ------------------------------------------>  |
  |<----- 302 <site>/calendar/?code=..&state=.. --------------  |
  | POST /manage/auth/callback   |                              |
  |   { code, state } ---------->|-- POST /oauth2/token ------>|
  |                              |<--- user access token ------|
  |                              |-- GET /users/@me ---------->|
  |                              |-- GET /users/@me/guilds --->|
  |                              |   evaluate MANAGE_EVENTS     |
  |<--- { token, name, expires }-|                              |
  | POST /manage/events          |                              |
  |   Authorization: Bearer      |-- POST /guilds/../scheduled-events -->
  |<--- { event, officerOnly } --|                              |
  | DELETE /manage/events/{id}   |                              |
  |   Authorization: Bearer      |-- DELETE /guilds/../scheduled-events/{id} -->
  |<--- { deleted } -------------|                              |
```

### Why only officers

Events are created with the **bot's** token, so Discord enforces the bot's
permissions -- and the bot holds `MANAGE_EVENTS`. Discord will create an event
for any caller who reaches the endpoint. The permission check in
`worker/src/permissions.ts` is therefore the only gate, and it requires
`MANAGE_EVENTS` (or `ADMINISTRATOR`, or guild ownership) in the team guild.

WARNING: `CREATE_EVENTS` is deliberately NOT enough. Ordinary members hold it, so
accepting that bit would let anyone in the server publish events, including
into the officer channel.

### Configuring it

1. **Register the redirect URI in the Discord developer portal.**

   This is the step people get stuck on, because the setting is in a different
   tab from the client id and Discord's failure message is terse.

   - Go to https://discord.com/developers/applications
   - Click your application (the same one the bot lives in).
   - Left sidebar -> **OAuth2**. (NOT "OAuth2 -> General" in some layouts; the
     redirect field is on the main OAuth2 page.)
   - Find the **Redirects** section.
   - Click **Add Redirect**, paste the exact URL, then click **Save Changes**
     at the bottom of the page.

   The value MUST match `OAUTH_REDIRECT_URI` in `wrangler.jsonc`
   char-for-char, including the trailing slash:

   ```
   https://autoboat.aoe.vt.edu/calendar/
   ```

   WARNING: Forgetting **Save Changes** is the classic failure: the field looks filled in,
   but Discord never stored it.

   WARNING: If Discord shows **"Invalid OAuth2 redirect_uri"**, the URL the Worker sent is
   not on that list. Compare them exactly -- a missing trailing slash
   (`/calendar` vs `/calendar/`), an `http://` vs `https://`, or the `www.` host
   are all distinct strings to Discord, and all of them fail this way.

   NOTE: Local development still sends the PRODUCTION redirect URI, because that is
   what `OAUTH_REDIRECT_URI` holds. So testing "sign in" from
   `localhost` logs in and then lands you on the production site. To keep the
   flow local, add a second redirect entry such as
   `http://localhost:3000/calendar/` and point `OAUTH_REDIRECT_URI` at it in
   `worker/.dev.vars` instead.

2. **Copy the client id into `wrangler.jsonc`.**

   - Same **OAuth2** page -> **Client ID**.
   - Put it in `wrangler.jsonc` as `DISCORD_CLIENT_ID` (public -- it appears in
     the authorize URL the browser visits).

3. **Store the secrets.**

   ```bash
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET
   ```

   `DISCORD_CLIENT_SECRET` comes **from Discord** (developer portal -> your
   application -> OAuth2 -> **Reset Secret**).

   `SESSION_SECRET` comes from **nowhere** -- there is no portal that issues it.
   It is an HMAC key this Worker uses to sign its own session tokens, so you
   invent it. Any long random string works; the only requirements are that it
   is unguessable and that it never leaves Cloudflare:

   ```bash
   # macOS / Linux: generate 32 random bytes, base64-encoded
   openssl rand -base64 32

   # No openssl? Node/Bun can do it:
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Paste the ONE line it prints into the `wrangler secret put SESSION_SECRET`
   prompt. Do NOT commit it, put it in `wrangler.jsonc`, or reuse the bot token
   or client secret for it -- those are all different credentials, and keeping
   them separate means rotating one does not break the other.

   WARNING: Rotating `SESSION_SECRET` invalidates every outstanding session immediately.
   That is the intended "sign everyone out" mechanism, and it costs nothing else
   -- officers just log in again.

   NOTE: `wrangler secret put` writes to the DEPLOYED Worker. For `wrangler dev`,
   also add both values to `worker/.dev.vars` (gitignored):

   ```
   DISCORD_CLIENT_SECRET=<from Discord>
   SESSION_SECRET=<the line you just generated>
   ```

   `DISCORD_CLIENT_ID` and `OAUTH_REDIRECT_URI` are NOT secrets -- they stay in
   `wrangler.jsonc` under `vars`. Putting them in `.dev.vars` is harmless but
   unnecessary.

3. **Grant the bot `MANAGE_EVENTS`.**

   WARNING: The invite URL only sets permissions on FIRST invite, so re-opening it
   for a bot that is already in the server does nothing. Edit the bot's
   auto-created **role** in Server Settings -> Roles and enable
   **Manage Events**.

4. **Deploy the Worker.**

   ```bash
   npx wrangler deploy
   ```

   WARNING: `wrangler secret put` does not redeploy on its own, but a `vars` change
   (like `DISCORD_CLIENT_ID` or `OAUTH_REDIRECT_URI`) only reaches the running
   Worker after a deploy. If you just edited `wrangler.jsonc` and the error
   persists, this is why.

5. **Verify** that `GET <worker-url>/manage/auth/url` returns 200, then try the
   **Add event** button on the calendar.

### Deleting events

A signed-in officer can remove an event without leaving the site: open the event
on the calendar and use **Delete event**, then confirm. Nothing extra needs to be
configured beyond the sign-in above -- the same session and the same
`MANAGE_EVENTS` check apply.

What a delete does:

- Calls `DELETE /guilds/{guild}/scheduled-events/{id}` with the **bot's** token,
  tagging the request with an `X-Audit-Log-Reason` so the deletion is legible in
  the server's audit log.
- Drops the event from the KV archive immediately, so the calendar (and the
  `.ics` feed) stop serving it on the next request rather than after a refresh.
- Leaves the archive's `fetchedAt` alone. Removing one row does not make the rest
  newer, and bumping it would delay the refresh that would reveal other changes.

WARNING: A **recurring** event is a single Discord record, so deleting it removes
every occurrence. Discord has no per-occurrence delete; to skip one week, use the
description's `Cancelled:` convention instead (see the calendar instruction file).

A delete made in the Discord client still works and still removes the event from
the calendar, via the audit-log detection on the next refresh (see "Event
retention"). The two paths do not conflict.

### Troubleshooting "Event creation is not configured"

The 503 names each value that is still missing, and where it belongs:

```
Event creation is not configured. Missing: DISCORD_CLIENT_SECRET
(wrangler secret put DISCORD_CLIENT_SECRET), OAUTH_REDIRECT_URI
("OAUTH_REDIRECT_URI" in wrangler.jsonc vars).
```

Read that list literally -- only the values it names are absent, so a value you
just set correctly will not appear. If a value you DID set still appears, check
that you set it in the right place:

| Value | Lives in | Set with |
| --- | --- | --- |
| `DISCORD_CLIENT_ID` | `wrangler.jsonc` `vars` | edit the file, then `deploy` |
| `OAUTH_REDIRECT_URI` | `wrangler.jsonc` `vars` | edit the file, then `deploy` |
| `DISCORD_CLIENT_SECRET` | Cloudflare secret | `wrangler secret put` (no deploy needed) |
| `SESSION_SECRET` | Cloudflare secret | `wrangler secret put` (no deploy needed) |

Verify from outside without a browser:

```bash
curl -s https://<worker-url>/manage/auth/url | jq .
# 200 + {"url": "https://discord.com/oauth2/authorize?..."}  -> configured
# 503 + {"error": "Event creation is not configured. Missing: ..."} -> read the list
```

That only proves the Worker has all four values. To see exactly which
`redirect_uri` it will send Discord, print it out:

```bash
curl -s https://<worker-url>/manage/auth/url \
  | jq -r '.url' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(new URL(s.trim()).searchParams.get('redirect_uri')))"
```

Whatever that prints must appear verbatim in the portal's **Redirects** list.

### Troubleshooting "Invalid OAuth2 redirect_uri"

This error comes from **Discord**, not the Worker -- the authorize page rejects
the `redirect_uri` because it is not registered on the application. The Worker
is fine; the portal entry is missing or does not match.

Fix it at https://discord.com/developers/applications -> your application ->
**OAuth2** -> **Redirects** -> **Add Redirect** -> paste -> **Save Changes**.

Common mismatches, all of which Discord treats as different strings:

| Wrong | Right | Why |
| --- | --- | --- |
| `https://autoboat.aoe.vt.edu/calendar` | `https://autoboat.aoe.vt.edu/calendar/` | missing trailing slash |
| `http://autoboat.aoe.vt.edu/calendar/` | `https://autoboat.aoe.vt.edu/calendar/` | http vs https |
| `https://www.autoboat.aoe.vt.edu/calendar/` | `https://autoboat.aoe.vt.edu/calendar/` | `www.` is a different host |
| `https://autoboat.aoe.vt.edu` | `https://autoboat.aoe.vt.edu/calendar/` | missing path |

Also check that you clicked **Save Changes** -- a typed-but-unsaved redirect
looks correct on screen and is not stored. And confirm you are editing the same
application whose **Client ID** is in `wrangler.jsonc`; a redirect registered on
a different app fails identically.

### Security notes

- The session is a **bearer token**, not a cookie. The site and the Worker are
  different origins, so a cookie set by the Worker is third-party and blocked
  by Safari. The token lives in `localStorage` and is sent as
  `Authorization: Bearer`. It expires after **2 hours**.
- The Discord **user** access token is used for exactly two reads and then
  discarded. It is never stored, logged, or returned to the browser.
- The permission decision is carried in the signed token (`canCreateEvents`),
  so demoting someone takes effect within the token's 2-hour lifetime.
- Session tokens are **stateless** -- login costs zero KV writes, which matters
  against the free tier's 1,000 writes/day. A successful event create costs one
  write (the archive merge) so the new event is visible immediately; a delete
  costs one write to drop the id from the archive, for the same reason.
- Editing events stays in Discord. Deletion is available from both places: the
  website's `DELETE /manage/events/{id}` and the Discord client. Both converge
  on the same archive, so the calendar cannot disagree with itself. A delete
  made from the website removes the id from the archive directly instead of
  waiting for the audit-log read, which is best-effort and may be unavailable
  when the bot lacks `VIEW_AUDIT_LOG`.

### Filtering by subteam (`?channels=`)

All four event routes accept an optional `?channels=<id>,<id>` query parameter
that keeps only events scheduled in those Discord channels:

```bash
curl 'https://<worker-url>/events?channels=1550592611859955862'
curl 'https://<worker-url>/calendar.ics?channels=1550592611859955862,1550592740486553650'
```

The website's **Filter** control generates these URLs, including for the
subscription feed, so a user can subscribe to just their subteam.

- An **absent, blank, or unparseable** value means "everything" -- never
  "nothing". A malformed query cannot blank a subscription.
- An event with **no channel** (an `EXTERNAL` event) never matches a non-empty
  filter; there is no channel to compare.
- The **audience filter still runs first**, so `?channels=<officer-channel>` on
  the public route returns nothing -- the parameter cannot be used to reveal
  officer events.
- Filtering is applied after the cache read, so it costs **no extra KV writes**.
  Do not move it into the cache path.

On the website only **subteam** channels are filterable. General member events
are always shown, and officer events are always shown on the page that reaches
them. See `src/lib/eventChannels.ts`.

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
   - Bot Permissions: **View Channels** and **View Audit Log**. (Reading
     scheduled events requires `VIEW_CHANNEL`. Deleting an event removes it from
     the calendar via the audit log, which requires the `VIEW_AUDIT_LOG`
     permission; without it a deleted event lingers as history.)
   - Open the generated URL in a browser and pick the team server. You need
     the **Manage Server** permission in that server to complete the invite.
   - Shortcut: the two permissions together are **1152**
     (`VIEW_CHANNEL` 1024 + `VIEW_AUDIT_LOG` 128), so the invite URL can be
     built by hand:
     `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1152`

   WARNING: The invite URL only sets permissions on **first** invite. A server
   that already has the bot will not pick up a new permission by re-opening the
   link -- it redirects with no error and changes nothing. Update the granted
   permissions instead; see "Granting a permission to an already-invited bot".

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

### Granting a permission to an already-invited bot

The bot needs **two** permissions, and re-opening the invite URL is NOT how you
add one to a server that already has the bot:

| Permission | Value | Needed for |
| --- | --- | --- |
| `VIEW_CHANNEL` | 1024 (`1 << 10`) | reading scheduled events and the audit log |
| `VIEW_AUDIT_LOG` | 128 (`1 << 7`) | seeing that an event was deleted (vs. merely finishing) |

Combined: **1152**.

WARNING: **The invite URL sets permissions only on FIRST invite.** If the bot is
already in the server, re-opening
`https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1152`
does nothing -- it redirects to the app's page with no error and grants nothing.
This is the trap: it looks like it worked, and the audit read then fails
silently (the archive just keeps deleted events as history).

To update an existing install, use the **bot's auto-created role**:

1. Discord client -> **Server Settings -> Roles**.
2. Find the role named after the bot (Discord creates one per bot and it is
   assigned automatically).
3. Enable **View Audit Log**. Leave **View Channels** enabled too.
4. Save. No redeploy is needed -- the Worker reads the permission fresh on each
   audit request.

NOTE: The bot's own role can only be edited by someone whose highest role is
above it, and by the server owner. If the role is not editable, the bot was
invited with `ADMINISTRATOR` (which already includes `VIEW_AUDIT_LOG`, so
nothing needs doing) or the account lacks **Manage Roles**.

WARNING: Do NOT edit channel-level permission overwrites to grant this. Audit
logs are a **guild-level** permission with no channel scope, so a channel
overwrite cannot grant it -- the role is the only place it applies.

Verify it took effect:

1. Note the id of an event you no longer need (`GET <worker-url>/events`).
2. Delete that event in Discord.
3. Within one cache TTL (<= 180 s) it must be gone from `GET <worker-url>/events`.

WARNING: If it is still there, the audit read is being rejected and the failure is
**silent** -- `fetchDeletedEventIds` swallows the error on purpose, because a
failed audit read must never blank the calendar. The event then simply stays as
history. Confirm the permission in Server Settings -> Roles, or check the
Cloudflare Worker logs for the audit request's status.

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
npx wrangler deploy       # from worker/  (or: bunx wrangler deploy)
```

Or deploy the Worker **and** the website in one shot from the repo root — the
root `scripts/deploy.sh` runs this same `wrangler deploy` step (picking `bunx`
when available, else `npx`):

```bash
./scripts/deploy.sh               # site + Worker
./scripts/deploy.sh --skip-worker # site only
```

The output line ends with the production URL, e.g.
`https://autoboat-cloudflare-helper.<your-account>.workers.dev`. Paste that into
[src/lib/discord.ts](../src/lib/discord.ts) as the `EVENTS_URL` fallback.

Redeploying does not disturb `DISCORD_BOT_TOKEN` — Cloudflare secrets survive
`wrangler deploy`. They are lost only if the Worker is deleted and recreated.

## Subscribing to the calendar

`GET /calendar.ics` serves the same events as an iCalendar feed, so anyone
can add the team calendar to Google Calendar, Apple Calendar, or Outlook:

```
https://autoboat-cloudflare-helper.<your-account>.workers.dev/calendar.ics
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
- `ALLOWED_ORIGIN` — **comma-separated allowlist** of public origins allowed
  to call this Worker. Default:
  `https://autoboat.aoe.vt.edu, https://www.autoboat.aoe.vt.edu`.
  The response echoes the caller's own `Origin` when it matches and omits
  `Access-Control-Allow-Origin` otherwise, which is what makes the browser
  block the response. Blank allows nothing; a lone `*` allows every origin
  (don't use it in production), and a `*` mixed into a longer list fails closed.

  Local development needs **no** entry here: `localhost`, `127.0.0.1`, and
  `[::1]` on any port are allowed automatically. That is deliberate — the
  hostname and port both vary, and enumerating them is how the calendar broke:
  `localhost` and `127.0.0.1` are *different origins* to CORS even though they
  reach the same dev server.

  WARNING: **`www.autoboat.aoe.vt.edu` must stay listed.** The www host serves the
  site rather than redirecting to the apex, so a visitor on the www URL is at a
  genuinely different origin. Omitting it made the calendar work at the apex and
  fail on www. A canonical tag pointing at the apex does not help — that is a
  crawler hint, not a browser redirect. `http://` variants need no entry; they
  301 to https before the app loads.

  WARNING: **If this list is missing an origin, the calendar shows "NetworkError
  when attempting to fetch resource."** — the Worker still returns 200, so it
  looks like an outage rather than a CORS rejection. The website now names the
  blocked origin in the error message, which is the fastest way to see which
  entry is missing.
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
- `DRIVE_GALLERY_FOLDER_ID` — id of the Drive folder whose images make up
  `/gallery`. See "Gallery: images from Google Drive".
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — the service account's `client_email`. Not a
  secret; it is the address the folder is shared with.

Set via `wrangler secret put` (secret, never committed):

- `DISCORD_BOT_TOKEN` — the Discord bot's token.
- `GOOGLE_PRIVATE_KEY` — the service account's PEM private key. Either literal
  newlines or `\n` escapes are accepted.
- `GALLERY_SYNC_TOKEN` — optional. Enables `POST /manage/gallery/sync` for CI or
  an operator. Unset disables the route (fail closed).

## Gallery: images from Google Drive

The `/gallery` page shows every image in one Google Drive folder. Drive is the
source of truth: drop a photo into the folder and it appears on the site, with
no code change and no redeploy.

### How it works

```
Drive folder  --(cron, every 5 min)-->  manifest (KV)  -->  GET /gallery
      |                                                          |
      +--------> R2 mirror  <---- GET /gallery/image/{id} --------+
```

Drive cannot serve the images directly. Its download URLs are rate-limited and
not meant for embedding, and its API quota is per-user, so a busy page would
start failing for everyone. The Worker therefore copies each image into an R2
bucket and serves it from there. Drive stays the archive; R2 is the delivery
mirror.

- A **cron trigger** (`triggers.crons` in `wrangler.jsonc`) lists the folder and
  copies any new images into R2. It copies at most `MAX_MIRRORS_PER_SYNC` per
  run, so a large initial import fills in over several runs instead of timing
  out.
- An **upload from the website** writes to Drive first, then mirrors
  immediately, so the photo is on the page without waiting for the cron.
- A **deleted** photo leaves the gallery and its bytes are swept from R2.
- Only images that are already mirrored are advertised, so the page never shows
  a broken tile.
- A **removed** photo is hidden from the page, not deleted. The "Remove from
  gallery" button in the lightbox flips a flag; the Drive file and the R2 copy
  are untouched, so it can be restored from the **Add photos** panel. See
  "Removing a photo" below.

WARNING: **Drive is never contacted while rendering the page.** A public page view reads the manifest from KV and the bytes from R2 only. Blocking a visitor on a Drive call would make load time depend on Google and would burn the Drive quota on ordinary traffic.

### Ordering the photos

By default the gallery is newest-first. A signed-in officer can change it by
**dragging a photo on the gallery grid itself** -- any photo, including the ones
built into the site -- and the change saves immediately.

NOTE: Drag is desktop-pointer-only. Native HTML5 drag does not fire on touch
devices, so reordering cannot be done from a phone today. There is no button
fallback (the panel list that used to provide one was removed as duplicate UI).

```bash
# Current order (visible photos only).
curl <worker-url>/manage/gallery/order -H "Authorization: Bearer <session>"

# Set it. The whole sequence, first photo most prominent. Keys are
# `drive:<id>` / `site:<path>`; a bare Drive id is accepted and normalized.
curl -X PUT <worker-url>/manage/gallery/order \
  -H "Authorization: Bearer <session>" -H "Content-Type: application/json" \
  -d '{"keys": ["drive:<driveId>", "drive:<driveId>"]}'
```

WARNING: **The order is stored on its own KV key (`gallery:order:v1`), not in the manifest.** The manifest is rebuilt from Drive every 5 minutes, so an order kept only there would revert to newest-first on the next cron run.

NOTE: A partial list is fine. Ids that no longer match a photo are ignored, and any photo not named keeps its default place *after* the ones that are -- so a new upload appears at the end and never displaces something you arranged. That is why you do not have to reorder after every upload.

NOTE: Hiding a photo does not change the order. A photo restored from the removed list reappears at the end of the custom order.

Uploads are converted to **WebP in the browser** before they are sent, so the
Drive copy and the R2 mirror are both WebP. The Worker cannot do this -- Workers
have no image encoder -- and the side benefit is a smaller upload from a phone.

NOTE: This means the file in Drive is the converted WebP, not the camera
original. Quality is set high (0.9) rather than size-first. Keep originals
elsewhere if the team needs a true archive.

### Removing a photo

An officer can take a photo off the public page without deleting it. Open the
photo, click **Remove from gallery**, and it disappears from `/gallery`. To put
it back, open **Add photos** and use **Restore** in the "Removed from the
gallery" list.

WARNING: **Nothing is deleted.** The Drive file and the mirrored bytes stay exactly as they are -- only the public list stops including the photo. This is deliberate: removing the wrong photo has to be undoable, and the Worker cannot recover a file deleted from Drive. To actually delete a photo, remove it in the Drive UI.

WARNING: **The hidden set is stored on its own KV key (`gallery:hidden:v1`), not just in the manifest.** The manifest is rebuilt from Drive on every sync, so a flag kept only there would be erased on the next run and every removed photo would reappear.

The endpoint is `PATCH /manage/gallery/{id}` with `{"hidden": true}` (or
`false` to restore), and `GET /manage/gallery/hidden` lists what is removed.

### Which Google account to use

Use **`autoboat@vt.edu`**, the Workspace account. Do **not** use a personal
`@gmail.com` address.

The reason is storage quota. A service account is a robot identity with **no
storage of its own**: it can read anything shared with it, but it cannot own a
file. Google's documentation states that service accounts "don't have storage
quota and can't own files. Instead they must upload files and folders into
shared drives, or use OAuth 2.0 to upload items on behalf of a human user."

Shared Drives require a Workspace edition, and Google states plainly that
"Personal Google Accounts (`@gmail.com`) cannot create shared drives." So the
folder must live in a Shared Drive owned by the VT domain, and the account that
creates it must be the Workspace one.

### Step 1: create the Shared Drive and folder

1. Sign in to Drive as `autoboat@vt.edu`.
2. In the left sidebar, choose **Shared drives**, then **New**.
3. Name it something like `AutoBoat Media`.
4. Inside it, create a folder for the gallery, for example `Gallery`.
5. Open the folder and copy the id from the URL:
   `https://drive.google.com/drive/folders/`**`THIS_PART`**
   That value is `DRIVE_GALLERY_FOLDER_ID`.

WARNING: **Subfolders are not traversed.** Only images directly inside this folder are published. That is deliberate: recursing would let an unrelated folder dragged into the tree publish itself by accident. If the team's photos are nested under subfolders, either flatten them or point the config at the folder that actually holds the images.

NOTE: If Shared Drives are unavailable on the VT Workspace plan, the fallback is a **service account with domain-wide delegation**, which requires a VT Workspace super-administrator to authorize the service account's client id in the Admin console. That is an institutional request, not something you can do yourself, so it is worth confirming the Shared Drive path first.

### Step 2: create the service account

You need a Google Cloud project. This is separate from the Drive account, and
any Google account can own it.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and
   create a project (for example `autoboat-gallery`).
2. Go to **APIs & Services > Library**, find **Google Drive API**, and click
   **Enable**.
3. Go to **IAM & Admin > Service Accounts** and click **Create service account**.
4. Name it (for example `gallery-sync`) and click **Create and continue**.
   No project-level IAM roles are needed - Drive access is granted by sharing
   the folder, not by IAM.
5. Click **Done**.
6. Open the service account, go to the **Keys** tab, choose
   **Add key > Create new key**, select **JSON**, and click **Create**.
   A `.json` file downloads. It is the only copy of the private key.

The JSON file contains the two values the Worker needs:

- `client_email` -> `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key` -> `GOOGLE_PRIVATE_KEY`

WARNING: **Never commit the JSON key file.** `GOOGLE_PRIVATE_KEY` is a secret and belongs in `wrangler secret put`. The downloaded file is a credential equivalent to a password for the service account.

### Step 3: share the folder with the service account

1. In Drive, open the gallery folder inside the Shared Drive.
2. Click **Share**.
3. Add the service account's `client_email`
   (`gallery-sync@<project>.iam.gserviceaccount.com`).
4. Give it **Content manager** (or **Contributor**).

**Content manager** is the right level: it can add files and see everything,
which is exactly what the Worker does. **Contributor** also works for uploads
but cannot move files into the trash, which the delete sweep needs.

WARNING: **External sharing must be allowed for the domain**, or the service account cannot be added to the Shared Drive. If the "Share" dialog refuses the address, a Workspace administrator has restricted sharing outside the organization. The same applies if the service account is added but reading returns 403.

### Step 4: create the R2 bucket

```bash
cd worker
npx wrangler r2 bucket create autoboat-gallery
```

The bucket name must match `bucket_name` under `r2_buckets` in
`wrangler.jsonc`.

### Step 5: set the configuration

In `wrangler.jsonc` (`vars`, public values only):

```jsonc
"DRIVE_GALLERY_FOLDER_ID": "<the folder id from step 1>",
"GOOGLE_SERVICE_ACCOUNT_EMAIL": "gallery-sync@<project>.iam.gserviceaccount.com"
```

Secrets:

```bash
cd worker
npx wrangler secret put GOOGLE_PRIVATE_KEY
# paste the private_key value, including the BEGIN/END lines
```

`GOOGLE_PRIVATE_KEY` accepts either literal newlines or `\n` escapes; both are
normalized. If you paste from the JSON file, the value between the quotes
already uses `\n` and can go in as-is.

### Step 6: verify

```bash
# Force a sync and read the counts back.
curl -X POST <worker-url>/manage/gallery/sync \
  -H "Authorization: Bearer <GALLERY_SYNC_TOKEN>"

# The public manifest (empty until the first sync finishes).
curl <worker-url>/gallery
```

Then open `/gallery` on the site. The first sync copies images a batch at a
time, so a large folder fills in over a few minutes.

### Officer sign-in from the gallery page

`/gallery/` is registered as its own Discord **redirect URI**, alongside
`/calendar/`. Both are listed, comma-separated, in `OAUTH_REDIRECT_URI`:

```
https://autoboat.aoe.vt.edu/calendar/, https://autoboat.aoe.vt.edu/gallery/
```

The Worker picks the entry whose **path** matches the page that started the
login, so an officer who clicks "Add photos" comes straight back to the gallery
with the panel open. It falls back to the first entry when nothing matches.

WARNING: **Every entry in `OAUTH_REDIRECT_URI` must also be registered in the Discord developer portal** (OAuth2 -> Redirects), char-for-char including the trailing slash. A URI listed in the Worker but missing from the portal makes Discord show an error page instead of redirecting, with no useful detail.

WARNING: **The redirect URI is SELECTED from the configured list, never built from request input.** Constructing one from a page path would make any path a redirect target. The same helper (`redirectUriFor`) supplies the value to both the authorize request and the token exchange, because Discord rejects the exchange with `invalid_grant` when the two disagree.

NOTE: The page to return to also travels inside the signed `state` (as `ret`), allowlisted to `/calendar/` and `/gallery/`. The redirect URI decides WHERE the browser lands; the state decides which page the Worker reports back, and the two are kept consistent so a tampered value cannot steer either.

### Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| `503 gallery not configured` | One of the three Drive values is missing. The response names which. |
| Sync says `Drive rejected the folder listing (404)` | The folder id is wrong, the folder is not in a Shared Drive, or the service account was not added to it. A Shared Drive folder returns 404 rather than 403 when access is missing. |
| Upload fails with a quota error | The folder is in a personal My Drive. The service account cannot own files there - move it to a Shared Drive. |
| Upload fails with `Invalid grant` or `invalid_scope` | `GOOGLE_PRIVATE_KEY` is malformed (a truncated paste, or missing BEGIN/END lines), or the Drive API is not enabled on the project. |
| Gallery is empty but the folder has images | Check the images are directly in the folder (not in subfolders) and are JPEG, PNG, WebP, GIF, or AVIF. HEIC is rejected because no browser can render it. |
| A photo is missing but the folder has it | The sync copies a bounded batch per run. Wait for the next cron tick, or force a sync. |
| `401 Invalid sync token` | `GALLERY_SYNC_TOKEN` is unset (the route is disabled) or the header does not match. |
| Discord shows an error page after clicking "Sign in" | The chosen entry in `OAUTH_REDIRECT_URI` is not registered in the developer portal. Add it under OAuth2 -> Redirects, exactly. |
| Sign-in succeeds but lands on the calendar | `/gallery/` is not in `OAUTH_REDIRECT_URI`, so the Worker fell back to the first entry. It must also be registered in the portal. |

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
2. **An event the audit log says was deleted is dropped.** `src/audit.ts` turns
   `GET .../audit-logs?action_type=102` into the deleted event ids, and
   `mergeArchive` removes exactly those -- so deleting an event takes it off the
   calendar rather than leaving it as history. This is the one exception to
   keep-everything, it is checked before the age rules, and it only drops an id
   that is absent from Discord's fresh list. It is best-effort: a failed audit
   read (or a bot without `VIEW_AUDIT_LOG`) yields an empty set, which restores
   the default keep-everything behavior.
   This covers the `.ics` feeds as well as the JSON routes, because all four
   call the same `loadEvents`; the merge happens once, before either route
   filters.
3. **Every other event that fell out of the list is kept** -- this is unbounded
   by default. It is deliberately unconditional, because the list endpoint drops
   an event for two reasons (it completed, or it was removed) and cannot tell
   them apart, so without an audit signal the archive keeps both.
   - an event that had **ended** is marked `completed`, so the calendar renders
     it as history;
   - an event that had **not ended** keeps its status, since marking it
     `completed` would claim a meeting happened that never did;
   - an already-`canceled` event keeps its status, which is styled differently.
4. **Malformed events are dropped** -- a record whose dates cannot be parsed
   can neither be reasoned about nor aged out.
5. **Nothing is dropped for being old** unless `RETENTION_DAYS` is set. The
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
