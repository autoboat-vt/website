---
description: "Use when working on the Cloudflare Worker in worker/ that serves Discord guild scheduled events: the /events, /officers/*, /calendar.ics and /audiences routes, KV caching and the retention archive, the KV write budget, audience gating by Discord channel, wrangler.jsonc vars and secrets, the ?channels= query, .ics serialization, rrule conversion, the in-description cancellation convention, and officer event creation/deletion over Discord OAuth. The month grid, modal, map, subteam picker and client-side expansion live in calendar.instructions.md."
applyTo: "worker/**, src/test/worker/**, src/components/EventCreator.tsx, src/lib/eventManage.ts, src/test/components/EventCreator.test.tsx"
---

# Discord events Worker (`worker/`)

This Cloudflare Worker proxies Discord's guild scheduled-events API so the static
site can render `/calendar` without exposing the bot token. Everything that talks
to Discord, caches, filters by audience, or serializes a feed lives here.

WARNING: This is a split of the old single `discord-events.instructions.md`. The
website half -- month grid, mobile branch, month-nav header, Subscribe panel,
Filter picker, subteam colors, `EventModal`, `EventMap`, and the client-side
`expandRecurrences`/`describeRecurrence` -- is in `calendar.instructions.md`. A
change that crosses the Worker boundary needs both files.

## Architecture

```
website (browser)                    calendar app (Google/Apple/Outlook)
    |  GET .../events  (PUBLIC only)      |  GET .../calendar.ics  (PUBLIC only)
    v                                    v
worker/ (Cloudflare Worker)  --- one KV cache, shared by all routes ---
    |  KV get  "events:v2"   <- { fetchedAt, events }: full set, all audiences
    |                           fresh while now - fetchedAt < CACHE_TTL_SECONDS
    |  KV put  "events:v2"   (on a STALE read) <- exactly ONE write per miss
    |                           NO expiry by default (retention unbounded)
    |  stale -> GET .../guilds/<id>/scheduled-events?with_user_count=true
    |           Authorization: Bot ${DISCORD_BOT_TOKEN}
    |           GET .../guilds/<id>/audit-logs?action_type=102   <- deleted event ids
    |  classify each event: channel_id === OFFICERS_CHANNEL_ID ? officer : public
    |  MERGE fresh over stored, drop ids the audit log says were deleted -> write
    v
Discord API

(separately, for diagnostics only, never cached)
    GET /audiences  -> GET .../guilds/<id>/channels
```

The channels endpoint is called by `GET /audiences` ONLY, and its result is not
cached. Classification is a plain id comparison, so the channel list is not
needed to decide visibility -- see "Write budget" below for why caching it was
actively harmful.

The Worker normalizes Discord's `GuildScheduledEvent` shape into a small
`CalendarEvent` record (`worker/src/events.ts`; the client-side declaration is in
`src/lib/discord.ts`), which is what the website consumes. The Worker owns:

- **Five routes**, in two audience families. Public: `GET /events` (JSON) and
  `GET /calendar.ics` (iCalendar). Officer: `GET /officers/events` and
  `GET /officers/calendar.ics`. Plus `GET /audiences` (diagnostics, see below).
  All four event routes call `loadEvents()` and then filter, so no two consumers
  can disagree about visibility. Trailing slashes are normalized, so `/events/`
  also works. Every event route also accepts an optional
  `?channels=<id>,<id>` subteam filter (see "Channel filter" below).
- CORS via a comma-separated `ALLOWED_ORIGIN` allowlist (default
  `https://autoboat.aoe.vt.edu, https://www.autoboat.aoe.vt.edu`). The response
  **echoes the caller's own `Origin`** when it matches and omits
  `Access-Control-Allow-Origin` otherwise. Loopback hosts (`localhost`,
  `127.0.0.1`, `[::1]`, any port) are allowed automatically and need no entry.
  WARNING: `www.` must stay listed -- the www host SERVES the site rather than
  redirecting to the apex, so it is a distinct origin; omitting it made the
  calendar work at the apex and fail on www. A missing origin is otherwise a
  silent failure where the Worker returns 200 and the page reports only a CORS
  block (the client names the blocked origin). Calendar clients are not browsers
  -- they ignore CORS entirely, so the `.ics` feed works regardless.
- KV caching. The value under `events:v2` is an ARCHIVE (`{ fetchedAt, events }`),
  not a bare array: the full set for all audiences, plus when it was fetched.
  Freshness is `now - fetchedAt < CACHE_TTL_SECONDS` (**180 s** in
  `wrangler.jsonc`, `parseTtlSeconds` fallback 180 s), and the key itself is
  written with **no `expirationTtl`** while retention is unbounded (see
  "Past-event retention"). KV writes are fire-and-forget via `ctx.waitUntil` so
  the response isn't blocked on them. JSON responses also send
  `Cache-Control: public, max-age=<TTL>` -- the client must fetch with
  `cache: "no-store"` or the browser cache defeats background polling.

### WARNING: CORS must ECHO the caller's Origin, not send a fixed one

`corsHeaders(env)` originally sent `env.ALLOWED_ORIGIN` VERBATIM regardless of who
asked. Browsers compare `Access-Control-Allow-Origin` against the origin they
sent; a fixed unrelated value can never match, so the browser DISCARDS a 200
response. Verified with `curl -H 'Origin: http://localhost:3000'` ->
`access-control-allow-origin: https://autoboat.aoe.vt.edu` (mismatch) while the
same request from the prod origin matched. The Worker returned **200 the whole
time** (`x-cache: HIT`, real events).

- Diagnostic signature: a failing CORS request never reaches `response.ok` /
  status-code logic in `fetchJson`, so it cannot fall into the `DiscordError(status)`
  branch -- it throws a bare `TypeError` first. "Server is up + browser says
  NetworkError" means suspect CORS, not the Worker.
- `resolveAllowedOrigin(config, requestOrigin)` matches the request's own `Origin`
  against the allowlist and returns it to echo, or `null` to OMIT the header.
  `Env.origin` is per-request scratch state set at the top of `fetch()` so the
  env-only response helpers pick it up.
- WARNING: **Do NOT build the per-request env with `{ ...env }`.** Cloudflare
  bindings put methods on the prototype, so a spread copy drops
  `EVENTS_KV.get`/`.put` and the cache silently dies. Mutate the env object
  (`env.origin = ...`).
- WARNING: **`Vary: Origin` must be sent even when ACAO is omitted**, or a shared
  cache serves an allowed caller's header-carrying response to a disallowed one.
- WARNING: `ALLOWED_ORIGIN` blank allows none; a **lone** `*` allows all; `*` mixed
  into a longer list **fails closed**. Enumerating dev origins was the wrong
  design -- `localhost` and `127.0.0.1` are different origins to CORS -- so
  loopback is matched by `LOCAL_DEV_ORIGIN_PATTERN`
  (`/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/`), anchored so it does
  not match lookalikes such as `localhost.evil.example`.

## Past-event retention (why the cache is an archive)

WARNING: **Discord's `GET /guilds/{id}/scheduled-events` returns ONLY `SCHEDULED`
and `ACTIVE` events.** `COMPLETED` and `CANCELED` are terminal, so an event
drops out of the API the moment it ends -- a voice/stage event completes a few
minutes after the last person leaves the channel, an external event at its
`scheduled_end_time`. A cache that mirrors that list forgets every meeting as
soon as it happens.

WARNING: **Nothing on the website filters past events, and nothing should.**
`publicEvents()` filters by audience only; `expandRecurrences()` clips only
*cancelled* series; the month grid renders any occurrence in the visible
window. If past events are missing, they were never in the payload. Do not
"fix" this client-side by widening the render window -- the data is gone by
then. A recurring event's base `scheduled_start_time` also rolls forward and is
used as `dtstart`, so past occurrences of a still-live series vanish too unless
the RRULE re-derives them.

WARNING: **Retention is UNBOUNDED: every event the Worker has ever seen is kept.**
The team asked to keep the whole history, so there is no default cutoff.
`RETENTION_DAYS` is an opt-in escape hatch for age-based pruning, not the
normal mode. Do not reintroduce an age default -- discarding history is
unrecoverable, and a retention window is not what makes past events work.

`worker/src/archive.ts` is the fix, and it is deliberately pure (no bindings,
no `fetch`, no KV) so the merge rules are unit-testable in
`src/test/worker/archive.test.ts`. On each refresh the fresh events are merged
OVER the stored ones:

1. **Fresh wins** -- an event still in Discord's list is taken verbatim (name,
   description, and start time can all change).
2. **An event the audit log says was deleted is dropped.** `worker/src/audit.ts`
   parses `GET /guilds/{id}/audit-logs?action_type=102`
   (`GUILD_SCHEDULED_EVENT_DELETE`) into the deleted event ids, and
   `mergeArchive` removes exactly those -- so deleting an event in Discord takes
   it off the calendar instead of leaving it behind as history. WARNING: This is
   the ONE exception to keep-everything, and it is checked BEFORE the retention
   rules. It only drops an id that is ABSENT from the fresh list, so a live
   event can never be raced out. The audit read is best-effort and adds no KV
   write: if it fails (or the bot lacks `VIEW_AUDIT_LOG`) the result is an empty
   set, which is the pre-deletion-signal behavior.
   WARNING: **The `/calendar.ics` feeds are covered by this too, and only
   because `handleGetIcs` and `handleGetEvents` share `loadEvents`.** The merge
   runs once, before either route filters, so `.ics` consumers get the same
   deletion -- `routes.test.ts` asserts it on both the public and officer feeds.
   Do not give `.ics` a cache path of its own: a deletion that reached the JSON
   payload but not the feed would leave the event in every subscriber's calendar
   indefinitely, since a calendar app keeps an event until its UID leaves the
   feed.
3. **Every other event that fell out of the list is kept.** This is
   unconditional on purpose: Discord drops an event from the list for exactly
   two reasons (it completed, or it was removed) and the LIST endpoint cannot
   tell them apart, so the archive keeps both when there is no audit signal.
   - an event that had **ended** is marked `completed` so the calendar renders
     it as history (`asArchived`);
   - an event that had **not ended** keeps its status -- marking it `completed`
     would claim a meeting happened that never did;
   - an already-`canceled` status is preserved, since it is styled differently.
4. **Malformed events are dropped** -- a record whose dates cannot be parsed can
   neither be reasoned about nor aged out, so it can never be pruned.
5. **Nothing is dropped for being old** unless `RETENTION_DAYS` is set. The
   result is still held under `MAX_ARCHIVED_EVENTS`, which is a **safety
   ceiling, not a policy** -- it exists only so an unbounded history cannot
   exceed what a single KV value can hold (25 MiB, and the archive is
   serialized on every write).

Merging keys on Discord's event id, so a recurring event -- present in every
payload under one stable id -- is never duplicated.

WARNING: **Freshness moved from KV's expiry into the stored `fetchedAt`.** The key
is written with **no `expirationTtl`** in the default unbounded mode, so a
plain "is the key present?" test would serve stale data forever. A miss is
`now - fetchedAt >= CACHE_TTL_SECONDS`, and it still costs exactly ONE write --
the write budget is unchanged. If `RETENTION_DAYS` IS set, the key expires on
that window (floored at 2x the cache TTL, capped at KV's 1-year max), so never
set it below the cache TTL.

WARNING: **Never give the key an expiry while retention is unbounded.** The failure
is silent and total: the history lapses, the next request archives only what
Discord still reports, and past events disappear again. `routes.test.ts`
asserts the write carries no `expirationTtl` in that mode.

WARNING: **`X-Cache` is now freshness-driven, not key-existence-driven.** Do not
revert it to "was there a KV value" -- with a non-expiring key that would
report HIT forever.

A legacy entry (a bare array, written before retention existed) is parsed as
infinitely stale by `parseCacheEntry`, so it is refetched and rewritten in the
new shape on first use rather than being dropped or served indefinitely.

Retention applies to the **full** set before audience filtering, so an archived
officer event survives on `/officers/*` and stays hidden on the public routes.

## Write budget (do not regress this)

WARNING: The account is on the Workers KV **FREE** tier: **1,000 writes/day** (reads
are 100,000 and are never the constraint). A cache MISS is what costs a write, so

```
writes/day = (86400 / TTL) * writes-per-miss-to-KV
```

This was hit in production. The original config used a 60 s TTL *and* wrote two
keys per miss (`events:v2` + a `channels:v1` cache the event path no longer
needed), giving ~2,880 writes/day -- roughly 3x the limit. It fails **badly**: a
rejected write means the entry never lands, so every subsequent request is also a
miss and keeps retrying, and the calendar renders empty until 00:00 UTC.

Two invariants keep it safe, both pinned by `routes.test.ts`:

1. **Exactly ONE KV write per cache miss**, always the same key. No second key on
   the event path -- if you need the channel list, fetch it in `/audiences` alone.
2. **`CACHE_TTL_SECONDS` stays >= 180.** At 180 s a continuously-active site costs
   480 writes/day (~2x headroom); the test reads the value off `wrangler.jsonc`
   and asserts it.

Raising the website's `EVENTS_POLL_INTERVAL_MS` does NOT reduce writes -- a warm
cache is pure reads. Only the TTL and the writes-per-miss do. Conversely, the
client poll is a read-side knob: lowering it cannot affect this budget.

Retention does NOT change this arithmetic either. `RETENTION_DAYS` makes each
stored value larger, not the writes more frequent -- that is precisely why
freshness moved into `fetchedAt` instead of being left to KV's expiry. A
separate archive key would double writes/day to ~960 and put the free tier over
budget. If more freshness is ever needed, the escalation is the **paid plan**
($5/mo), not a shorter TTL on the free tier.

## Audience gating (officer-only events)

The team restricts an event inside Discord by hosting it in a **voice channel only
the intended audience can see** -- one such channel per subteam, plus one for
officers. `worker/src/audience.ts` turns that into a website rule:

```
event.channel_id === OFFICERS_CHANNEL_ID ? "officer" : "public"
```

- WARNING: **The signal is the CHANNEL, NOT its category.** Every event voice channel --
  officer, subteam, and general member alike -- lives under ONE shared category, so
  the category is identical for every event and discriminates nothing. An earlier
  version classified by `channel.parent_id`, which under this layout gives the same
  answer for every event: useless, and actively harmful when set, since it would
  hide every subteam and member event while still leaking the officer ones. Do not
  reintroduce a category rule.
- WARNING: **`channel_id` is the only usable signal, NOT the location.** Discord
  requires `entity_metadata` to be `null` for `VOICE`/`STAGE_INSTANCE` events, so
  `CalendarEvent.location` is always null for exactly these events. (This is why
  the `Location:` line work is orthogonal -- it applies to `EXTERNAL` events,
  which have no channel.)
- **This is a better signal than a description marker** because it is the same
  mechanism that already restricts the event inside Discord: there is no second
  list of "officer events" to keep in sync, and an officer event needs no extra
  marker at all.
- **Exactly one officer channel is expected**, and everything else is public --
  the team's stated policy. **Config**: `OFFICERS_CHANNEL_ID` (wrangler var)
  falls back to `DEFAULT_OFFICERS_CHANNEL_ID` in `audience.ts` (the real channel,
  set 2026-09-22). Absent uses the default; **blank means "no officer channel"**
  and makes the Worker serve NOTHING rather than guess. This is the **only**
  audience setting. An earlier `PUBLIC_CATEGORY_IDS`/`DEFAULT_PUBLIC_CATEGORY_IDS`
  list was removed: with the officer channel the sole signal and everything else
  public by construction, a public allowlist was unreachable configuration -- it
  could not change any outcome, only mislead the next reader into thinking
  public/private was category-driven. Do not reintroduce one.
- WARNING: **Classification needs no channel list at all** -- it is a string
  comparison. Two consequences: a Discord hiccup on `GET /guilds/{id}/channels`
  can no longer degrade the filter (the old category rule leaked in that case), and
  a *second* officer channel would be public until its id replaced the configured
  one.
- WARNING: **The policy is fail-open** (the team's explicit choice: *"i want all subteam
  events and general member events to be public, just the officer events need to
  be hidden"*). Only the one officer channel is internal; everything else,
  including an unrecognised channel, is public. The consequence to remember: a
  *new officer channel is public until configured*. A fail-closed policy would
  invert that but would silently erase real events from the site whenever a
  channel went unregistered, which is the likelier day-to-day failure.
- WARNING: **Filtering happens BEFORE the KV write**, so a newly-hidden event can never
  be served from a warm cache that predates the change. Don't move the filter into
  the route handlers. When the config is *unconfigured*, the write is skipped
  entirely -- everything classifies as public in that state, and persisting that
  would poison the cache for a later, correctly-configured request.
- WARNING: **The KV cache stores the FULL set**, and each route filters in memory.
  Caching only the public subset would be smaller, but the officer routes would
  then miss every time and hit Discord on each request -- and Discord throttles the
  scheduled-events endpoint aggressively. Keep the full set.
- **`GET /audiences`** is the diagnostic: it reports `officersChannelId` and
  `configured`, lists every category, and lists every non-category channel with its
  id, name, parent category, and resolved audience -- so the real config can be
  verified without Discord UI archaeology. A wrong officer channel id fails open
  and is otherwise invisible. It exposes channel/category names (no event data, no
  secret), is `Cache-Control: no-store`, and **fetches the channel list live
  without caching it** (see "Write budget").
- WARNING: **Find the officer channel id with `worker/scripts/channel-audit.mjs`**
  (`cd worker && npm run channels`). It is read-only, takes the bot token from
  `DISCORD_BOT_TOKEN` or gitignored `.dev.vars` (never logs it), prints the channel
  tree with channel ids, marks the currently-configured channel, and warns when
  that id is not a channel in the guild or is not a voice/stage channel (either way
  no event would match it and officer events would leak). Handles 429 with retry
  and 401/403 with actionable messages. Use this BEFORE deploying rather than
  after; the failure mode is silent.
- WARNING: If the officer voice channel is **absent from that output**, the bot lacks
  `VIEW_CHANNEL` on it (an explicit `@everyone` deny overrides the bot's
  server-wide permission). Its events then never reach the Worker at all -- which
  means they are not published, but also that they cannot be classified, so treat
  it as a configuration fault rather than a safe state.
- WARNING: **The officer routes are NOT access-controlled.** They are unguessable
  addresses, not protected ones -- anyone with the URL can read them. This was an
  explicit product decision (no key, no login). The visible warning banner on
  `src/pages/Officers.tsx` was removed at the team's request (2026-09-22), so the
  page no longer states this; the Subscribe panel is the only remaining in-UI
  signal, and the likeliest leak is still an officer pasting the link without
  realizing it carries no auth. `Officers.test.tsx` guards the compensating
  invariant: the path must stay out of `Header.tsx` `NAV_LINKS`, `OtherPages.tsx`
  `FEATURE_PAGES`, and the README routes table.
- WARNING: **Two different `/officers` paths, and they are unrelated.** The *page* is
  `/calendar/officers` (nested under the public `/calendar`). The *Worker API
  routes* are `<worker-url>/officers/events` and `/officers/calendar.ics` -- an
  origin-level path on the Worker itself, independent of the site's routing.
  Renaming one is not a reason to rename the other, and neither implies the
  other is public.
- The bot needs `VIEW_CHANNEL` on every channel it classifies. The bot having
  broader visibility than members is safe *only* because this filter exists --
  without it, `GET /guilds/{id}/scheduled-events` returns officer events and the
  Worker publishes them. That is exactly what was happening before this change
  landed.
- WARNING: **The bot also needs `VIEW_AUDIT_LOG`** (guild-level, no channel
  scope) for deletion detection. Combined with `VIEW_CHANNEL` that is permission
  value **1152** (1024 + 128) in an invite URL. The trap: an invite URL sets
  permissions only on FIRST invite, so re-opening it for an already-present bot
  silently does nothing. Update the bot's auto-created **role** in Server
  Settings -> Roles instead. Without the permission the audit read 403s, the
  error is swallowed on purpose (a failed audit read must never blank the
  calendar), and the symptom is that deleting an event does NOT remove it.
  `worker/scripts/channel-audit.mjs` probes for this and reports it.

### Proving the audience filter actually filters

The filter fails **open** (a bug publishes officer events rather than throwing), so
tests are the only thing standing between a typo and a leak. Both halves are
regression-proven by temporarily reintroducing the defect:

- Gutting `publicEvents` to `return events` fails **2** tests.
- Making `audienceForChannel` always return `"public"` (ignoring the officer
  channel) fails **many** -- it is the single point every officer assertion runs
  through.

If you refactor either function, redo both probes. A green suite that would also
pass with the filter disabled is worthless here.

## Subscribable calendar (.ics feed)

Users can subscribe to the team calendar from Google Calendar / Apple Calendar /
Outlook. The feed is generated by the Worker, not the client: `worker/src/ics.ts`
(`buildCalendar`) serializes the same KV-cached events into a VCALENDAR document
served at `GET /calendar.ics` with `Content-Type: text/calendar; charset=utf-8`
and `Content-Disposition: inline`.

Key decisions in `worker/src/ics.ts`:

- **Recurring events ship as an RRULE, not as expanded occurrences.** Calendar
  clients (Google/Apple/Outlook) expand RRULEs natively, so one VEVENT per Discord
  event keeps the feed small and stable as occurrences roll forward. This is the
  opposite of the website's approach (`expandRecurrences`), which must materialize
  concrete occurrences for the month grid. Emit the RRULE only when it matches
  `/^FREQ=/i`; a malformed rule is dropped rather than risk the client rejecting
  the whole calendar.
- **Everything is UTC** (`20261001T190000Z`). Clients render it in the viewer's
  local timezone.
- **Zero-duration events get a one-hour `DTEND`.** RFC 5545 forbids
  `DTEND == DTSTART`, and Discord zero-duration announcements serialize that way
  without the guard (`DEFAULT_DURATION_MS`).
- **`UID` is `discord-<event.id>@autoboat.aoe.vt.edu`** so a client refreshing an
  existing subscription rewrites events in place instead of duplicating them.
  Recurring events keep one UID.
- **Line folding counts UTF-8 octets, not characters** (75-octet limit,
  continuation lines start with a space). A naive `slice(75)` splits multi-byte
  characters and corrupts the feed. `escapeText` handles `\`, `;`, `,`, and
  newlines; `URL` is emitted unescaped because it is a URI value type.
- `CALENDAR_NAME` var (default "AutoBoat at Virginia Tech") sets `X-WR-CALNAME`.
  `REFRESH-INTERVAL` / `X-PUBLISHED-TTL` advertise the KV TTL.
- Malformed events (unparseable `DTSTART`) are skipped individually so one bad
  record can't break the feed.

WARNING: There is deliberately **no Google Calendar or Outlook deep link**. Do not
re-add one:

- Google's classic `calendar/render?cid=<feedUrl>` handler is broken for external
  feeds. Google support staff confirmed the regression (thread 376167890, Sept
  2025) and told users to add via **Settings > Add calendar > From URL** instead;
  day-to-day reports of `cid=https://` returning "Unable to add calendar. Check
  the URL" continued through Nov 2025. The `calendar/r/settings/addbyurl` route is
  not a substitute either -- signed out, it 302s to the Workspace marketing page.
- Outlook's `addfromweb` endpoint is similarly unreliable.

Users of those apps are directed to the manual "Add calendar from URL" flow, with
the feed URL shown in the panel for copying. Verified with the live feed: it
returns 200 / `text/calendar; charset=utf-8` with 4 events and **zero RRULEs**, so
the feed itself is not the cause (RRULE is a known-but-inapplicable Google trigger
here).

Real subscriptions only work against the **deployed** Worker URL -- `wrangler dev`
is local-only, so a calendar app on another machine can't reach it.

## Channel filter (`?channels=`)

The Worker-side half of the Filter control. The picker UI, the scope rule, and the
`null`-vs-empty-set selection type are in `calendar.instructions.md`; this is the
query half.

`worker/src/index.ts` exports `parseChannelFilter(url.searchParams)` and
`filterByChannels(events, ids)`. Both are exported and unit-tested directly.

- `?channels=<id>,<id>` on **any** event route (JSON and `.ics`, public and
  officer), comma-separated; a repeated parameter is merged too.
- WARNING: **An absent, blank, or unparseable filter means "everything", never
  "nothing".** A malformed query must never be able to blank someone's
  subscription, so `filterByChannels` returns the input array unchanged for an
  empty set.
- WARNING: **An event with `channelId === null` never matches a non-empty
  filter.** There is no channel to compare, and including it in every filtered
  view would make the "Other" checkbox a lie.
- WARNING: **Filtering costs no extra KV writes.** It runs AFTER the audience
  filter and is never given to `loadEvents` -- the cached value is always the
  full set, so any filter reuses the one-write-per-miss path. Do not move it
  into the cache: a per-filter key would multiply writes/day against the free
  tier and blank the calendar. `channel-filter.test.ts` pins this.
- The audience filter runs FIRST, so `?channels=<officer-channel>` on the
  public route yields nothing -- the query cannot be used to reveal officer
  events.

## Recurrence expansion (Discord object -> RRULE)

`worker/src/events.ts` normalizes Discord's raw payloads into the `CalendarEvent`
shape both formats consume (`toCalendarEvent` / `normalizeEvents`). It is
deliberately pure -- no bindings, no `fetch`, no KV -- so the raw-payload -> feed
path is unit-testable without Cloudflare's ambient types; `index.ts` owns the
HTTP/KV/caching concerns and imports the types from here.

WARNING: Discord's `recurrence_rule` is a **structured object**, NOT a
pre-serialized RRULE string:

```
{ start, end?, frequency, interval, by_weekday?, by_n_weekday?, by_month?, by_month_day? }
```

`worker/src/recurrence.ts` (`formatRecurrenceRule`) converts it into an RFC 5545
RRULE *body* (no leading `RRULE:`) once, at the Worker boundary, so the website
(`expandRecurrences`, which prepends `RRULE:` and calls `rrulestr` with the
event's base `scheduled_start_time`) and the `.ics` feed share one conversion and
cannot drift apart. The client's `CalendarEvent.recurrenceRule` is that
already-converted string.

This was previously implemented as `typeof e.recurrence_rule === "string"`, which
silently produced `null` for every event (Discord's object is not a string), so
`isRecurring` was always `false` and the `.ics` feed never emitted an `RRULE`. Do
not revert to reading the raw Discord field as a string.

An unknown `frequency` or a non-positive `interval` rejects the whole rule (returns
`null`); out-of-range values inside an otherwise valid rule (a `by_weekday` of `9`,
`by_month` of `13`) are dropped individually. `by_weekday` wins if both by-day
fields are present. `by_year_day` and `count` are never read -- Discord documents
them as not settable by clients, so they don't appear in API responses.

WARNING: `rule.end` (Discord's "ending time of the recurrence interval") becomes
**`UNTIL`**, emitted last because it must terminate the rule. The `end` field was
previously declared on the interface but never read, so every series was treated
as **infinite** -- the month grid rendered occurrences forever and the feed
published a never-terminating `RRULE`. An unparseable `end` is dropped (an
unbounded rule beats a malformed `UNTIL` that makes a client reject the whole
RRULE). `UNTIL` is formatted as a UTC date-time (`20261103T190000Z`), which RFC
5545 requires when `DTSTART` is UTC -- and it always is here, since `ics.ts`
serializes everything in UTC.

NOTE: Discord's docs mark `end` as "cannot be set externally currently" -- meaning
clients cannot set it. **Verified against the live API on 2026-09-22: Discord sends
`"end": null` for every recurring event in the guild.** Every other optional rule
field is likewise present-but-null (`by_n_weekday`, `by_month`, `by_month_day`,
`by_year_day`, `count`), so this is explicit null, not omission. The practical
consequence: the `UNTIL` branch is **correct but currently unreachable** --
`formatUntil` returns null and rules publish unbounded, which is why the live
payload shows `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU` with no `UNTIL`. Keep the branch
(it is correct if Discord ever populates `end`, and it is covered by tests), but
do not expect it to fire today.

WARNING: **`recurrence_rule.start` can disagree with `scheduled_start_time`, and we
currently ignore it.** Verified live on 2026-09-22: the "Software Team Meeting"
event had `scheduled_start_time = 2026-09-27T17:30:00Z` while its
`recurrence_rule.start = 2026-09-20T17:30:00Z` -- Discord had already advanced the
event's start to the next un-elapsed occurrence, while the rule still described the
true series origin. `recurrence.ts` does not carry `start` through to the RRULE
body, so the client feeds `scheduled_start_time` into `rrulestr` as `dtstart`.
Measured effect on that event over a 2026-09-01..10-15 window: **dtstart=09-27
yields 3 occurrences (09-27, 10-04, 10-11); dtstart=09-20 yields 4 (adding
09-20).** The earlier occurrence is silently dropped. The `.ics` feed is unaffected
for the same reason (clients anchor on `DTSTART`, so they simply never generate the
earlier one). This is a real but low-severity data-loss-at-the-margin bug: it only
bites for rules whose `INTERVAL`/`BYDAY` filter does not re-derive the dropped
date, and only for series that started before the current period. Fixing it means
threading `rule.start` into the payload and using it as `dtstart`, which changes
the expanded set -- do that deliberately, with tests, not incidentally. NOTE:
`General Body Meeting` had the two fields agreeing (`2026-09-29` both), so the
disagreement is not universal -- and an aligned `rule.start` coincides exactly with
`scheduled_start_time`, suggesting `scheduled_start_time` marks the *next*
occurrence while `rule.start` marks the series origin.

Discord's RRULE subset (as of API v10 / 2026) is:

- `frequency`: YEARLY(0), MONTHLY(1), WEEKLY(2), DAILY(3).
- `interval`: 1 (every N) or 2 (every other week, weekly only).
- `by_weekday`: weekly, max length 1; `0=Mon..6=Sun`. Maps to RFC `BYDAY=MO|TU|WE|TH|FR|SA|SU`.
- `by_n_weekday`: monthly Nth-weekday (e.g. `{n:4, day:2}` == "4th Wednesday" == `BYDAY=WE;BYSETPOS=4`).
- `by_month` + `by_month_day`: yearly.

NOTE: the docs page contradicts itself -- the `by_weekday` prose says "DAILY (0) or
WEEKLY (1)" while the enum table AND all four worked examples say DAILY=3,
WEEKLY=2. Trust the table/examples.

The `rrule` package handles the full RFC 5545 grammar, so all of the above variants
work transparently.

## Cancelled events (in-description convention)

Discord has **no per-occurrence exception mechanism**. The recurrence rule object
has no `EXDATE`-equivalent field (its fields are exactly `start`, `end`,
`frequency`, `interval`, `by_weekday`, `by_n_weekday`, `by_month`, `by_month_day`,
`by_year_day`, `count`), so "cancel one occurrence in a series, keep the rest"
cannot be sent through the API. `PATCH`/`DELETE
/guilds/{id}/scheduled-events/{id}` take whole-event ids, and the occurrences of a
series are not separate resources.

**The team's workaround is an in-description convention**, parsed by
`worker/src/cancellations.ts`:

```
Location: **Lavery Hall 335**
Cancelled: October 11th 2026
```

This is the ONLY way a single occurrence can be cancelled, so it is load-bearing --
keep the parser and both consumers in sync:

- **Label** matched: `Cancelled` / `Canceled` / `Skipped` / `No meeting`,
  case-insensitive, followed by `:`, `-`, or an en/em dash. The label is required
  on purpose: without it, ordinary prose ("We cancelled the October 11th launch,
  new date TBD") would be parsed as a cancellation. The same `LABEL_RE` drives
  both the parser and `stripCancelledNote`, so the two can never disagree about
  what counts as a note.
- **Date forms**: `October 11th 2026`, `Oct 11, 2026`, `September 3rd` (year
  omitted), or ISO `2026-10-11`. The year defaults to the **event's own start
  year**, not today -- parsing is deterministic and a past-year series still
  parses.
- **Lists on one line**: the team writes several dates in a single note, mixing a
  bare year with a comma-before-year across items:

  ```
  Cancelled: October 11th 2026, November 3rd, 2026
  ```

  Separators are not parsed specially -- the month-name and ISO patterns are
  simply matched globally across the line, so commas, semicolons, and `and` all
  work, as does mixing month-name and ISO forms in one list. A year applies only
  to the item it trails; later items without one fall back to the reference year.
  Duplicates are collapsed, so repeating a date across items or lines is harmless.
- **Validation**: impossible dates (Feb 30, month 13, non-leap Feb 29) are dropped
  individually rather than failing the whole line. Malformed input never throws; a
  bad note must not take down the calendar.
- Output is deduplicated and sorted, so it is stable to assert on.

**The note line is stripped from the description** (`stripCancelledNote`) before it
reaches the modal. The dates are surfaced as chips on the calendar, so leaving the
raw line in would render the convention verbatim to visitors and show the same
information twice. `LABEL_RE` is shared with the parser so a line can never be
parsed as a cancellation yet still displayed. Only labelled lines are removed --
prose that merely mentions a cancelled date survives intact. Blank-line runs left
behind are collapsed; when the note was the only content the description becomes
`null`.

WARNING: `EXDATE` reuses the **event's own `DTSTART` time-of-day**, not midnight.
RFC 5545 clients match `EXDATE` against `DTSTART` by value, so a midnight
timestamp would fail to exclude an evening meeting. `toExdateValue(isoDate,
event.start)` is the only correct way to build the value.

WARNING: `toExdateValue` must validate with `Number.isInteger`, not
`undefined`/truthiness checks. `"not-a-date".split("-").map(Number)` is
`[NaN, NaN, NaN]` -- destructured as `NaN`, which passes an `undefined` check and
emits the corrupt literal `NaNNaNNaNT193000Z` straight into the feed. There is a
regression test for exactly this.

**Whole-series cancellation** (`status: "canceled"`) is handled differently by each
consumer, deliberately:

- **`.ics` feed (`ics.ts`)**: the event is kept, serialized as `STATUS:CANCELLED`,
  and **keeps its RRULE**. A subscriber sees the whole series marked cancelled
  rather than it silently vanishing. Do not "fix" this into a drop or an RRULE
  strip -- both are worse for a subscriber than a visibly-cancelled event.
- **Website (`expandRecurrences`)**: clipped at `now`, so later occurrences are
  never generated. See `calendar.instructions.md` for the client-side behaviour
  and the styling.

The per-occurrence consumer split (the JSON route emits `cancelledDates`, the
website renders the occurrence flagged, the feed omits it via `EXDATE`) is
documented in `calendar.instructions.md` under "Client-side recurrence expansion".

## Creating events from the website (officers only)

Officers can add events without opening Discord. The `Add event` control
(`src/components/EventCreator.tsx`) walks them through a Discord OAuth2
authorization-code grant; the Worker exchanges the code and mints its own
session token.

```
GET  /manage/auth/url      -> { url }   (Discord authorize URL + signed state)
POST /manage/auth/callback -> { token, name, expiresIn }  (code + state)
GET  /manage/session       -> { name, canCreateEvents }   (bearer token)
POST /manage/events        -> { event, officerOnly }      (bearer token)
DELETE /manage/events/{id} -> { ok }                      (bearer token)
```

- WARNING: **The gate is `worker/src/permissions.ts` and it is the ONLY gate.** Events
  are created with the BOT's token, which holds `MANAGE_EVENTS`, so Discord
  enforces the *bot's* permissions and will create an event for any caller that
  reaches `POST /manage/events`. The Worker therefore checks
  `GET /users/@me/guilds` for `MANAGE_EVENTS` / `ADMINISTRATOR` / guild ownership
  and puts the decision in a **signed** token (`canCreateEvents`).
- WARNING: **`CREATE_EVENTS` is deliberately NOT accepted.** Ordinary members hold it,
  so honoring that bit would let anyone in the server publish events, including
  into the officer channel. This was an explicit product decision: only officers
  add to the calendar.
- WARNING: **Sessions are bearer tokens in `localStorage`, not cookies.** The site is
  `autoboat.aoe.vt.edu` and the Worker is `*.workers.dev`, so a Worker-set cookie
  is third-party and blocked by Safari. `localStorage` is a deliberate trade:
  it is XSS-readable, but the token only grants "manage events for 2 hours" --
  it is not a Discord credential.
- WARNING: **The Discord user access token is never returned or stored.** It is used
  for exactly two reads (`/users/@me`, `/users/@me/guilds`) and discarded. The
  client secret must never reach the browser, which is why the code exchange is
  server-side rather than implicit/PKCE.
- **Stateless tokens** keep login at zero KV writes. The permission claim is
  point-in-time, so a demotion takes effect within `SESSION_TTL_SECONDS`
  (2 hours). Do not lengthen it without deciding how much staleness is OK.
- The `state` is a signed nonce with a `purpose: "oauth-state"` marker and a
  10-minute TTL. The purpose check is load-bearing: without it a long-lived
  session token could be replayed as a login state, since both share the key.
- WARNING: **A successful create writes the KV archive directly.** Otherwise the new
  event is invisible for up to `CACHE_TTL_SECONDS`, which reads as "the form is
  broken". This is an operator-initiated write, not a cache miss, so the read
  path's one-write-per-miss invariant is untouched.
- `worker/src/eventCreate.ts` owns validation and the Discord payload shape,
  including the `end`/`count` prohibition (Discord cannot accept them from an
  application), the weekly "one weekday" rule, and the EXTERNAL branch (no
  channel, needs `entity_metadata.location` AND `scheduled_end_time`).
- A physical location is written into the description as a `Location:` line,
  because that is the only form `extractLocationFromDescription` accepts.
  Without it a created event would show no venue on the site.
- **Deleting is allowed from the site too**, through
  `DELETE /manage/events/{id}` (`worker/src/index.ts` `handleDeleteEvent`). WARNING:
  It reuses the session's `canCreateEvents` claim rather than adding a separate
  `canDeleteEvents` flag -- "may manage the calendar" is one decision, and two
  flags would drift. The DELETE goes through `discordDeleteAsBot`, so as with
  creation the session claim is the ONLY gate: the bot holds `MANAGE_EVENTS` and
  Discord will not refuse it.
- WARNING: **The delete path removes the id from the KV archive directly** instead
  of waiting for audit-log detection. The audit path is best-effort and may 403
  (no `VIEW_AUDIT_LOG`) or lag, and a delete the user just performed must take
  effect immediately. The audit path remains the backstop for deletions made in
  the Discord client. The archive write keeps the stored `fetchedAt`, so a delete
  does not extend the cache's freshness; a cold cache is left cold.
- WARNING: **The event id is matched by `resolveRoute`, not by the exact-match
  `ROUTES` table**, and only a 15-20 digit snowflake resolves. That keeps
  `/manage/events/admin` a 404 (not a 405, which would imply the path is real) and
  stops a crafted suffix from adding segments to the upstream Discord URL.
- WARNING: **A slug-keyed `RouteEntry` kind must be added to BOTH the union and the
  dispatch `switch`.** The switch's `default` is `handleCreateEvent`, so a new kind
  that is absent from the switch silently becomes a create request.
- WARNING: **A refused sign-in is explained, not just rejected.** The Worker returns a
  structured `reason` (`not-a-member` or `missing-role`) plus `account` and
  `guildName`, and `ManageError.remedy` in `src/lib/eventManage.ts` turns it into a
  sentence naming the refused Discord account and the server it should belong to.
  The usual cause is a second, personal Discord account, so `not-a-member` offers
  "sign in with a different account" while `missing-role` does not -- a re-login
  cannot grant a role. Do not collapse the two reasons into one message.
- Editing stays in Discord (Discord's `PATCH` has no UI here yet). Deletion is the
  one write that now has two legitimate entry points, and both converge on the
  same archive, so the calendar cannot disagree with itself.
- The modal's delete affordance renders only when a session exists and requires a
  confirmation click (see `calendar.instructions.md`).

## No-webhook constraint

Discord incoming webhooks are POST-only on a channel -- they cannot *pull* guild
events. Discord's "outgoing" Webhook Events (push to your app over HTTP) do not
include any `GUILD_SCHEDULED_EVENT_*` types in their event list. Scheduled-event
create/update/delete events only exist on the Gateway (persistent bot WebSocket
connection), which requires an always-on process. The Worker + KV approach is the
smallest server-side surface that works for a read-only calendar.

## Worker env configuration

`worker/wrangler.jsonc` holds public config as `vars`:

- `DISCORD_GUILD_ID` -- public, not a secret.
- `ALLOWED_ORIGIN` -- comma-separated allowlist of PUBLIC origins. Blank allows
  none; a lone `*` allows every origin (never in production); a `*` mixed into a
  longer list fails closed. Loopback hosts are allowed automatically at any port,
  so no dev entry is needed. WARNING: keep `https://www.autoboat.aoe.vt.edu`
  listed -- the www host serves the site, so it is a distinct origin.
- `OFFICERS_CHANNEL_ID` -- the one officer voice channel; see "Audience gating".
  Absent uses `DEFAULT_OFFICERS_CHANNEL_ID`; blank means "no officer channel" and
  makes the Worker serve nothing.
- `CACHE_TTL_SECONDS` -- how long a cached payload stays fresh, `180` in production
  config (`parseTtlSeconds` falls back to `180` for unparseable/missing values).
  Do NOT lower it to "refresh faster": on the KV free tier this value is a hard
  write budget, not just a freshness knob (see "Write budget"). Keep the website's
  `EVENTS_POLL_INTERVAL_MS` in sync with this. Also advertised in the `.ics` as
  `REFRESH-INTERVAL`/`X-PUBLISHED-TTL`.
- `RETENTION_DAYS` -- **optional**, unset by default, which keeps **every** event
  forever (see "Past-event retention"). Setting it opts into age-based pruning,
  the safety valve if the archive ever grows too large. Does NOT affect the write
  budget: the miss rate is set by `CACHE_TTL_SECONDS` alone, and a longer window
  only makes each stored value larger (bounded by `MAX_ARCHIVED_EVENTS` in
  `archive.ts`). A malformed value keeps everything rather than falling back to a
  cutoff, since discarding history is unrecoverable.
- `CALENDAR_NAME` -- optional; display name for the `.ics` feed (`X-WR-CALNAME`).
  Defaults to "AutoBoat at Virginia Tech".
- `DISCORD_CLIENT_ID` / `OAUTH_REDIRECT_URI` -- the officer OAuth app; see
  `worker/README.md` "Creating events from the website".

Secrets (never committed) go in via `wrangler secret put`:

- `DISCORD_BOT_TOKEN` -- the Discord bot's token.
- `DISCORD_CLIENT_SECRET` -- the OAuth app's client secret.
- `SESSION_SECRET` -- signs the stateless session and OAuth-state tokens.

For local `wrangler dev`, drop a `.dev.vars` file in `worker/` (gitignored). See
`worker/README.md` for the full one-time setup.

NOTE: redeploying does NOT disturb the secrets -- Cloudflare secrets survive
`wrangler deploy`; they are lost only if the Worker is deleted or recreated.

## Tests

- `src/test/worker/routes.test.ts` -- drives the real Worker `fetch` handler (needs
  the `@jest-environment node` docblock: jsdom has no global `Request`/`Response`).
  Covers the route table, `X-Cache` freshness semantics, the KV write budget
  (one write per miss on the same key, zero on a hit, and a test that reads
  `CACHE_TTL_SECONDS` off `wrangler.jsonc` and fails below 180), the no-expiry
  archive write, CORS (`resolveAllowedOrigin` unit table plus echo/omit/Vary at the
  response level), and deletion propagation to both the JSON and the `.ics` routes.
- `src/test/worker/archive.test.ts` -- `mergeArchive` / `parseCacheEntry` /
  `isFresh`: fresh-wins-by-id, keep-everything, the completed-vs-not-ended status
  rewrite, `canceled` preservation, the audit-deletion exception, legacy bare-array
  entries, and the `MAX_ARCHIVED_EVENTS` ceiling.
- `src/test/worker/audit.test.ts` -- audit-log parsing (type 102 -> deleted ids),
  plus the malformed/empty cases that must yield an empty set rather than throw.
- `src/test/worker/audience.test.ts` -- `parseChannelIds` (comma/whitespace/
  trailing-comma/JSONC-indentation forms, and that empty-ish input gives `[]`),
  `audienceConfigFromEnv` (the committed default, that a **blank**
  `OFFICERS_CHANNEL_ID` means "no officer channel" rather than falling back to the
  default, and first-id-wins), the default id's snowflake shape,
  `audienceForChannel` (officer for the configured channel, public for
  subteam/general/no-parent/unknown/null, that a channel merely *containing* the
  id is not officer, and that an **empty channel list still hides officer
  events**), `isOfficerEvent`, `listChannels`, and `listCategories`.
- `src/test/worker/audience-filter.test.ts` -- the classification seam through
  `normalizeEvents`: that `channel_id` survives normalization (dropping it would
  silently make everything public), officer vs public per channel, each event
  classified independently within one payload, `channelId` + `audience` in the
  full normalized shape, that classification composes correctly with cancellation
  parsing and recurrence conversion, and `publicEvents` (drops officer, keeps
  order, all-officer -> empty).
- `src/test/worker/channel-filter.test.ts` -- `parseChannelFilter` /
  `filterByChannels`, including that an empty filter returns the array unchanged
  and that filtering costs no KV writes.
- `src/test/worker/ics.test.ts` -- the ICS serializer: VCALENDAR envelope + CRLF
  endings, UTC/tz-offset timestamps, stable UIDs, zero-duration and null-end
  defaults, `STATUS:CANCELLED`, TEXT escaping, octet-based line folding (including
  multi-byte characters), RRULE passthrough + malformed-rule rejection, and
  unparseable-date skipping.
- `src/test/worker/recurrence.test.ts` -- `formatRecurrenceRule`:
  weekly/daily/monthly-Nth-weekday/yearly conversion, every frequency code,
  null/unknown-frequency rejection, non-positive `interval` handling, out-of-range
  `by_weekday`/`by_month`/`by_month_day` dropping, `by_weekday`-over-`by_n_weekday`
  precedence, `UNTIL` from the rule's `end`, and a round-trip asserting the emitted
  body expands correctly through `rrulestr`.
- `src/test/worker/events.test.ts` -- the **integration** suite: raw Discord
  payloads (documented snake_case shapes, numeric status/frequency, nested
  `entity_metadata`) -> `normalizeEvents` -> `buildCalendar` -> asserted RFC 5545
  output, plus an `rrulestr` expansion. This is the only suite that exercises the
  seam between normalization and serialization; the two suites above test their
  units in isolation and cannot observe a break in between. It guards the original
  bug directly; **verified by temporarily reintroducing the defect and confirming
  5 of its 9 tests fail**, then restoring the fix. It also covers the cancellation
  convention end-to-end (description -> `excludedDates` -> `EXDATE`), including
  that the EXDATE actually collides with a generated occurrence rather than merely
  appearing.
- `src/test/worker/cancellations.test.ts` -- `parseCancelledDates` (the documented
  example, every label variant, multi-date/multi-line/dedup/sort, the mixed
  comma-before-year list style, year resolution and explicit-year precedence, and
  the malformed cases: null input, unlabelled prose, `TBD`, Feb 30, month 13, day
  32, non-leap Feb 29, non-month words), `stripCancelledNote`, and `toExdateValue`
  (time-of-day borrowed from `DTSTART`, sub-second truncation, midnight fallback,
  and the `NaNNaNNaN` malformed-date regression).
- `src/test/worker/session.test.ts` -- the stateless HMAC session + signed payloads:
  sign/verify round-trip, rejection of a wrong secret, a tampered payload, an
  expired token (and validity right up to expiry), fail-closed when no secret is
  configured, malformed/non-base64 tokens, a token missing `canCreateEvents`
  defaulting to false, `bearerToken` parsing, and that the OAuth-state TTL is
  short. NOTE: the purpose-marker replay guard (`purpose !== "oauth-state"`) lives
  in `oauth.ts` and is asserted in `eventCreate.routes.test.ts`, not here.
- `src/test/worker/permissions.test.ts` -- `parsePermissions` (decimal bitfield
  strings, values beyond `MAX_SAFE_INTEGER`, JSON numbers) and `canCreateEvents`
  (accepts `MANAGE_EVENTS`, accepts `ADMINISTRATOR` and guild ownership, and
  refuses a member holding only `CREATE_EVENTS`).
- `src/test/worker/eventCreate.test.ts` -- create-event validation -> Discord
  payload: the `end`/`count` prohibition, the weekly one-weekday rule, the EXTERNAL
  branch, and the `Location:` line written into the description.
- `src/test/worker/eventCreate.routes.test.ts` -- the `/manage/*` route surface,
  including `DELETE` authorization and the archive write, and that an
  unauthenticated or non-officer request never reaches Discord.

WARNING: Worker tests import `worker/src/*` by **relative path**
(e.g. `../../../worker/src/ics`) because Jest's `testMatch` only matches files under
`src/`. The test file itself must live under `src/test/worker/`; the imported
source can be anywhere. All of these need `@jest-environment node` when they touch
`Request`/`Response`.

WARNING: **Test-fixture trap.** Hard-coding old date literals (e.g. 2020) in
retention tests makes them pass for the WRONG reason (dropped by age rather than
exercised). Use dates relative to `Date.now()`, and seed the STORED side as a
normalized `CalendarEvent`, not a raw Discord payload.

WARNING: When adding a year test to the cancellations suite, the **written year must
differ from the reference year**. An earlier version used `referenceYear=2026` with
`2026` written explicitly, so a silently-dropped year was undetectable -- removing
the `,?` from `MONTH_DAY_RE` still passed all 78 tests. Always make the parsed value
distinguishable from the fallback.

WARNING: Jest's default cache directory resolves under `.vscode/tmp` in this
environment, which the terminal sandbox blocks. Run
`npx jest --cache-directory "$TMPDIR/jest-cache"` instead.
