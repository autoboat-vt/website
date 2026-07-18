# Website for Virginia Tech's AutoBoat team

This website is built with **React** + **TypeScript** and **Vite**, using `react-router-dom` for client-side routing. All original HTML/CSS/JS has been ported into reusable, type-safe React components.

## File Layout

-   `index.html`: Vite entry HTML (mounts the React app)
-   `src/`: React application source
    -   `main.tsx`: App entry point (renders `<App />` into `#root`)
    -   `App.tsx`: Route definitions and layout (Header / main / Footer)
    -   `app.css`: Tailwind CSS entry point (theme tokens, base styles, and component-layer CSS for complex selectors like hero animations, hotspots, and the mobile nav dropdown)
    -   `vite-env.d.ts`: Vite client type declarations
    -   `components/`: Shared UI components (`Header`, `Footer`, `Card`, `Gallery`, `ImageModal`)
    -   `pages/`: One component per route (`Home`, `OurTeam`, `Fleet`, `HowToJoin`, `Sponsors`, `Gallery`)
-   `public/`: Static assets served as-is
    -   `images/`: All site images (gallery, team, favicon, etc.)
-   `archive/original-site/`: The original raw HTML/CSS site, kept for reference
-   `tsconfig.json` / `tsconfig.node.json`: TypeScript configuration
-   `vite.config.ts`: Vite configuration
-   `package.json`: Dependencies and scripts

## Routes

| Path          | Page         |
| ------------- | ------------ |
| `/`           | About (Home) |
| `/ourteam`    | Meet the Team |
| `/fleet`      | Our Fleet    |
| `/how-to-join`| How To Join  |
| `/sponsors`   | Sponsors     |
| `/gallery`    | Gallery      |

## Running for Development

Requires Node.js 18+.

```bash
npm install      # install dependencies (first time only)
npm run dev      # start the Vite dev server at http://localhost:3000
```

The dev server supports hot module replacement (HMR) — edits to components
appear instantly in the browser.

## Type Checking

```bash
npm run typecheck  # run `tsc` in noEmit mode to type-check the project
```

## Building for Production

```bash
npm run build    # type-checks with `tsc` then outputs static files to dist/
npm run preview  # preview the production build locally
```

The `dist/` folder contains the deployable static site.

## Deploying the Website

The website is hosted via Virginia Tech's site hosting platform at
[autoboat.aoe.vt.edu](https://autoboat.aoe.vt.edu/). The VT host serves static
files from the root of a GitLab repo (`code.vt.edu/s4-hosting-sites/aoe/sailbot`)
with **no build step**, so the repo's root must contain the *built* files from
`dist/`, not the React source.

The source-of-truth `main` branch lives on **GitHub**
(`github.com/autoboat-vt/website`). The `main` branch on the **VT GitLab** is
the deploy target: each deploy adds a commit on top of `main` whose tree
contains only built files (source is removed from the index, but history is
preserved). This means every push is a **fast-forward** — no force-push
required, and `main` can stay protected.

### One-time setup

1. Add the VT remote (contact the Software Officer for access):

   ```bash
   git remote add aoe_sites ssh://git@code.vt.edu/s4-hosting-sites/aoe/sailbot
   ```

2. If you develop on GitHub, set up a mirror so source pushes to `main` flow
   through to the VT GitLab and trigger CI:
   **Settings → Repository → Mirror repository** → pull from
   `github.com/autoboat-vt/website`.

### Deploying

**Automated (GitLab CI):** The `.gitlab-ci.yml` pipeline runs on every push to
`main` on the VT GitLab project. It builds the site and pushes the built files
as a regular commit on top of `main` (fast-forward, no force-push). You can
also trigger it manually from the GitLab UI (CI/CD → Pipelines → Run pipeline).

**Manual (local script):** For debug or one-off deploys:

```bash
./scripts/deploy.sh
```

This runs `bun run build`, fetches the latest `aoe_sites/main`, creates a
worktree based on it, replaces all contents with the built `dist/` files
(`index.html`, `assets/`, `images/`, `_redirects`), commits, and pushes as a
fast-forward to `aoe_sites/main`. The source repo (`origin` on GitHub)
is untouched.

To deploy an existing `dist/` without rebuilding:

```bash
./scripts/deploy.sh --skip-build
```

> **Note:** Because this is a single-page app (SPA), the hosting platform
> must redirect all routes to `index.html` so client-side routing works on
> direct URL visits. A `public/_redirects` file is included for hosts that
> respect it (e.g. Netlify-style). If Virginia Tech's host uses `.htaccess`
> or similar, add an equivalent rewrite rule.

## Continuous Integration

A GitHub Actions workflow (`.github/workflows/build.yml`) runs on every push
to `main` and on pull requests. It uses [Bun](https://bun.sh/) to install
dependencies, type-check, and build the site, then uploads `dist/` as a build
artifact.

While npm is the default for local development, Bun is fully compatible and
can be used as a faster drop-in replacement:

```bash
bun install      # install dependencies
bun run dev      # start the dev server
bun run build    # type-check and build for production
```

A separate workflow (`.github/workflows/manual.yml`) automatically converts
new PNG/JPG images under `images/` to WebP format in place on push.
