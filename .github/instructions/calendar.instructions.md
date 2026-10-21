---
description: "Use when working on the calendar page UI: the month grid, the mobile day-cell/agenda branch, the month-nav header, the Subscribe and Filter dropdowns, per-subteam event colors, the event detail modal, the embedded event location map, or the client-side Discord events client and RRULE expansion. Covers the page component pattern, buildMonthGrid, the 700px markup branch, the dropdown panel anchors, the shared subteam--<slug> color class, expandRecurrences, describeRecurrence, and route wiring. The Worker, KV cache, audience gating, .ics serialization and officer event management live in discord-events.instructions.md."
applyTo: "src/pages/Calendar.tsx, src/pages/Officers.tsx, src/components/CalendarSubscribe.tsx, src/components/CalendarFilter.tsx, src/components/EventModal.tsx, src/components/EventMap.tsx, src/components/calendarDropdown.ts, src/lib/discord.ts, src/lib/eventChannels.ts, src/app.css, src/test/pages/Calendar.test.tsx, src/test/pages/Officers.test.tsx, src/test/components/CalendarSubscribe.test.tsx, src/test/components/CalendarFilter.test.tsx, src/test/components/EventModal.test.tsx, src/test/components/EventMap.test.tsx, src/test/lib/discord.test.ts, src/test/lib/eventChannels.test.ts, src/test/lib/feedUrls.test.ts"
---

# Calendar page (website)

`/calendar` renders Discord guild scheduled events as a month-grid calendar.
Everything that touches Discord -- the bot token, the KV cache, audience
filtering, the `.ics` serializer -- lives in the Worker. This file covers the
website half: what the page renders, how the client expands recurrences, and the
CSS/DOM traps that have actually bitten.

WARNING: This is a split of the old single `discord-events.instructions.md`. If you
are changing how events are FETCHED, CLASSIFIED, ARCHIVED, or SERIALIZED, read
`discord-events.instructions.md` instead. The two files describe one feature from
either side of the Worker boundary, so a change that crosses it needs both.

Data flow, website side only:

```
fetchEvents(signal)  ->  CalendarEvent[]        (src/lib/discord.ts)
        |
        +-- matchesChannelFilter(event, selection)   (src/lib/eventChannels.ts)
        |
        +-- expandRecurrences(events, from, to, now) -> ExpandedOccurrence[]
                    |
                    +-- buildMonthGrid(...)  -> cells  -> chips / day dots
                    +-- selectedDayOccurrences -> agenda rows
                              |
                              +-- EventModal -> EventMap (Nominatim geocode)
```

## Month grid rendering

`buildMonthGrid(monthAnchor, occurrences, now)` in `src/pages/Calendar.tsx` builds
the cell array; each cell holds the occurrences whose date falls on it. Two edge
cases are handled there and both are easy to "simplify" back into bugs:

1. **Zero-duration events** (start == end, e.g. small announcements without an
   end time): the per-day filter uses a half-open interval so an event whose
   start and end coincide with the day's start-of-day boundary still renders on
   that day. Without this guard the strict `end > dayStart` comparison would drop
   the chip entirely.
2. **Variable-row month grids**: `cellCount` is derived from date values
   (`gridStartOffset + lastOfMonth.getDate() + daysFromSaturdayInMonth`), NOT from
   `(gridEnd - gridStart) / 86400_000`. Timestamp math crosses DST transitions
   (23- and 25-hour days) and rounds wrong, leaving the grid a few cells short.
   Iterate by date so each cell is exactly one calendar day.

The agenda list's day filter reuses the same half-open interval deliberately, so
the grid and the agenda can never disagree about which day an event belongs to.

WARNING: `EVENTS_POLL_INTERVAL_MS` (180_000) is a READ-side knob only. It is matched
to the Worker's `CACHE_TTL_SECONDS`; a warm KV cache makes a poll cost zero
writes, so shortening the poll cannot affect the KV write budget. Do NOT lower
the Worker's TTL to "refresh faster" -- that is a hard write budget on the free
tier (see "Write budget" in `discord-events.instructions.md`).

Background refresh uses the same visibility-aware pattern as `LiveMap.tsx`: skip
while `document.hidden`, repoll immediately on visibility, abort the in-flight
poll before starting a new one. Transient poll failures keep the last-good
events; the error card only appears when nothing has loaded yet.

## Mobile layout (max-width 700px)

Below 700px the calendar renders a different markup branch, gated by an `isMobile`
state read from `matchMedia("(max-width: 700px)")` (React state, not CSS-only
hiding, because nesting `<button>` chips inside a `<button>` day cell would be
invalid HTML):

- **Day cells become `<button>`s** with one accent dot per event (max 3 + a "+N"
  overflow) instead of full text chips -- a ~45px column can't hold a two-line
  chip. Dot classes mirror chip status: `--muted` for canceled/completed,
  `--recurring` hollow ring for recurring.
- **Weekday headings collapse** to single letters (`DAY_HEADINGS_SHORT`); the full
  name stays in an `sr-only` span (aria-hidden on the short form). Do NOT put
  `aria-label` on the DOW div -- Biome's a11y lint rejects it on generic-role
  elements, and adding `role="columnheader"`/`<th>` trips other lint rules.
- **A tappable agenda list** renders below the grid for the `selectedDay` (defaults
  to today). The selected cell gets `.calendar-day--selected` (inset ring) +
  `aria-pressed`. `navigateMonth()` and `goToToday()` also move `selectedDay` (to
  the 1st of the new month / to today) so the agenda never references a day the
  grid no longer displays.
- The agenda rows reuse `eventChipClassName` and open the same `EventModal`, so
  status styling and modal behavior are shared between branches.
- 700px is the point where ~90px columns start needing multi-line chips; the media
  query in `app.css` and the matchMedia query in `Calendar.tsx` MUST match.
- Tests: `src/test/setup.ts` stubs matchMedia with `matches: false`, so the
  existing tests exercise the desktop branch; the mobile describe block in
  `Calendar.test.tsx` re-stubs it to `matches: true` in `beforeEach`.

## Month-nav header layout

WARNING: Both month arrows and the month label live in ONE flex container,
`.calendar-month-nav` (prev arrow, `.calendar-month-label`, next arrow). Do NOT
move an arrow back out to be a direct child of `.calendar-header` or into
`.calendar-header__controls`.

The header carries TODAY + SUBSCRIBE ON A CENTERED ROW BELOW THE MONTH at every
width (the user asked for this at all breakpoints, not just mobile).
`.calendar-month-nav` is `flex: 1 1 100%`, so its 100% basis forces it onto a row
of its own; `.calendar-header__controls` then wraps to the row beneath it and
`justify-content: center` on the header centers that group. Desktop used to put
everything on one row (`space-between`), so this is a deliberate always-wrapped
layout -- don't "restore" a single row.

WARNING: `justify-content: center` (not `space-between`) is load-bearing. A wrapped
flex row holding a single item under `space-between` pins that item to the **left
edge**, which is what left Today + Subscribe hanging left under a centered month
label (measured at 390px: gap-left 0px, gap-right 111px). Anything that stops
`.calendar-month-nav` from claiming its own row will re-expose this.

WARNING: `.calendar-month-nav` deliberately has no `min-width: 0`. Its automatic
minimum size is `min-content` (the longest word in the label), which is what
stops the label collapsing to zero width. Adding `min-width: 0` made the label
0px wide at 320/360px while the arrows stayed put. The label inside uses
`flex: 1` to fill the space between the arrows.

Because the nav group no longer shares a row with the controls, the
`@media (max-width: 700px)` block needs no header-centering override (it only
trims `margin-bottom` now).

WARNING: The 700px CSS media query is NOT a phone-only scope. The JS markup branch
flips at 700px too, but the header wraps several hundred px wider, so the
controls-share-row range (~500-700px) sees mobile markup with a desktop-ish
header. Harmless today, but don't assume the block only applies on phones.

Regression guard: `Calendar.test.tsx` "keeps both month nav arrows in the same
container as the month label" asserts both arrows are children of
`.calendar-month-nav`, that the label sits between them, and that neither is
inside `.calendar-header__controls`.

WARNING: The shared button class is `.btn--sm` (double dash), NOT `.btn-sm`. There is
no Tailwind `sm:` derivative here -- `.btn`/`.btn--sm`/`.btn--primary`/`.btn--solid`
are hand-written classes in `app.css`. The header's mobile sizing rule was written
as `.calendar-header .btn-sm`, which matched **nothing**, so the intended trim
silently did nothing until 2026-09-22. Use `.calendar-header .btn--sm` and keep it
scoped to `.calendar-header` so LiveMap's three `.btn--sm` buttons (Recenter /
Refresh now / Try again) keep the shared size. A `.calendar-today-btn` rule pair
also sat unused in the calendar block and was deleted.

WARNING: **Lesson: a CSS rule that matches nothing fails silently** -- grep the
selector against the actual JSX `className` strings before assuming a
cascade/specificity problem.

## Subscribe panel

The Subscribe control (`src/components/CalendarSubscribe.tsx`) is the UI for the
Worker's `.ics` feed. The feed itself -- serialization, UID scheme, line folding,
and why there is no Google/Outlook deep link -- is documented in
`discord-events.instructions.md` under "Subscribable calendar (.ics feed)".

Client-side URL helpers live in `src/lib/discord.ts`: `EVENTS_ICS_URL` (the
`https://` feed URL) and `webcalUrl()` (same URL with the scheme swapped to
`webcals://`, which hands it to the OS calendar app). The panel offers the
`webcals://` button plus "copy feed URL" and a direct `.ics` download.

WARNING: The subscribe panel is an **absolutely positioned dropdown** anchored to
`.calendar-header` (which sets `position: relative`), NOT to the toggle. It was
originally in normal flow taking a full header row; that stretched the panel to
the card's full width (~1250px) for what is only three provider rows plus a URL.
Consequences to preserve:

- `.calendar-wrapper` must keep `overflow: visible` (it used to be `hidden`) or the
  dropdown is clipped. The month grid clips its own rounded corners via
  `.calendar` instead.
- `.calendar-header` must keep `position: relative` -- it is the panel's containing
  block.
- The panel is centered on the header (`left: 50%` + `transform: translateX(-50%)`).
  It used to use `right: 0` to hug the header's right edge, matching a toggle that
  sat at the right end of the header. Once the controls moved to a centered row
  below the month, that anchor left the panel detached from the toggle by ~344px
  at 1280px. Centering keeps the panel under the toggle, and because the
  containing block is unchanged the `min(25rem, 100%)` width still resolves
  against the header, so it can never overflow the viewport at any width.
- WARNING: If you ever add a `transform` to `.calendar-subscribe__panel` (for an
  open/close animation), include the centering translate or the panel will jump
  sideways: `transform: translateX(-50%) translateY(8px)`.
- The panel width `min(25rem, 100%)`: at desktop it caps at a readable 25rem; on
  mobile `100%` resolves against the header so it can never overflow the viewport.
  Anchoring to the *toggle* instead fails on mobile, where the toggle sits mid-row
  and a left-extending panel runs off screen.
- `.calendar-subscribe` is `display: inline-flex` so it sits inline in the
  wrapping `.calendar-header__controls` group without stretching it.

WARNING: The panel's typography rules are written as
`.calendar-subscribe__panel .calendar-subscribe__title` (0,2,0) on purpose. The
panel renders inside `Card`, and `.card h3` / `.card p` (0,1,1) otherwise beat a
bare single-class rule (0,1,0) -- the title rendered at 36px and body text at 20px
instead of ~17px/14px. Keep the doubled-up selectors when adding text styles here.

WARNING: The provider list is an explicit single-column grid
(`grid-template-columns: 1fr`), not `auto-fit`. At the 25rem cap auto-fit always
resolves to one column anyway, and being explicit avoids a lopsided 2+1 split at
the one width where a second column would technically fit.

WARNING: `navigator.clipboard` is undefined on insecure origins and in jsdom, so the
copy button falls back to a hidden `<textarea>` + `document.execCommand("copy")`.
Keep that fallback.

Real subscriptions only work against the **deployed** Worker URL -- `wrangler dev`
is local-only, so a calendar app on another machine can't reach it.

## Channel filter (subteam events only)

The Filter control (`src/components/CalendarFilter.tsx`) narrows the calendar to
specific subteams. The team already schedules each subteam's events in its own
Discord voice channel, so the **channel id is the grouping key** -- no extra
marker, no second list to maintain. The Worker already ships `channelId` on every
event, so this needed no new API surface.

WARNING: The Worker-side half of this feature -- `parseChannelFilter`,
`filterByChannels`, the `?channels=` query, and why filtering costs no extra KV
writes -- is in `discord-events.instructions.md`. This section covers only the
picker and the client-side predicate.

**Scope rule (the thing to get right).** The picker narrows SUBTEAM events ONLY:

- **General member events** (`member-events`) are always shown. They are for the
  whole team, so a filter that could hide them would hide the main meetings from
  the people they are for.
- **Officer events** (`officer-events`) are always shown on the page they reach.
  Their visibility is already the audience filter's job (absent from the public
  feed, present on `/calendar/officers`), so the picker has nothing to add.
- **Channel-less events** are the one exception: they are not subteam events, but
  there is nothing else to group them by, so they get a selectable "Other" group.

`src/lib/eventChannels.ts` owns all of this. `SUBTEAM_CHANNELS` is what the
picker can filter; `ALWAYS_VISIBLE_CHANNEL_IDS` is what it never can.
`isAlwaysVisible()` is the shared predicate behind both `eventChannelGroups()`
(no checkbox for those channels) and `matchesChannelFilter()` (always shown), so
the picker can never offer a control that does not work.

WARNING: **No per-group event count, by design.** The picker lists a group name and a
checkbox, nothing else. A count cannot be made both accurate and meaningful: a
recurring Discord event is a SINGLE payload record that expands into many
calendar entries, so a record count reads "1" for a weekly meeting that fills the
month (measured on the live payload: every subteam channel showed `1`). An
occurrence count would instead track the visible month and would require
recurrence expansion just to build a checkbox list. The filter answers "which
subteam", not "how many". Do not add the badges back.

WARNING: **`eventChannelGroups()` takes `CalendarEvent[]`, not occurrences.** Group
membership comes from the FULL loaded set (all of history -- the Worker archives
past events), so a group does not vanish from the picker while you are looking at
a month where that subteam has nothing on. This is also what keeps it independent
of the month grid.

WARNING: **The selection is `null | ReadonlySet<string>`, and `null` means "all
subteams".** An empty set means "no subteams" and is a DIFFERENT state. Do not
"simplify" this to empty-set-means-all: with only one subteam that has events,
unchecking it produces an empty set, which would read back as "everything
selected" -- the checkbox would silently refuse to turn off. `toggleChannel()`
materializes the full list before subtracting, and collapses a fully-checked set
back to `null` so "all checked" and "no filter" cannot become two representations
with different feed URLs.

WARNING: **`workerChannelIds()` adds `ALWAYS_VISIBLE_CHANNEL_IDS` to every non-null
selection** (and returns `[]` for `null`, which the Worker reads as "no filter").
Without them a subscription would silently drop the general member events the page
still shows, so the feed and the grid would disagree. The channel-less "Other" key
is dropped -- there is no id to send.

`src/components/CalendarFilter.tsx` is the dropdown. It anchors exactly like the
Subscribe panel and the two share a mutual-exclusion event
(`src/components/calendarDropdown.ts`, a document-level
`autoboat:calendar-dropdown-open` CustomEvent) so both -- which occupy the same
rectangle -- can never be open at once. Each row shows a color swatch beside the
label, carrying the same `subteam--<slug>` class as the grid chips, so the panel
teaches the color mapping instead of the user having to infer it.

WARNING: The empty-state copy in `Calendar.tsx` distinguishes three cases
(`events.length === 0`, nothing in the visible month, filter matched nothing). The
raw event count cannot tell them apart: events in other months are loaded but not
rendered either.

WARNING: **Label aliases are a hand-maintained map** in `eventChannels.ts` (the team
chose this over fetching channel names -- no Worker change). A new or renamed
channel shows as "Other" until it is added. Do not "fix" this by fetching
`/channels` on the event path: that costs a second KV write per miss.

## Subteam colors

Grid chips, mobile day dots, and the filter's swatches are color-coded by
subteam. The mapping is `SUBTEAM_CHANNELS[].slug` -> a `subteam--<slug>` class
(`eventChannels.ts` -> `subteamSlugFor()` -> `app.css`).

- **`subteam--<slug>` is its own class, not a `calendar-event--<slug>`
  modifier.** The same hue has to reach three surfaces and only one of them is
  `.calendar-event` (day dots and swatches are plain spans), so a shared class is
  what keeps them from disagreeing. Adding a surface needs no CSS.
- **The classes only set `--subteam-color`.** Every colored part of a chip
  (left border, background fill, hover fill) and the dot/swatch background
  derives from that one variable, so a subteam's light/dark pair lives only in
  the token block and can never be half-retinted. Defaults are declared through
  `:where()` so the subteam override wins on specificity rather than on source
  order.
- WARNING: **The hue cannot also be the time text, because the fill is a tint of
  that same hue.** The chips use a fairly opaque branded fill (44% light / 34%
  dark; 50% / 38% on hover), so the text sits on a background derived from
  itself and a hue that reads fine as a swatch fails badly as text there
  (measured: electrical 2.32:1, business 2.26:1 with the raw hue). The time text
  is therefore `color-mix(in srgb, var(--subteam-color) 33%, var(--color-fontcolor))`
  -- 33% hue, 67% theme font color. All six chips clear WCAG AA (4.5:1) at rest
  AND on hover in both themes (light rest 5.34-5.65:1, hover 4.82-5.25:1; dark
  rest 5.19-6.55:1, hover 4.62-6.28:1).
- WARNING: **Those three numbers -- the two fill alphas, the 33% text mix, and
  the hues -- are one set.** Change any of them and re-measure the rest. The mix
  percentage is the HUE's share, so `33%` means mostly font color; writing `67%`
  there inverts it and every chip fails AA (this happened once -- the browser
  check caught it at 2.26-3.57:1). Verify in a browser, not by eye: the computed
  fill comes back as `color(srgb r g b / a)` with 0-1 floats, so a naive
  `match(/[\d.]+/g)` reads it as garbage.
- WARNING: **`--subteam-default` is the base brand maroon** (`--vt-maroon`
  light, `#b8345c` dark), so general member, officer, and channel-less events
  look exactly as they did before this feature. Do not repurpose a subteam hue
  for it. The dark `#b8345c` time text is a pre-existing 2.4:1 -- the dark
  subteam hues are all more readable than that baseline, so they are not a
  regression, and the cancelled/completed states continue to use the AA-safe
  `--color-hovercolor` rather than a subteam hue. NOTE: the same is NOT true of
  the cancelled mark, which is `--color-cancelled` at 3.44:1 against its 10%
  fill -- a pre-existing value, left alone.
- WARNING: **Status and subteam classes are independent and both are always
  applied.** A cancelled Software event keeps `subteam--software` AND
  `calendar-event--canceled`; the cancelled treatment reads through the border,
  strike-through, and opacity rather than through losing the color.
- WARNING: **A new subteam needs a `slug` in `SUBTEAM_CHANNELS`, a
  `--subteam-<slug>` token in BOTH the `:root` and `.dark` blocks, and a
  `subteam--<slug>` rule.** A slug with no token falls back to the default maroon
  silently, which looks like the channel simply has no color rather than like a
  missing entry.

## Event detail modal

`src/components/EventModal.tsx` opens from a grid chip, a mobile day cell + agenda
row, or an agenda entry, and reuses `ImageModal`'s two-phase mount so the
enter/exit transition plays.

- Both notions of "cancelled" are distinguished in copy: `occurrence.isCancelled`
  shows "This occurrence was cancelled" (from the description's `Cancelled:`
  note), `event.status === "canceled"` shows "This event was cancelled" (the
  whole series). A reader treats both as cancelled, but the sentences must stay
  distinct or a one-off cancellation looks like the series was called off.
- The delete affordance renders only when a session exists and requires a
  confirmation click. A recurring record is ONE Discord event, so the prompt says
  the whole series goes -- deleting does not remove a single occurrence (Discord
  has no per-occurrence delete). The Worker gate behind it is documented in
  `discord-events.instructions.md` under "Creating events from the website".
- A URL-valued location renders as a `target="_blank"` anchor and gets no map; a
  physical place gets the map below.

WARNING: The location link is inline text, and the location row top-aligns via
`:has()`. Two traps, both verified by measuring the rendered lines:

1. **The anchor must not be a flex row.** As `display: inline-flex` the trailing
   external-link glyph was centred on the whole block, so on a two-line Zoom URL
   it floated into the gap between the lines instead of riding the end of the
   text. It is `display: inline` (which computes to `block` here, since the anchor
   is itself a flex item of the row) with the glyph as `inline-block` +
   `vertical-align`.
2. **`.event-modal__meta-row` is `align-items: center`, which drifts the pin a
   full line down on a wrapped link.** A two-line URL made the pin sit at the
   row's vertical centre, 12px below the first line. The
   `:has(.event-modal__location-link)` rule top-aligns and nudges the pin with
   `margin-top: calc((1lh - 15px) / 2)` -- half the leading, since the first line
   box is `1lh` and the icon is 15px. A single-line (or place/no-location) row is
   unaffected and stays perfectly centred, so assert both cases if you touch this.

WARNING: The `:has()` rules must stay declared AFTER the plain
`.event-modal__meta-icon` / `.dark .event-modal__meta-icon` rules: they carry
higher specificity, and putting them first trips Biome's
`lint/style/noDescendingSpecificity` (twice).

## Event location map (`EventMap.tsx`)

The modal embeds a small non-interactive Leaflet map when an event has a physical
place. The location is free text, so it is geocoded at render time through
**OpenStreetMap's public Nominatim** (`/search?format=json&limit=1&q=...`, with a
descriptive `User-Agent`, which that service's usage policy requires). One
request per modal open; a failed request, an empty result set, or an aborted one
leaves the modal showing the text location alone. `isLocationUrl` values never
reach the geocoder (see below).

WARNING: **`EventMap.tsx` must import `leaflet/dist/leaflet.css` itself; it cannot
rely on `LiveMap.tsx`.** `LiveMap` is a lazy route (`App.tsx`), so Vite emits its
`leaflet.css` import into that route's CSS chunk -- a separate asset that
`/calendar` never loads. The symptom is not a missing-map-API error:
React-Leaflet builds the full pane/tile DOM and the tiles do load, but with
`.leaflet-pane` computing to `position: static` instead of `absolute`, so the
tiles lay out in normal flow far below the container and the map appears blank or
scrambled inside its 180px box. Verified in a browser against the built site:
`.leaflet-pane` was `static` and tiles sat at y=363..1131 for a container at
y=453..633; after the import, `absolute` and the marker centres exactly on the
container. Vite dedupes the shared sheet, so the second import adds no bytes.

`src/test/components/EventMap.test.tsx` covers the geocode/marker/directions/
no-result/error/stale-response cases plus a **source-level guard** that the
stylesheet import is still present. That guard exists because neither half of
this bug is observable from a render test: Jest stubs stylesheets out via
`moduleNameMapper`, and the Leaflet mocks render plain divs regardless of CSS.
Anchor the check to a trimmed line equal to `import "leaflet/dist/leaflet.css";`
-- a regex allowing leading whitespace also matches the commented-out form, so it
passed even with the import disabled.

## Key exports in `src/lib/discord.ts`

- `EVENTS_URL` -- base Worker URL (from `globalThis.__VITE_EVENTS_URL__` or a placeholder default; override with the `VITE_EVENTS_URL` env var).
- `EVENTS_ICS_URL` -- `${EVENTS_URL}/calendar.ics`, the subscribable feed URL.
- `webcalUrl()` -- the `webcals://` form of `EVENTS_ICS_URL`.
- `DISCORD_GUILD_ID` -- public guild id used to deep-link chips to Discord. Keep in sync with `DISCORD_GUILD_ID` in `worker/wrangler.jsonc`.
- `fetchEvents(signal?)` -- GET with `cache: "no-store"`, returns `CalendarEvent[]`. Structural-invalid payloads degrade to `[]` rather than throwing; HTTP/network errors throw `DiscordError`. When the API `location` is null, the event is enriched via `extractLocationFromDescription` (team events are voice-channel events for role-scoped signup, so Discord's `entity_metadata.location` is always empty and the physical location lives in the description).
- `isCalendarEvent` validates **both** `recurrenceRule`'s type and its content: it must be null or a string matching `/^FREQ=/i`. A rule that fails this is dropped along with its event, because the alternative is a value `rrulestr` throws on -- and `expandRecurrences` catches that and silently falls back to a single occurrence, i.e. a wrong result rather than a visible failure.
- `fetchEvents` **derives `isRecurring` from `recurrenceRule`** rather than trusting the flag. The two fields are redundant, so a payload where they disagree would otherwise render an event chip as recurring while its occurrences collapse to one. Don't "simplify" this back to reading `isRecurring` directly.
- `CalendarEvent.channelId` is **optional** (`channelId?: string | null`) so `isCalendarEvent` still accepts an older Worker's payload; `channelKeyFor` falls back to the Other bucket.
- `extractLocationFromDescription(description)` -- returns `{ location, description }`: pulls the location out of an explicit labeled line and strips that line from the description so the modal doesn't render it twice.
  - WARNING: **The ONLY accepted form is a labeled line.** The value must be on a line matching `/^\s*(?:location|where)\s*[:\u2013\u2014-]\s*(.+)$/i` (so `Location: Lavery Hall 335`, `Where: **Lavery Hall 335**`, `Location - ...` all work; leading markdown emphasis is stripped from the value). Anything else means **there is no location**. This is an explicit team contract, quoted from the maintainer: *"the location will only ever be formatted like `Location: Example Location or a link` / if its not in this format, there is no location"*.
  - Do **not** reintroduce a "first bold span" fallback or any similar guess. A bare bold span carries no signal -- the team bolds the venue (`**Lavery Hall 335**`) but also bolds emphasis (`**This event is completely optional.**`). A previous heuristic gate (`looksLikeLocation()`, a word-list + punctuation filter) was written to contain that class of bug and then **deleted** when the maintainer confirmed the labeled-only contract; guessing is now out of scope, not merely guarded. A heuristic false negative also silently hid real venues, which the explicit label never does.
  - A labeled line with an empty value (`Location:`) yields `location: null`, and the line is still removed from the description.
- `isLocationUrl(location)` -- `true` only when the whole trimmed value is a bare `http(s)://` URL (so `https://us02web.zoom.us/j/123`, but not `www.example.com`, `https://` with no host, or `see https://example.com`). The location value is a *place* or a *link*; `EventModal` uses this to render links as a `target="_blank"` anchor and to **skip the Nominatim geocode + embedded map** for them -- a URL can never resolve spatially, so geocoding one is a wasted request per modal open.
- `expandRecurrences(events, from, to, now?)` -- expands every RRULE event into concrete occurrences inside `[from, to]`. Malformed RRULEs fall back to a single occurrence at the base start. `now` is injectable (defaults to `new Date()`) solely so the cancelled-series clip is deterministic under test; `Calendar.tsx` passes its tracked `now` state so the clip follows the same clock as the "today" highlight.
- `describeRecurrence(event)` -- renders the human-readable repeat line shown in `EventModal` under the date/time row (see below).
- `discordEventUrl(event)` -- `https://discord.com/channels/<guildId>/<eventId>`.

## Client-side recurrence expansion

The Worker converts Discord's structured `recurrence_rule` object into an RFC 5545
RRULE body once, at its boundary; `CalendarEvent.recurrenceRule` is that
already-converted string. See "Recurrence expansion" in
`discord-events.instructions.md` for the conversion rules, the Discord field
table, and why the raw field must never be read as a string. This section covers
what the website does with the string.

Every occurrence inside the current month grid becomes one chip; each occurrence's
`end` is shifted by the base event's duration so multi-hour meetings keep their
length.

**Per-occurrence cancellation.** The parser and its outputs live in the Worker;
the website's job is to RENDER a cancelled occurrence rather than hide it:

| Consumer | Behaviour | Why |
| --- | --- | --- |
| `GET /events` | `cancelledDates: string[]` | the parsed data, plus `description` with the note removed |
| Website (`expandRecurrences`) | **renders** the occurrence, flagged `isCancelled: true` | a visitor scanning the grid benefits from seeing that a meeting was called off |
| `.ics` feed (`ics.ts`) | **omits** it via `EXDATE`, only when an RRULE is present | a subscriber's calendar should stay clean -- a called-off meeting just disappears |

WARNING: Because the website and the feed differ, `isCancelled` and "is this in the
feed" are NOT the same question. `ExpandedOccurrence.isCancelled` always exists
(`boolean`, never `undefined`) because the chip/dot styling reads it directly -- a
missing field would silently render a cancelled occurrence as normal.

WARNING: Occurrence matching uses the **local** calendar day (`localDateKey`), not
UTC. Notes are written the way the grid displays them, so a 23:00Z meeting must
match by its local date or the exclusion silently misses.

**Styling.** The cancelled treatment uses `--color-cancelled` (an alias of
`--vt-impactOrange`, the brand's sanctioned digital-text orange). It is
deliberately not `--color-accent`, and not the muted grey used by
`calendar-event--completed`: a cancelled meeting must not read as a normal event
with most of the styling applied. `eventChipClassName(occurrence)` takes the
whole occurrence (not just the event) because two independent notions of
"cancelled" meet there:

- `occurrence.isCancelled` -- this one occurrence was cancelled via the note.
- `event.status === "canceled"` -- the whole series was cancelled in Discord.

Both get the same treatment (to a reader they mean the same thing) but the modal
distinguishes them (see "Event detail modal"). The mobile day-cell dots and the
agenda rows reuse the same helper, so all three surfaces stay in sync.

**Whole-series cancellation** is clipped at `now` -- occurrences that already
happened still render (the cancellation is worth seeing), later ones are never
generated. Without this the series would project struck-through chips into every
future month forever, because `CANCELED` is terminal and the RRULE carries no
`UNTIL` (`end` is always null in practice). The clip is `Math.min(to, now)`; when
the window is entirely in the past it resolves to `to`, so historical months
still expand normally. NOTE: the `.ics` feed deliberately does the opposite
(keeps the series, `STATUS:CANCELLED`, RRULE intact) -- see
`discord-events.instructions.md`.

`status: "completed"` gets a muted chip on the website but is **not** clipped: a
completed event is not recurring (Discord only auto-completes an occurrence), so
the status is inert for expansion.

`describeRecurrence(event)` renders the human-readable repeat line shown in
`EventModal` under the date/time row ("Every week on Wednesday", "Every month on
the 4th Wednesday"). It returns `null` for a non-recurring event so the caller can
render it conditionally, and it delegates the phrasing to the `rrule` package's
own `toText()` rather than hand-rolling a translation table -- `toText` already
covers intervals, ordinal weekdays, month+day, and the "every weekday" special
case, and stays consistent with what `expandRecurrences` actually produces. Only
the first letter is capitalized; `toText`'s weekday/month names are already
capitalized.

WARNING: `describeRecurrence` explicitly requires the body to start with `FREQ=`
before calling `rrulestr`. A rule without one does **not** throw -- `rrulestr`
silently defaults to `FREQ=YEARLY` -- so without that check a malformed rule would
be described as "Every year" instead of admitting the rule is unreadable.

## Route wiring

For a new page, register the route in `src/App.tsx` and `scripts/spa-fallback.mjs`
(see `deploy.instructions.md`). The `/calendar` route specifically is registered in
four places, all of which MUST stay in sync:
1. `src/App.tsx` -- `<Route path="/calendar" element={<Calendar />} />`.
2. `src/lib/seoRoutes.json` -- its title/description/canonical/sitemap entry
   (`scripts/spa-fallback.mjs` derives its route list from this JSON, so the SPA
   fallback follows automatically).
3. `README.md` -- routes table + `VITE_EVENTS_URL` env var description.
4. `src/pages/OtherPages.tsx` -- `FEATURE_PAGES` entry so the Other Pages hub links to it.

WARNING: `/calendar` is deliberately **not** in `NAV_LINKS`. It's reachable directly at
`/calendar` and from the `/other-pages` hub. Adding it back to the nav would blow
the five-link width budget (see `AGENTS.md`).

Drop any of the four and the route breaks in a different way (client-side vs S3
vs hub vs docs).

WARNING: **`/calendar/officers` is the exception to all four.** It needs only #1 and #2
-- it must NOT be added to `NAV_LINKS`, `FEATURE_PAGES`, or advertised in the
README routes table, because those are all public surfaces. It shares the
`Calendar` component via the `variant="officer"` prop rather than being a separate
calendar implementation, and is a **flat route nested by URL only** (no `<Outlet>`;
React Router ranks by specificity, so it beats `/calendar` regardless of order).
If you ever "tidy up" the route tables by copying the `/calendar` pattern, you
will publish the officer calendar's address to the whole site.

The heading is emitted conditionally for the same reason: `Calendar.tsx` renders
`{variant === "public" && <h1 className="sr-only">Calendar</h1>}`, because
`Officers.tsx` wraps it in its own `<h1>Officers Calendar</h1>`. An unconditional
h1 would put two on that page. Guarded by `src/test/pages/headings.test.tsx`.

## Tests

- `src/test/lib/discord.test.ts` -- `fetchEvents` (happy/error/malformed/abort cases, mock fetch with duck-typed responses), the `isCalendarEvent` guard (a structured-object `recurrenceRule` and an unusable RRULE body are both rejected; a valid recurring event survives), `isRecurring`-vs-`recurrenceRule` reconciliation in both disagreement directions, `extractLocationFromDescription` (a labeled place, a labeled URL, a bolded labeled value, an empty labeled value, an unlabeled bold span left completely intact, an `it.each` of unlabeled spans including real venues such as `Lavery Hall 335`/`Newman Library`/`1830 Alumni Mall` asserting `location: null` with the description unchanged, and no-labeled-line), `isLocationUrl` (schemes, path/query/fragment, surrounding whitespace vs the non-URL cases `www.example.com`, bare `https://`, and `see https://example.com`), `describeRecurrence` (weekly, every-other-week, weekday set, monthly Nth-weekday, yearly month+day, bare frequency, capitalization, and the null cases: non-recurring, missing rule, unparseable rule, and a rule with no `FREQ`), `expandRecurrences` (weekly, daily, UNTIL clip, malformed-RRULE fallback, duration shift, sort order), the **cancelled-series clip** (a mid-series `now` keeps only past occurrences, a `now` before the series yields none, a `scheduled` event keeps the full window, and a `now` past the window leaves the historical range intact), and the subscribe URL helpers (`EVENTS_ICS_URL`, `webcalUrl`). Note its fixtures feed `expandRecurrences` already-converted `recurrenceRule` strings (the client-side shape) rather than raw Discord payloads -- the raw-payload path is covered by `src/test/worker/events.test.ts`.
- `src/test/lib/eventChannels.test.ts` -- `eventChannelGroups` (subteams get a checkbox, always-visible channels do not, channel-less events land in "Other"), `matchesChannelFilter` (null selection shows everything, empty set shows none, always-visible channels ignore a narrowed selection), `toggleChannel` (materializes before subtracting, collapses a full set back to `null`), `workerChannelIds` (adds the always-visible ids, returns `[]` for `null`, drops the "Other" key), and `subteamSlugFor`/`slugForChannel`.
- `src/test/lib/feedUrls.test.ts` -- the feed-URL helpers used by the Subscribe panel.
- `src/test/pages/Calendar.test.tsx` -- page render states (loading, success, error, empty), chip rendering with real Discord URL, recurrence expansion, month nav, error-card behavior, the subscribe control, the `EventModal` repeat line (present directly after the date/time row for a recurring event, absent for a one-off), a **URL-valued location** case (renders a `target="_blank"` `rel="noopener noreferrer"` anchor, renders no map, and fires exactly one fetch -- i.e. the link is never sent to Nominatim), a **per-occurrence cancellations** block (the cancelled chip gets `calendar-event--canceled` and is still rendered, a non-cancelled occurrence is not flagged, the modal shows "This occurrence was cancelled" vs "This event was cancelled" for a whole-series cancel, and a normal event shows neither), a "Calendar subteam colors" describe (slug per chip, chips differ, non-subteam uses the default, cancelled keeps its slug), plus a "mobile branch" describe block (matchMedia stubbed to `matches: true`) covering day-cell buttons, dots, the agenda swap, agenda->modal, and selection-on-month-nav. The modal recurrence test uses a **monthly** rule so the grid renders exactly one chip -- a weekly rule yields several with the same accessible name, which breaks `getByRole`.
- `src/test/pages/Officers.test.tsx` -- that the page requests the **officer** route specifically (compared as a full URL, since the public route is a substring-compatible neighbour), the subscribe control points at the officer `.ics` (and NOT the public one), the webcal URL derivation, the accessible heading, and that the path stays unlisted (absent from `Header.tsx`, `OtherPages.tsx`, and the README routes table -- the banner that used to state this was removed, so this is now the only guard).
- `src/test/components/CalendarSubscribe.test.tsx` -- panel open/close, provider URLs, `.ics` download, and clipboard copy (async Clipboard API, `execCommand` fallback, and rejection handling).
- `src/test/components/CalendarFilter.test.tsx` -- the picker: one row per group with no event counts (and no count badge on the toggle in any state), the swatch carrying each group's own `subteam--<slug>` class and hidden from assistive tech, the default all-checked state, emitting the complement when one group is unchecked and the union when one is added, reaching "all" by checking the last remaining group, no "All subteams" reset control, the toggle disabled while there is nothing to group, and both halves of the dropdown mutual exclusion (closes when the other header dropdown opens, stays open on its own announcement).
- `src/test/components/EventModal.test.tsx` -- the officer delete control: absent when nobody is signed in, present for a signed-in officer, the confirmation step (and cancelling out of it), close-and-refresh after a successful delete, the "deletes the whole series" warning for a recurring event, a refusal surfaced instead of a silent failure, and a pending confirmation cleared when a different event opens.
- `src/test/components/EventMap.test.tsx` -- the embedded map: geocoding via Nominatim (query encoding + the required `User-Agent`), the marker landing on the resolved coordinates, the Google Maps directions link, no map when nothing matches, no map on a fetch failure, a stale-response case (the previous location's late reply must not overwrite the current one), plus the `EventMap stylesheet` block described above.

WARNING: **Test-anchor lesson.** Prefer a heading / structure (`getByRole("heading", { name: "Subteams" })`) over free copy. Anchoring on the filter's intro sentence broke four tests when the user reworded it.

WARNING: **Test-date trap.** Events placed in "next month" still land in the current month grid's +/-1-week recurrence padding. Use a full YEAR out (`farFuture()` in `Calendar.test.tsx`) when a test needs an event that is definitely off-grid.

Calendar tests follow the `LiveMap.test.tsx` patterns: `MemoryRouter` wrap,
`mockFetchOnce` / `mockFetchSequence`, `flushMicrotasks()` to drain the `.then()`
chain, restore `global.fetch` in `afterEach`.

WARNING: Jest's default cache directory resolves under `.vscode/tmp` in this
environment, which the terminal sandbox blocks (`EPERM: operation not permitted,
realpath`). If `bun run test` fails that way, run
`npx jest --cache-directory "$TMPDIR/jest-cache"` instead.
