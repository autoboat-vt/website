---
description: "Use when working on the calendar page, the Discord events client, the subscription affordance, officer-only event visibility, or the Cloudflare Worker that serves Discord guild scheduled events. Covers the no-webhook constraint, the Worker architecture, KV caching, VITE_EVENTS_URL, audience gating via Discord categories, the /calendar.ics feed, and rrule recurrence expansion."
applyTo: "src/lib/discord.ts, src/pages/Calendar.tsx, src/pages/Officers.tsx, src/components/CalendarSubscribe.tsx, src/test/lib/discord.test.ts, src/test/pages/Calendar.test.tsx, src/test/pages/Officers.test.tsx, src/test/components/CalendarSubscribe.test.tsx, src/test/worker/ics.test.ts, src/test/worker/recurrence.test.ts, src/test/worker/events.test.ts, src/test/worker/cancellations.test.ts, src/test/worker/audience.test.ts, src/test/worker/audience-filter.test.ts, worker/**"
---

# Discord events + calendar

The `/calendar` page on the website displays Discord guild scheduled events as a month-grid calendar. Because the site is fully static, the page cannot hold the Discord bot token itself -- a small Cloudflare Worker in `worker/` proxies the API server-side.

## Architecture

```
website (browser)                    calendar app (Google/Apple/Outlook)
    |  GET .../events  (PUBLIC only)      |  GET .../calendar.ics  (PUBLIC only)
    v                                    v
worker/ (Cloudflare Worker)  --- one KV cache per resource, shared by all routes ---
    |  KV get "events:v2"   (60 s TTL)      <- full set, all audiences
    |  KV get "channels:v1" (60 s TTL)      <- diagnostics only (/audiences)
    |  miss -> GET .../guilds/<id>/scheduled-events?with_user_count=true
    |          GET .../guilds/<id>/channels
    |           Authorization: Bot ${DISCORD_BOT_TOKEN}
    |  classify each event: channel_id === OFFICERS_CHANNEL_ID ? officer : public
    v
Discord API
```

The channels resource is still fetched and cached, but **classification no longer
uses it** -- it is a plain id comparison. It is kept for `GET /audiences`, which
is how an operator verifies the configured channel against the real guild.

The Worker normalizes Discord's `GuildScheduledEvent` shape into a small `CalendarEvent` record (`src/lib/discord.ts`), which is what the website consumes. The Worker owns:

- **Five routes**, in two audience families. Public: `GET /events` (JSON) and `GET /calendar.ics` (iCalendar). Officer: `GET /officers/events` and `GET /officers/calendar.ics`. Plus `GET /audiences` (diagnostics, see below). All four event routes call `loadEvents()` and then filter, so no two consumers can disagree about visibility. Trailing slashes are normalized, so `/events/` also works.
- CORS (locked to `https://autoboat.aoe.vt.edu` via `ALLOWED_ORIGIN` var). Calendar clients are not browsers -- they ignore CORS entirely, so the `.ics` feed works regardless of the origin lockdown.
- KV caching (TTL from `CACHE_TTL_SECONDS` var, 60 s in `wrangler.jsonc`, `parseTtlSeconds` fallback 300 s). KV writes are fire-and-forget via `ctx.waitUntil` so the response isn't blocked on them. JSON responses also send `Cache-Control: public, max-age=<TTL>` -- the client must fetch with `cache: "no-store"` or the browser cache defeats background polling.
- Pre-mapping Discord's numeric status/entity_type codes to lowercase strings (`scheduled | active | completed | canceled`).

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
  the `Location:` line work in `discord.ts` is orthogonal -- it applies to
  `EXTERNAL` events, which have no channel.)
- **This is a better signal than a description marker** because it is the same
  mechanism that already restricts the event inside Discord: there is no second
  list of "officer events" to keep in sync, and an officer event needs no extra
  marker at all.
- **Exactly one officer channel is expected**, and everything else is public --
  the team's stated policy. **Config**: `OFFICERS_CHANNEL_ID` (wrangler var)
  falls back to `DEFAULT_OFFICERS_CHANNEL_ID` in `audience.ts` (the real channel,
  set 2026-09-22). Absent uses the default; **blank means "no officer channel"**
  and makes the Worker serve NOTHING rather than guess. `PUBLIC_CATEGORY_IDS` is
  documentation only (see below).
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
- **Degraded mode**: `X-Audience-Source: channels|unavailable` reports whether the
  secondary channels fetch succeeded. It is now **informational only** -- the
  audience no longer depends on that fetch, so `unavailable` does NOT mean events
  leaked. A failure there does not blank the public calendar.
- **`GET /audiences`** is the diagnostic: it reports `officersChannelId` and
  `configured`, lists every category, and lists every non-category channel with its
  id, category, and resolved audience -- so the real config can be verified without
  Discord UI archaeology. A wrong officer channel id fails open and is otherwise
  invisible. It exposes channel/category names (no event data, no secret) and is
  `Cache-Control: no-store`.
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
explicit product decision (no key, no login). `src/pages/Officers.tsx` says so in
a visible banner, and the 
  Subscribe panel repeats it, because the likeliest leak is an officer pasting the
  link without realizing it carries no auth.
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

The website owns:

- Background refresh: `Calendar.tsx` polls `fetchEvents` every `EVENTS_POLL_INTERVAL_MS` (60 s, deliberately matching the KV TTL) with the same visibility-aware pattern as `LiveMap.tsx` -- skip while `document.hidden`, immediate repoll on visibility, abort the in-flight poll before starting a new one. Transient poll failures keep the last-good events; the error card only appears when nothing has loaded yet.
- RRULE expansion for recurring events (via the `rrule` package).
- The month-grid UI, day-name headers, chip rendering, and the mobile layout branch (below).

## Subscribable calendar (.ics feed)

Users can subscribe to the team calendar from Google Calendar / Apple Calendar / Outlook. The feed is generated by the Worker, not the client: `worker/src/ics.ts` (`buildCalendar`) serializes the same KV-cached events into a VCALENDAR document served at `GET /calendar.ics` with `Content-Type: text/calendar; charset=utf-8` and `Content-Disposition: inline`.

Key decisions in `worker/src/ics.ts`:

- **Recurring events ship as an RRULE, not as expanded occurrences.** Calendar clients (Google/Apple/Outlook) expand RRULEs natively, so one VEVENT per Discord event keeps the feed small and stable as occurrences roll forward. This is the opposite of the website's approach (`expandRecurrences`), which must materialize concrete occurrences for the month grid. Emit the RRULE only when it matches `/^FREQ=/i`; a malformed rule is dropped rather than risk the client rejecting the whole calendar.
- **Everything is UTC** (`20261001T190000Z`). Clients render it in the viewer's local timezone.
- **Zero-duration events get a one-hour `DTEND`.** RFC 5545 forbids `DTEND == DTSTART`, and Discord zero-duration announcements serialize that way without the guard (`DEFAULT_DURATION_MS`).
- **`UID` is `discord-<event.id>@autoboat.aoe.vt.edu`** so a client refreshing an existing subscription rewrites events in place instead of duplicating them. Recurring events keep one UID.
- **Line folding counts UTF-8 octets, not characters** (75-octet limit, continuation lines start with a space). A naive `slice(75)` splits multi-byte characters and corrupts the feed. `escapeText` handles `\`, `;`, `,`, and newlines; `URL` is emitted unescaped because it is a URI value type.
- `CALENDAR_NAME` var (default "AutoBoat at Virginia Tech") sets `X-WR-CALNAME`. `REFRESH-INTERVAL` / `X-PUBLISHED-TTL` advertise the KV TTL.
- Malformed events (unparseable `DTSTART`) are skipped individually so one bad record can't break the feed.

Client-side URL helpers live in `src/lib/discord.ts`: `EVENTS_ICS_URL` (the `https://` feed URL) and `webcalUrl()` (same URL with the scheme swapped to `webcals://`, which hands it to the OS calendar app). `CalendarSubscribe.tsx` renders the disclosure control in the calendar header, offering the `webcals://` button plus "copy feed URL" and a direct `.ics` download.

WARNING: There is deliberately **no Google Calendar or Outlook deep link**. Do not re-add one:

- Google's classic `calendar/render?cid=<feedUrl>` handler is broken for external feeds. Google support staff confirmed the regression (thread 376167890, Sept 2025) and told users to add via **Settings > Add calendar > From URL** instead; day-to-day reports of `cid=https://` returning "Unable to add calendar. Check the URL" continued through Nov 2025. The `calendar/r/settings/addbyurl` route is not a substitute either -- signed out, it 302s to the Workspace marketing page.
- Outlook's `addfromweb` endpoint is similarly unreliable.

Users of those apps are directed to the manual "Add calendar from URL" flow, with the feed URL shown in the panel for copying. Verified with the live feed: it returns 200 / `text/calendar; charset=utf-8` with 4 events and **zero RRULEs**, so the feed itself is not the cause (RRULE is a known-but-inapplicable Google trigger here).

WARNING: The subscribe panel is an **absolutely positioned dropdown** anchored to `.calendar-header` (which sets `position: relative`), NOT to the toggle. It was originally in normal flow taking a full header row; that stretched the panel to the card's full width (~1250px) for what is only three provider rows plus a URL. Consequences to preserve:

- `.calendar-wrapper` must keep `overflow: visible` (it used to be `hidden`) or the dropdown is clipped. The month grid clips its own rounded corners via `.calendar` instead.
- `.calendar-header` must keep `position: relative` — it is the panel's containing block.
- The panel is centered on the header (`left: 50%` + `transform: translateX(-50%)`). It used to use `right: 0` to hug the header's right edge, matching a toggle that sat at the right end of the header. Once the controls moved to a centered row below the month, that anchor left the panel detached from the toggle by ~344px at 1280px. Centering keeps the panel under the toggle, and because the containing block is unchanged the `min(25rem, 100%)` width still resolves against the header, so it can never overflow the viewport at any width.
- WARNING: If you ever add a `transform` to `.calendar-subscribe__panel` (for an open/close animation), include the centering translate or the panel will jump sideways: `transform: translateX(-50%) translateY(8px)`.
- The panel widths with `min(25rem, 100%)`: at desktop it caps at a readable 25rem; on mobile `100%` resolves against the header so it can never overflow the viewport. Anchoring to the *toggle* instead fails on mobile, where the toggle sits mid-row and a left-extending panel runs off screen.
- `.calendar-subscribe` is `display: inline-flex` so it sits inline in the nowrap `.calendar-header__controls` group without stretching it. See "Month-nav header layout" below for what that group may contain (Today + Subscribe, NOT the month arrows).

WARNING: The panel's typography rules are written as `.calendar-subscribe__panel .calendar-subscribe__title` (0,2,0) on purpose. The panel renders inside `Card`, and `.card h3` / `.card p` (0,1,1) otherwise beat a bare single-class rule (0,1,0) — the title rendered at 36px and body text at 20px instead of ~17px/14px. Keep the doubled-up selectors when adding text styles here.

WARNING: The provider list is an explicit single-column grid (`grid-template-columns: 1fr`), not `auto-fit`. At the 25rem cap auto-fit always resolves to one column anyway, and being explicit avoids a lopsided 2+1 split at the one width where a second column would technically fit.

WARNING: `navigator.clipboard` is undefined on insecure origins and in jsdom, so the copy button falls back to a hidden `<textarea>` + `document.execCommand("copy")`. Keep that fallback.

WARNING: To view the calendar locally, the Worker's CORS (`ALLOWED_ORIGIN`) is locked to `https://autoboat.aoe.vt.edu`, so `localhost:3000` requests are blocked. Stub the `/events` response in devtools/Playwright, or temporarily point `ALLOWED_ORIGIN` at localhost.

Real subscriptions only work against the **deployed** Worker URL -- `wrangler dev` is local-only, so a calendar app on another machine can't reach it.

## Mobile layout (max-width 700px)

Below 700px the calendar renders a different markup branch, gated by an `isMobile` state read from `matchMedia("(max-width: 700px)")` (React state, not CSS-only hiding, because nesting `<button>` chips inside a `<button>` day cell would be invalid HTML):

- **Day cells become `<button>`s** with one accent dot per event (max 3 + a "+N" overflow) instead of full text chips -- a ~45px column can't hold a two-line chip. Dot classes mirror chip status: `--muted` for canceled/completed, `--recurring` hollow ring for recurring.
- **Weekday headings collapse** to single letters (`DAY_HEADINGS_SHORT`); the full name stays in an `sr-only` span (aria-hidden on the short form). Do NOT put `aria-label` on the DOW div -- Biome's a11y lint rejects it on generic-role elements, and adding `role="columnheader"`/`<th>` trips other lint rules.
- **A tappable agenda list** renders below the grid for the `selectedDay` (defaults to today). The selected cell gets `.calendar-day--selected` (inset ring) + `aria-pressed`. `navigateMonth()` and `goToToday()` also move `selectedDay` (to the 1st of the new month / to today) so the agenda never references a day the grid no longer displays.
- The agenda rows reuse `eventChipClassName` and open the same `EventModal`, so status styling and modal behavior are shared between branches.
- 700px is the point where ~90px columns start needing multi-line chips; the media query in `app.css` and the matchMedia query in `Calendar.tsx` MUST match.
- Tests: `src/test/setup.ts` stubs matchMedia with `matches: false`, so the existing tests exercise the desktop branch; the mobile describe block in `Calendar.test.tsx` re-stubs it to `matches: true` in `beforeEach`.

### Month-nav header layout

WARNING: Both month arrows and the month label live in ONE flex container, `.calendar-month-nav` (prev arrow, `.calendar-month-label`, next arrow). Do NOT move an arrow back out to be a direct child of `.calendar-header` or into `.calendar-header__controls`.

The header carries TODAY + SUBSCRIBE ON A CENTERED ROW BELOW THE MONTH at every width (the user asked for this at all breakpoints, not just mobile). `.calendar-month-nav` is `flex: 1 1 100%`, so its 100% basis forces it onto a row of its own; `.calendar-header__controls` then wraps to the row beneath it and `justify-content: center` on the header centers that group. Desktop used to put everything on one row (`space-between`), so this is a deliberate always-wrapped layout — don't "restore" a single row.

WARNING: `justify-content: center` (not `space-between`) is load-bearing. A wrapped flex row holding a single item under `space-between` pins that item to the **left edge**, which is what left Today + Subscribe hanging left under a centered month label (measured at 390px: gap-left 0px, gap-right 111px). Anything that stops `.calendar-month-nav` from claiming its own row will re-expose this.

WARNING: `.calendar-month-nav` deliberately has no `min-width: 0`. Its automatic minimum size is `min-content` (the longest word in the label), which is what stops the label collapsing to zero width. Adding `min-width: 0` made the label 0px wide at 320/360px while the arrows stayed put. The label inside uses `flex: 1` to fill the space between the arrows.

Because the nav group no longer shares a row with the controls, the `@media (max-width: 700px)` block needs no header-centering override (it only trims `margin-bottom` now).

Regression guard: `Calendar.test.tsx` "keeps both month nav arrows in the same container as the month label" asserts both arrows are children of `.calendar-month-nav`, that the label sits between them, and that neither is inside `.calendar-header__controls`.

WARNING: The shared button class is `.btn--sm` (double dash), NOT `.btn-sm`. There is no Tailwind `sm:` derivative here — `.btn`/`.btn--sm`/`.btn--primary`/`.btn--solid` are hand-written classes in `app.css`. The header's mobile sizing rule was written as `.calendar-header .btn-sm`, which matched **nothing**, so the intended trim silently did nothing until 2026-09-22. Use `.calendar-header .btn--sm` and keep it scoped to `.calendar-header` so LiveMap's three `.btn--sm` buttons (Recenter / Refresh now / Try again) keep the shared size. A `.calendar-today-btn` rule pair also sat unused in the calendar block and was deleted. WARNING: **Lesson: a CSS rule that matches nothing fails silently** — grep the selector against the actual JSX `className` strings before assuming a cascade/specificity problem.

## No-webhook constraint

Discord incoming webhooks are POST-only on a channel -- they cannot *pull* guild events. Discord's "outgoing" Webhook Events (push to your app over HTTP) do not include any `GUILD_SCHEDULED_EVENT_*` types in their event list. Scheduled-event create/update/delete events only exist on the Gateway (persistent bot WebSocket connection), which requires an always-on process. The Worker + KV approach is the smallest server-side surface that works for a read-only calendar.

## Key exports in `src/lib/discord.ts`

- `EVENTS_URL` — base Worker URL (from `globalThis.__VITE_EVENTS_URL__` or a placeholder default; override with the `VITE_EVENTS_URL` env var).
- `EVENTS_ICS_URL` — `${EVENTS_URL}/calendar.ics`, the subscribable feed URL.
- `webcalUrl()` — the `webcals://` form of `EVENTS_ICS_URL`.
- `DISCORD_GUILD_ID` — public guild id used to deep-link chips to Discord. Keep in sync with `DISCORD_GUILD_ID` in `worker/wrangler.jsonc`.
- `fetchEvents(signal?)` — GET with `cache: "no-store"`, returns `CalendarEvent[]`. Structural-invalid payloads degrade to `[]` rather than throwing; HTTP/network errors throw `DiscordError`. When the API `location` is null, the event is enriched via `extractLocationFromDescription` (team events are voice-channel events for role-scoped signup, so Discord's `entity_metadata.location` is always empty and the physical location lives in the description).
- `isCalendarEvent` validates **both** `recurrenceRule`'s type and its content: it must be null or a string matching `/^FREQ=/i`. A rule that fails this is dropped along with its event, because the alternative is a value `rrulestr` throws on — and `expandRecurrences` catches that and silently falls back to a single occurrence, i.e. a wrong result rather than a visible failure.
- `fetchEvents` **derives `isRecurring` from `recurrenceRule`** rather than trusting the flag. The two fields are redundant, so a payload where they disagree would otherwise render an event chip as recurring while its occurrences collapse to one. Don't "simplify" this back to reading `isRecurring` directly.
- `extractLocationFromDescription(description)` — returns `{ location, description }`: pulls the location out of an explicit labeled line and strips that line from the description so the modal doesn't render it twice.
  - WARNING: **The ONLY accepted form is a labeled line.** The value must be on a line matching `/^\s*(?:location|where)\s*[:\u2013\u2014-]\s*(.+)$/i` (so `Location: Lavery Hall 335`, `Where: **Lavery Hall 335**`, `Location - ...` all work; leading markdown emphasis is stripped from the value). Anything else means **there is no location**. This is an explicit team contract, quoted from the maintainer: *"the location will only ever be formatted like `Location: Example Location or a link` / if its not in this format, there is no location"*.
  - Do **not** reintroduce a "first bold span" fallback or any similar guess. A bare bold span carries no signal — the team bolds the venue (`**Lavery Hall 335**`) but also bolds emphasis (`**This event is completely optional.**`). A previous heuristic gate (`looksLikeLocation()`, a word-list + punctuation filter) was written to contain that class of bug and then **deleted** when the maintainer confirmed the labeled-only contract; guessing is now out of scope, not merely guarded. A heuristic false negative also silently hid real venues, which the explicit label never does.
  - A labeled line with an empty value (`Location:`) yields `location: null`, and the line is still removed from the description.
- `isLocationUrl(location)` — `true` only when the whole trimmed value is a bare `http(s)://` URL (so `https://us02web.zoom.us/j/123`, but not `www.example.com`, `https://` with no host, or `see https://example.com`). The location value is a *place* or a *link*; `EventModal` uses this to render links as a `target="_blank"` anchor and to **skip the Nominatim geocode + embedded map** for them — a URL can never resolve spatially, so geocoding one is a wasted request per modal open.
- WARNING: The link is inline text, and the location row top-aligns via `:has()`. Two traps, both verified by measuring the rendered lines:
  1. **The anchor must not be a flex row.** As `display: inline-flex` the trailing external-link glyph was centred on the whole block, so on a two-line Zoom URL it floated into the gap between the lines instead of riding the end of the text. It is `display: inline` (which computes to `block` here, since the anchor is itself a flex item of the row) with the glyph as `inline-block` + `vertical-align`.
  2. **`.event-modal__meta-row` is `align-items: center`, which drifts the pin a full line down on a wrapped link.** A two-line URL made the pin sit at the row's vertical centre, 12px below the first line. The `:has(.event-modal__location-link)` rule top-aligns and nudges the pin with `margin-top: calc((1lh - 15px) / 2)` — half the leading, since the first line box is `1lh` and the icon is 15px. A single-line (or place/no-location) row is unaffected and stays perfectly centred, so assert both cases if you touch this.
  - The `:has()` rules must stay declared AFTER the plain `.event-modal__meta-icon` / `.dark .event-modal__meta-icon` rules: they carry higher specificity, and putting them first trips Biome's `lint/style/noDescendingSpecificity` (twice).
- `expandRecurrences(events, from, to, now?)` — expands every RRULE event into concrete occurrences inside `[from, to]`. Malformed RRULEs fall back to a single occurrence at the base start. `now` is injectable (defaults to `new Date()`) solely so the cancelled-series clip is deterministic under test; `Calendar.tsx` passes its tracked `now` state so the clip follows the same clock as the "today" highlight.
- `discordEventUrl(event)` — `https://discord.com/channels/<guildId>/<eventId>`.

## Worker env configuration

`worker/wrangler.jsonc` holds public config as `vars`:

- `DISCORD_GUILD_ID` — public, not a secret.
- `ALLOWED_ORIGIN` — deployment origin; do NOT set to `*` in production.
- `CACHE_TTL_SECONDS` — KV TTL, `60` in production config (`parseTtlSeconds` in the worker falls back to `300` for unparseable/missing values). Lower values mean more Discord API hits; keep the website's `EVENTS_POLL_INTERVAL_MS` in sync with this. Also advertised in the `.ics` as `REFRESH-INTERVAL`/`X-PUBLISHED-TTL`.
- `CALENDAR_NAME` — optional; display name for the `.ics` feed (`X-WR-CALNAME`). Defaults to "AutoBoat at Virginia Tech".

Secrets (never committed) go in via `wrangler secret put`:

- `DISCORD_BOT_TOKEN` — the Discord bot's token.

For local `wrangler dev`, drop a `.dev.vars` file in `worker/` (gitignored). See `worker/README.md` for the full one-time setup.

## Route wiring

For a new page, register the route in `src/App.tsx` and `scripts/spa-fallback.mjs` (see `deploy.instructions.md`). The `/calendar` route specifically is registered in four places, all of which MUST stay in sync:

1. `src/App.tsx` — `<Route path="/calendar" element={<Calendar />} />`.
2. `scripts/spa-fallback.mjs` — `ROUTES` array includes `"/calendar"` so the S3 SPA fallback writes `dist/calendar/index.html`.
3. `README.md` — routes table + `VITE_EVENTS_URL` env var description.
4. `src/pages/OtherPages.tsx` — `FEATURE_PAGES` entry so the Other Pages hub links to it.

WARNING: `/calendar` is deliberately **not** in `NAV_LINKS`. It's reachable directly at `/calendar` and from the `/other-pages` hub. Adding it back to the nav would blow the five-link width budget (see `AGENTS.md`).

Drop any of the four and the route breaks in a different way (client-side vs S3 vs hub vs docs).

WARNING: **`/calendar/officers` is the exception to all four.** It needs only #1 and #2 -- it must NOT be added to `NAV_LINKS`, `FEATURE_PAGES`, or advertised in the README routes table, because those are all public surfaces. It shares the `Calendar` component via the `variant="officer"` prop rather than being a separate calendar implementation, and is a **flat route nested by URL only** (no `<Outlet>`; React Router ranks by specificity, so it beats `/calendar` regardless of order). If you ever "tidy up" the route tables by copying the `/calendar` pattern, you will publish the officer calendar's address to the whole site.

## Recurrence expansion

`worker/src/events.ts` normalizes Discord's raw payloads into the `CalendarEvent` shape both formats consume (`toCalendarEvent` / `normalizeEvents`). It is deliberately pure -- no bindings, no `fetch`, no KV -- so the raw-payload -> feed path is unit-testable without Cloudflare's ambient types; `index.ts` owns the HTTP/KV/caching concerns and imports the types from here.

WARNING: Discord's `recurrence_rule` is a **structured object**, NOT a pre-serialized RRULE string:

```
{ start, end?, frequency, interval, by_weekday?, by_n_weekday?, by_month?, by_month_day? }
```

`worker/src/recurrence.ts` (`formatRecurrenceRule`) converts it into an RFC 5545 RRULE *body* (no leading `RRULE:`) once, at the Worker boundary, so the website (`expandRecurrences`, which prepends `RRULE:` and calls `rrulestr` with the event's base `scheduled_start_time`) and the `.ics` feed share one conversion and cannot drift apart. The client's `CalendarEvent.recurrenceRule` is that already-converted string.

This was previously implemented as `typeof e.recurrence_rule === "string"`, which silently produced `null` for every event (Discord's object is not a string), so `isRecurring` was always `false` and the `.ics` feed never emitted an `RRULE`. Do not revert to reading the raw Discord field as a string.

An unknown `frequency` or a non-positive `interval` rejects the whole rule (returns `null`); out-of-range values inside an otherwise valid rule (a `by_weekday` of `9`, `by_month` of `13`) are dropped individually. `by_weekday` wins if both by-day fields are present. `by_year_day` and `count` are never read -- Discord documents them as not settable by clients, so they don't appear in API responses.

WARNING: `rule.end` (Discord's "ending time of the recurrence interval") becomes **`UNTIL`**, emitted last because it must terminate the rule. The `end` field was previously declared on the interface but never read, so every series was treated as **infinite** -- the month grid rendered occurrences forever and the feed published a never-terminating `RRULE`. An unparseable `end` is dropped (an unbounded rule beats a malformed `UNTIL` that makes a client reject the whole RRULE). `UNTIL` is formatted as a UTC date-time (`20261103T190000Z`), which RFC 5545 requires when `DTSTART` is UTC -- and it always is here, since `ics.ts` serializes everything in UTC.

Note: Discord's docs mark `end` as "cannot be set externally currently" — meaning clients cannot set it. **Verified against the live API on 2026-09-22: Discord sends `"end": null` for every recurring event in the guild.** Every other optional rule field is likewise present-but-null (`by_n_weekday`, `by_month`, `by_month_day`, `by_year_day`, `count`), so this is explicit null, not omission. The practical consequence: the `UNTIL` branch is **correct but currently unreachable** — `formatUntil` returns null and rules publish unbounded, which is why the live payload shows `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU` with no `UNTIL`. Keep the branch (it is correct if Discord ever populates `end`, and it is covered by tests), but do not expect it to fire today.

Every occurrence inside the current month grid becomes one chip; each occurrence's `end` is shifted by the base event's duration so multi-hour meetings keep their length.

### Cancelled events

Discord has **no per-occurrence exception mechanism**. The recurrence rule object has no `EXDATE`-equivalent field (its fields are exactly `start`, `end`, `frequency`, `interval`, `by_weekday`, `by_n_weekday`, `by_month`, `by_month_day`, `by_year_day`, `count`), so "cancel one occurrence in a series, keep the rest" cannot be sent through the API. `PATCH`/`DELETE /guilds/{id}/scheduled-events/{id}` take whole-event ids, and the occurrences of a series are not separate resources.

**The team's workaround is an in-description convention**, parsed by `worker/src/cancellations.ts`:

```
Location: **Lavery Hall 335**
Cancelled: October 11th 2026
```

This is the ONLY way a single occurrence can be cancelled, so it is load-bearing — keep the parser and both consumers in sync:

- **Label** matched: `Cancelled` / `Canceled` / `Skipped` / `No meeting`, case-insensitive, followed by `:`, `-`, or an en/em dash. The label is required on purpose: without it, ordinary prose ("We cancelled the October 11th launch, new date TBD") would be parsed as a cancellation. The same `LABEL_RE` drives both the parser and `stripCancelledNote`, so the two can never disagree about what counts as a note.
- **Date forms**: `October 11th 2026`, `Oct 11, 2026`, `September 3rd` (year omitted), or ISO `2026-10-11`. The year defaults to the **event's own start year**, not today — parsing is deterministic and a past-year series still parses.
- **Lists on one line**: the team writes several dates in a single note, mixing a bare year with a comma-before-year across items:

  ```
  Cancelled: October 11th 2026, November 3rd, 2026
  ```

  Separators are not parsed specially — the month-name and ISO patterns are simply matched globally across the line, so commas, semicolons, and `and` all work, as does mixing month-name and ISO forms in one list. A year applies only to the item it trails; later items without one fall back to the reference year. Duplicates are collapsed, so repeating a date across items or lines is harmless.
- **Validation**: impossible dates (Feb 30, month 13, non-leap Feb 29) are dropped individually rather than failing the whole line. Malformed input never throws; a bad note must not take down the calendar.
- Output is deduplicated and sorted, so it is stable to assert on.

**The note line is stripped from the description** (`stripCancelledNote`) before it reaches the modal. The dates are surfaced as chips on the calendar, so leaving the raw line in would render the convention verbatim to visitors and show the same information twice. `LABEL_RE` is shared with the parser so a line can never be parsed as a cancellation yet still displayed. Only labelled lines are removed — prose that merely mentions a cancelled date survives intact. Blank-line runs left behind are collapsed; when the note was the only content the description becomes `null`.

**Three consumers, deliberately differing:**

| Consumer | Behaviour | Why |
| --- | --- | --- |
| `GET /events` | `cancelledDates: string[]` | the parsed data, plus `description` with the note removed |
| Website (`expandRecurrences`) | **renders** the occurrence, flagged `isCancelled: true` | a visitor scanning the grid benefits from seeing that a meeting was called off |
| `.ics` feed (`ics.ts`) | **omits** it via `EXDATE`, only when an RRULE is present | a subscriber's calendar should stay clean — a called-off meeting just disappears |

WARNING: Because the website and the feed differ, `isCancelled` and "is this in the feed" are NOT the same question. `ExpandedOccurrence.isCancelled` always exists (`boolean`, never `undefined`) because the chip/dot styling reads it directly — a missing field would silently render a cancelled occurrence as normal.

WARNING: Occurrence matching uses the **local** calendar day (`localDateKey`), not UTC. Notes are written the way the grid displays them, so a 23:00Z meeting must match by its local date or the exclusion silently misses.

WARNING: `EXDATE` reuses the **event's own `DTSTART` time-of-day**, not midnight. RFC 5545 clients match `EXDATE` against `DTSTART` by value, so a midnight timestamp would fail to exclude an evening meeting. `toExdateValue(isoDate, event.start)` is the only correct way to build the value.

**Styling.** The cancelled treatment uses `--color-cancelled` (an alias of `--vt-impactOrange`, the brand's sanctioned digital-text orange). It is deliberately not `--color-accent`, and not the muted grey used by `calendar-event--completed`: a cancelled meeting must not read as a normal event with most of the styling applied. `eventChipClassName(occurrence)` takes the whole occurrence (not just the event) because two independent notions of "cancelled" meet there:

- `occurrence.isCancelled` — this one occurrence was cancelled via the note.
- `event.status === "canceled"` — the whole series was cancelled in Discord.

Both get the same treatment (to a reader they mean the same thing) but the modal distinguishes them: "This occurrence was cancelled" vs "This event was cancelled". The mobile day-cell dots and the agenda rows reuse the same helper, so all three surfaces stay in sync.

WARNING: `toExdateValue` must validate with `Number.isInteger`, not `undefined`/truthiness checks. `"not-a-date".split("-").map(Number)` is `[NaN, NaN, NaN]` — destructured as `NaN`, which passes an `undefined` check and emits the corrupt literal `NaNNaNNaNT193000Z` straight into the feed. There is a regression test for exactly this.

Discord's `status: "canceled"` is a *different* thing — that is the **whole series** being cancelled, handled as described below.

**Whole-series cancellation** is handled in two deliberately different ways:

- **Website (`expandRecurrences`)**: a `canceled` recurring event is clipped at `now` — occurrences that already happened still render (the cancellation is worth seeing), later ones are never generated. Without this the series would project struck-through chips into every future month forever, because `CANCELED` is terminal (the docs: "Once `status` is set to `COMPLETED` or `CANCELED`, the `status` can no longer be updated") and the RRULE carries no `UNTIL` (`end` is always null in practice — see below). The clip is `Math.min(to, now)`; when the window is entirely in the past it resolves to `to`, so historical months still expand normally.
- **`.ics` feed (`ics.ts`)**: the event is kept, serialized as `STATUS:CANCELLED`, and **keeps its RRULE**. A subscriber sees the whole series marked cancelled rather than it silently vanishing. Do not "fix" this into a drop or an RRULE strip — both are worse for a subscriber than a visibly-cancelled event.

`status: "completed"` gets a muted chip on the website but is **not** clipped: a completed event is not recurring (Discord only auto-completes an occurrence), so the status is inert for expansion.

`describeRecurrence(event)` (`src/lib/discord.ts`) renders the human-readable repeat line shown in `EventModal` under the date/time row ("Every week on Wednesday", "Every month on the 4th Wednesday"). It returns `null` for a non-recurring event so the caller can render it conditionally, and it delegates the phrasing to the `rrule` package's own `toText()` rather than hand-rolling a translation table -- `toText` already covers intervals, ordinal weekdays, month+day, and the "every weekday" special case, and stays consistent with what `expandRecurrences` actually produces. Only the first letter is capitalized; `toText`'s weekday/month names are already capitalized.

WARNING: `describeRecurrence` explicitly requires the body to start with `FREQ=` before calling `rrulestr`. A rule without one does **not** throw -- `rrulestr` silently defaults to `FREQ=YEARLY` -- so without that check a malformed rule would be described as "Every year" instead of admitting the rule is unreadable.

Two edge cases the month-grid rendering handles on top of the recurrence expansion:

1. **Zero-duration events** (start == end, e.g. small announcements without an end time): the grid-cell date filter uses a half-open interval so an event whose start and end coincide with the day's start-of-day boundary still renders on that day. Without this guard the strict `end > dayStart` comparison would drop the chip entirely. See `buildMonthGrid` in `src/pages/Calendar.tsx`.
2. **Variable-row month grids**: `cellCount` is derived from date values (`gridStartOffset + lastOfMonth.getDate() + daysFromSaturdayInMonth`), NOT from `(gridEnd - gridStart) / 86400_000`. Timestamp math crosses DST transitions (23- and 25-hour days) and rounds wrong, leaving the grid a few cells short. Iterate by date so each cell is exactly one calendar day.

WARNING: **`recurrence_rule.start` can disagree with `scheduled_start_time`, and we currently ignore it.** Verified live on 2026-09-22: the "Software Team Meeting" event had `scheduled_start_time = 2026-09-27T17:30:00Z` while its `recurrence_rule.start = 2026-09-20T17:30:00Z` — Discord had already advanced the event's start to the next un-elapsed occurrence, while the rule still described the true series origin. `recurrence.ts` does not carry `start` through to the RRULE body, so the client feeds `scheduled_start_time` into `rrulestr` as `dtstart`. Measured effect on that event over a 2026-09-01..10-15 window: **dtstart=09-27 yields 3 occurrences (09-27, 10-04, 10-11); dtstart=09-20 yields 4 (09-20, 09-27, 10-04, 10-11).** The 09-20 occurrence is silently dropped. The `.ics` feed is unaffected for the same reason (clients anchor on `DTSTART`, so they simply never generate the earlier one). This is a real but low-severity data-loss-at-the-margin bug: it only bites for rules whose `INTERVAL`/`BYDAY` filter does not re-derive the dropped date, and only for series that started before the current period. Fixing it means threading `rule.start` into the payload and using it as `dtstart`, which changes the expanded set — do that deliberately, with tests, not incidentally. Note `General Body Meeting` had the two fields agreeing (`2026-09-29` both), so the disagreement is not universal — and an aligned `rule.start` coincides exactly with `scheduled_start_time`, suggesting `scheduled_start_time` marks the *next* occurrence while `rule.start` marks the series origin.

Discord's RRULE subset (as of API v10 / 2026) is:

- `frequency`: YEARLY(0), MONTHLY(1), WEEKLY(2), DAILY(3).
- `interval`: 1 (every N) or 2 (every other week, weekly only).
- `by_weekday`: weekly, max length 1; `0=Mon..6=Sun`. Maps to RFC `BYDAY=MO|TU|WE|TH|FR|SA|SU`.
- `by_n_weekday`: monthly Nth-weekday (e.g. `{n:4, day:2}` == "4th Wednesday" == `BYDAY=WE;BYSETPOS=4`).
- `by_month` + `by_month_day`: yearly.

The `rrule` package handles the full RFC 5545 grammar, so all of the above variants work transparently.

## Tests

- `src/test/lib/discord.test.ts` — `fetchEvents` (happy/error/malformed/abort cases, mock fetch with duck-typed responses), the `isCalendarEvent` guard (a structured-object `recurrenceRule` and an unusable RRULE body are both rejected; a valid recurring event survives), `isRecurring`-vs-`recurrenceRule` reconciliation in both disagreement directions, `extractLocationFromDescription` (a labeled place, a labeled URL, a bolded labeled value, an empty labeled value, an unlabeled bold span left completely intact, a `it.each` of unlabeled spans including real venues such as `Lavery Hall 335`/`Newman Library`/`1830 Alumni Mall` asserting `location: null` with the description unchanged, and no-labeled-line), `isLocationUrl` (schemes, path/query/fragment, surrounding whitespace vs the non-URL cases `www.example.com`, bare `https://`, and `see https://example.com`), `describeRecurrence` (weekly, every-other-week, weekday set, monthly Nth-weekday, yearly month+day, bare frequency, capitalization, and the null cases: non-recurring, missing rule, unparseable rule, and a rule with no `FREQ`), `expandRecurrences` (weekly, daily, UNTIL clip, malformed-RRULE fallback, duration shift, sort order), the **cancelled-series clip** (a mid-series `now` keeps only past occurrences, a `now` before the series yields none, a `scheduled` event keeps the full window, and a `now` past the window leaves the historical range intact), and the subscribe URL helpers (`EVENTS_ICS_URL`, `webcalUrl`). Note its fixtures feed `expandRecurrences` already-converted `recurrenceRule` strings (the client-side shape) rather than raw Discord payloads — the raw-payload path is covered by `src/test/worker/events.test.ts`.
- `src/test/pages/Calendar.test.tsx` — page render states (loading, success, error, empty), chip rendering with real Discord URL, recurrence expansion, month nav, error-card behavior, the subscribe control, the `EventModal` repeat line (present directly after the date/time row for a recurring event, absent for a one-off), a **URL-valued location** case (renders a `target="_blank"` `rel="noopener noreferrer"` anchor, renders no map, and fires exactly one fetch — i.e. the link is never sent to Nominatim), a **per-occurrence cancellations** block (the cancelled chip gets `calendar-event--canceled` and is still rendered, a non-cancelled occurrence is not flagged, the modal shows "This occurrence was cancelled" vs "This event was cancelled" for a whole-series cancel, and a normal event shows neither), plus a "mobile branch" describe block (matchMedia stubbed to `matches: true`) covering day-cell buttons, dots, the agenda swap, agenda->modal, and selection-on-month-nav. The modal recurrence test uses a **monthly** rule so the grid renders exactly one chip — a weekly rule yields several with the same accessible name, which breaks `getByRole`.
- `src/test/components/CalendarSubscribe.test.tsx` — panel open/close, provider URLs, `.ics` download, and clipboard copy (async Clipboard API, `execCommand` fallback, and rejection handling).
- `src/test/worker/ics.test.ts` — the ICS serializer: VCALENDAR envelope + CRLF endings, UTC/tz-offset timestamps, stable UIDs, zero-duration and null-end defaults, `STATUS:CANCELLED`, TEXT escaping, octet-based line folding (including multi-byte characters), RRULE passthrough + malformed-rule rejection, and unparseable-date skipping. **Imports `worker/src/ics.ts` by relative path** (`../../../worker/src/ics`) because the Worker lives outside `src/` — Jest's `testMatch` only picks up files under `src/`, so a test must live here to run.
- `src/test/worker/recurrence.test.ts` — `formatRecurrenceRule`: weekly/daily/monthly-Nth-weekday/yearly conversion, every frequency code, null/unknown-frequency rejection, non-positive `interval` handling, out-of-range `by_weekday`/`by_month`/`by_month_day` dropping, `by_weekday`-over-`by_n_weekday` precedence, `UNTIL` from the rule's `end` (conversion, placement last, omission when absent, unparseable `end` dropped, and expansion actually bounded), and a round-trip asserting the emitted body expands correctly through `rrulestr`. Imports `worker/src/recurrence.ts` by relative path, same reason as `ics.test.ts`.
- `src/test/worker/events.test.ts` — the **integration** suite: raw Discord payloads (documented snake_case shapes, numeric status/frequency, nested `entity_metadata`) -> `normalizeEvents` -> `buildCalendar` -> asserted RFC 5545 output, plus an `rrulestr` expansion. This is the only suite that exercises the seam between normalization and serialization; the two suites above test their units in isolation and cannot observe a break in between. It guards the original bug directly (a `recurrence_rule` read as the wrong type produced no `RRULE`); **verified by temporarily reintroducing the defect and confirming 5 of its 9 tests fail**, then restoring the fix. It also covers the cancellation convention end-to-end (description -> `excludedDates` -> `EXDATE`), including that the EXDATE actually collides with a generated occurrence rather than merely appearing.
- `src/test/worker/cancellations.test.ts` — `parseCancelledDates` (the documented two-line example, every label variant, multi-date/multi-line/dedup/sort, the mixed comma-before-year list style, year resolution and explicit-year precedence, and the malformed cases: null input, unlabelled prose, `TBD`, Feb 30, month 13, day 32, non-leap Feb 29, non-month words), `stripCancelledNote` (note removal, mid-description notes, multiple notes, null when the note was the only content, blank-line collapsing, every label variant, and that unlabelled prose survives), and `toExdateValue` (time-of-day borrowed from `DTSTART`, sub-second truncation, midnight fallback for an unparseable start, and the `NaNNaNNaN` malformed-date regression). Imports `worker/src/cancellations.ts` by relative path, same reason as `ics.test.ts`.
- `src/test/worker/audience.test.ts` — `parseChannelIds` (comma/whitespace/trailing-comma/JSONC-indentation forms, and that empty-ish input gives `[]`), `audienceConfigFromEnv` (the committed default, that a **blank** `OFFICERS_CHANNEL_ID` means "no officer channel" rather than falling back to the default, and first-id-wins), the default id's snowflake shape, `audienceForChannel` (officer for the configured channel, public for subteam/general/no-parent/unknown/null, that a channel merely *containing* the id is not officer, and that an **empty channel list still hides officer events** — the old degraded-mode leak), `isOfficerEvent`, `listChannels`, and `listCategories` (categories only, sorted).
- `src/test/worker/audience-filter.test.ts` — the classification seam through `normalizeEvents`: that `channel_id` survives normalization (dropping it would silently make everything public), officer vs public per channel, each event classified independently within one payload, `channelId` + `audience` in the full normalized shape, that classification composes correctly with cancellation parsing and recurrence conversion, and `publicEvents` (drops officer, keeps order, all-officer -> empty).
- `src/test/pages/Officers.test.tsx` — that the page requests the **officer** route specifically (compared as a full URL, since the public route is a substring-compatible neighbour), the subscribe control points at the officer `.ics` (and NOT the public one), the webcal URL derivation, the "unlisted but not password protected" warning, and the accessible heading.

WARNING: When adding a year test here, the **written year must differ from the reference year**. An earlier version of this suite used `referenceYear=2026` with `2026` written explicitly, so a silently-dropped year was undetectable — removing the `,?` from `MONTH_DAY_RE` still passed all 78 tests, because the year fell back to a reference year equal to it. Always make the parsed value distinguishable from the fallback.

### Proving the audience filter actually filters

The filter fails **open** (a bug publishes officer events rather than throwing), so tests are the only thing standing between a typo and a leak. Both halves are regression-proven by temporarily reintroducing the defect:

- Gutting `publicEvents` to `return events` fails **2** tests.
- Making `audienceForChannel` always return `"public"` (ignoring the officer channel) fails **many** — it is the single point every officer assertion runs through.

If you refactor either function, redo both probes. A green suite that would also pass with the filter disabled is worthless here.

Both follow the existing `LiveMap.test.tsx` patterns: `MemoryRouter` wrap, `mockFetchOnce` / `mockFetchSequence`, `flushMicrotasks()` to drain the `.then()` chain, restore `global.fetch` in `afterEach`.

WARNING: Jest's default cache directory resolves under `.vscode/tmp` in this environment, which the terminal sandbox blocks (`EPERM: operation not permitted, realpath`). If `bun run test` fails that way, run `npx jest --cache-directory "$TMPDIR/jest-cache"` instead.
