# AutoBoat @ Virginia Tech — Website

React + TypeScript + Vite site for Virginia Tech's AutoBoat team, styled with Tailwind CSS v4 and routed with `react-router-dom`.

## Structure

- `src/main.tsx` — app entry (renders `<App />` into `#root`)
- `src/App.tsx` — routes and layout (Header / main / Footer)
- `src/app.css` — Tailwind entry, theme tokens, component-layer CSS
- `src/components/` — shared UI (`Header`, `Footer`, `Card`, `Gallery`, `ImageModal`)
- `src/pages/` — one component per route (`Home`, `OurTeam`, `Fleet`, `HowToJoin`, `Sponsors`, `Gallery`)
- `public/images/` — site images
- `scripts/deploy.sh` — manual deploy to VT GitLab (see below)

## Routes

| Path           | Page          |
| -------------- | ------------- |
| `/`            | About (Home)  |
| `/ourteam`     | Meet the Team |
| `/fleet`       | Our Fleet     |
| `/how-to-join` | How To Join   |
| `/sponsors`    | Sponsors      |
| `/gallery`     | Gallery       |

## Commands

Requires Node.js 18+. Bun is the default runner; npm works too.

```bash
bun install            # install deps
bun run dev            # dev server at http://localhost:3000
bun run build          # production build → dist/
bun run preview        # preview the build
bun run lint           # biome lint
bun run test           # jest unit tests
bun run test:watch     # jest watch mode
```

## Deploying

The site is hosted at [autoboat.aoe.vt.edu](https://autoboat.aoe.vt.edu/), served from the VT GitLab repo `code.vt.edu/s4-hosting-sites/aoe/sailbot`. The VT host serves static files with **no build step**, so deploys push the *built* `dist/` contents (not source).

Source-of-truth `main` lives on GitHub (`autoboat-vt/website`). Each deploy fast-forwards a commit containing only built files onto VT GitLab's `main` — no force-push.

One-time setup (contact the Software Officer for access):

```bash
git remote add aoe_sites ssh://git@code.vt.edu/s4-hosting-sites/aoe/sailbot
```

Deploy from a local checkout:

```bash
./scripts/deploy.sh              # build + deploy
./scripts/deploy.sh --skip-build # deploy an existing dist/
```

The script builds, fetches `aoe_sites/main`, replaces the worktree contents with `dist/`, commits, and fast-forward pushes.

> **SPA routing:** `scripts/spa-fallback.mjs` (chained to `build`) copies `index.html` to each route path so client-side routing works on direct visits. `public/_redirects` covers hosts that respect it.

## CI

`.github/workflows/build.yml` runs on push to `main` and on PRs — installs deps, builds, uploads `dist/` as an artifact. Deploys to VT GitLab are manual (see above). `.github/workflows/manual.yml` auto-converts new PNG/JPG images under `images/` to WebP on push.

