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

2. For automated deploys from GitHub Actions, add the following repository
   secrets/variables (GitHub repo **Settings → Secrets and variables → Actions**):

   - **Secret `AOE_SITES_SSH_KEY`** — private SSH key authorized to push to
     `code.vt.edu/s4-hosting-sites/aoe/sailbot`. Generate one with
     `ssh-keygen -t ed25519 -f aoe_sites_deploy` and add the public key to a
     VT GitLab deploy key for the `sailbot` project.
   - **Variable `AOE_DEPLOY_ENABLED`** — set to `true` to enable the deploy
     step. Without this, the workflow only builds and uploads the artifact.
     (Lets forks and PRs run the build without attempting to deploy.)

### Deploying

**Automated (GitHub Actions):** The `.github/workflows/build.yml` workflow
runs on every push to `main`. It builds the site and, when
`AOE_DEPLOY_ENABLED=true`, runs `scripts/deploy.sh --skip-build` to push the
built files as a fast-forward commit on top of `aoe_sites/main` (no force-push).
You can also trigger it manually from the GitHub Actions UI (**Run workflow**).

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
to `main`. It uses [Bun](https://bun.sh/) to install dependencies, type-check,
and build the site, then uploads `dist/` as a build artifact. When the
`AOE_SITES_SSH_KEY` secret and `AOE_DEPLOY_ENABLED=true` variable are
configured, it also deploys the build to the VT GitLab (see **Deploying**
above).

While npm is the default for local development, Bun is fully compatible and
can be used as a faster drop-in replacement:

```bash
bun install      # install dependencies
bun run dev      # start the dev server
bun run build    # type-check and build for production
```

A separate workflow (`.github/workflows/manual.yml`) automatically converts
new PNG/JPG images under `images/` to WebP format in place on push.
