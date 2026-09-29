# AutoBoat @ Virginia Tech — Website

React + TypeScript + Vite site for Virginia Tech's AutoBoat team, styled with Tailwind CSS v4 and routed with `react-router-dom`. Deployed to [autoboat.aoe.vt.edu](https://autoboat.aoe.vt.edu/) via VT's S4 (Static Site Storage) service backed by Amazon S3.

> **Contributing?** See [`AGENTS.md`](./AGENTS.md) for project conventions, file-naming rules, config gotchas, and working-style notes. This README is a quick-start overview.

## Routes

| Path           | Page          |
| -------------- | ------------- |
| `/`            | About (Home)  |
| `/ourteam`     | Meet the Team |
| `/fleet`       | Our Fleet     |
| `/sponsors`    | Sponsors      |
| `/other-pages` | Other Pages   |
| `/live`        | Live Boat Map |
| `/calendar`    | Calendar      |
| `/gallery`     | Gallery       |

Per-route `<title>`, description, canonical URL, and social tags all come from
one file, `src/lib/seoRoutes.json`. Add a route there (and register it in
`src/App.tsx`) and the SPA fallback, the sitemap, and the metadata follow. See
"SEO" in [`AGENTS.md`](./AGENTS.md).

The top nav only carries the five primary pages (`/`, `/ourteam`, `/fleet`,
`/sponsors`, `/other-pages`). `/live`, `/calendar`, and `/gallery` are still public
routes reachable directly by URL — `/other-pages` is the hub that links to them.

The `/calendar` page reads events from a Cloudflare Worker in `worker/`
(proxies Discord's guild scheduled-events API without exposing the bot
token). It also serves a subscribable iCalendar feed at
`GET /calendar.ics`, so the calendar can be added to Google Calendar, Apple
Calendar, or Outlook; the page's **Subscribe** control links to it. See
`worker/README.md` for the one-time setup.

Officer-only events are kept off the public calendar. An event is internal when
it was scheduled in the officer voice channel (`OFFICERS_CHANNEL_ID`), so the
Worker classifies each event by its channel and serves the full set only on
`/officers/*`. That route is **unlisted but not access-controlled** — anyone
with the link can read it — so it is intentionally absent from the table above
and from the site nav. See "Audience gating" in
`.github/instructions/discord-events.instructions.md`.

The **Filter** control on `/calendar` narrows the calendar to one or more
**subteams**, grouping events by the Discord voice channel they were scheduled
in. Only subteam events can be filtered: general member events are always
shown, and officer events are always shown on the page that reaches them. The
same selection is applied to the subscription feed via a `?channels=` query
parameter, so a user can subscribe to just their subteam. Events are also
**color-coded by subteam** -- on the grid chips, the mobile day dots, and the
swatch beside each filter row -- so a subteam is recognizable at a glance. See
"Channel filter" and "Subteam colors" in
`.github/instructions/discord-events.instructions.md`.

## Environment variables

Set these before `bun run dev` or `bun run build`:

- `VITE_TELEMETRY_URL` — base URL for the live-boat telemetry API. Falls
  back to the production telemetry server if unset.
- `VITE_EVENTS_URL` — base URL for the Discord events Cloudflare Worker
  (`<worker>.workers.dev`, no trailing slash). Falls back to the placeholder
  in `src/lib/discord.ts` if unset. Point this at `http://localhost:8787`
  while running `npx wrangler dev` in `worker/` for local end-to-end work.

## Quick start

Requires Node.js 18+. [Bun](https://bun.sh) is the default runner (npm/yarn also work).

```bash
bun install            # install deps
bun run dev            # dev server at http://localhost:3000
bun run build          # production build -> dist/
bun run preview        # preview the build
bun run test           # jest unit tests
bun run lint           # biome lint
```

## Deploying

Deployment is manual via `./scripts/deploy.sh` from a local checkout with VT GitLab credentials cached and Cloudflare auth configured. There is no CI deploy — GitHub Actions does build-only validation on PRs.

The script deploys **both artifacts**: the static site to VT S4/S3, and the Cloudflare Worker in `worker/` to Cloudflare.

```bash
./scripts/deploy.sh               # build + deploy site and Worker
./scripts/deploy.sh --skip-build  # deploy an existing dist/
./scripts/deploy.sh --skip-worker # site only; leave the Worker untouched
```

The script builds, deploys the Worker (via `wrangler deploy`, using `bunx` or `npx`), fetches `aoe_sites/main`, replaces the worktree contents with `dist/`, commits, and fast-forward pushes to `code.vt.edu/s4-hosting-sites/aoe/sailbot`. The S4 service then syncs `main` to S3 (a few minutes).

The Worker deploy runs first, before either push, so expired Cloudflare auth fails before anything is published.

One-time setup (contact the Software Officer for VT GitLab access):

```bash
git remote add aoe_sites ssh://git@code.vt.edu/s4-hosting-sites/aoe/sailbot
```

One-time setup (contact the Software Officer for VT GitLab access):

```bash
git remote add aoe_sites ssh://git@code.vt.edu/s4-hosting-sites/aoe/sailbot
```
