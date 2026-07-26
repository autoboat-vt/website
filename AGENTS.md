# AGENTS.md

Guidance for AI coding agents working in the `autoboat-website` repository.

## Maintaining This File

**This file is the living source of truth for project knowledge.** `README.md` is a short quick-start overview; everything else lives here. **Update this file frequently and proactively** — every time you learn something new, change a convention, fix a gotcha, bump a version, add a route, or discover a footgun. Treat maintenance as a continuous duty, not a one-time write: a stale `AGENTS.md` is worse than none because it actively misleads the next agent.

When you discover or establish new project information, **add it to this file** (for always-relevant conventions) or to a `.github/instructions/*.instructions.md` file (for topic-specific details that only apply when editing certain files — see "On-demand instructions" below). When you CHANGE something (refactor, rename, remove a file, alter a config, fix a bug that was documented as a workaround), **update the corresponding entry in the same change** — don't let the docs drift from the code. Things worth recording:

- **Conventions & patterns** — naming, file organization, import rules, component patterns that aren't obvious from one file.
- **Gotchas** — non-obvious behavior, footguns, environment quirks, config discovery issues (e.g. the Biome `--config-path` gotcha, Tailwind v4 layer cascade).
- **Architecture decisions** — why a component is structured a certain way, data flow, key constants and their rationale.
- **Build/deploy/CI details** — commands, env vars, auth requirements, what runs where.
- **Verified facts** — dependency versions, route tables, token scopes (verify against the actual codebase before recording, don't trust stale docs).

When adding to this file:

1. **Find the right section.** Use the existing structure (see the section headings). Add a subsection under the most relevant top-level section rather than appending to the end.
2. **Be concise.** Bullet points and short prose, not essays. Link to files/symbols with backticks.
3. **Don't duplicate.** Search the file first (`grep_search` for the key term) — if it's already covered, edit/update rather than adding a parallel entry. If a topic only applies when editing specific files, put it in a `.github/instructions/*.instructions.md` file instead of here (see "On-demand instructions").
4. **Keep it accurate and in sync.** If you correct a stale claim, update it in place. Verify versions/paths against `node_modules/` or the actual source before recording them as fact. **When you change code or config that this file describes, update the relevant entry in the same change** — don't leave the docs describing the old behavior. Err on the side of updating too often rather than too little.
5. **Don't move or rewrite unrelated sections** unless asked — make targeted additions/edits.

If a new topic doesn't fit any existing section, add a new `## Section` in a sensible position (e.g. architecture topics near the top, operational topics near the deploy/CI sections).

## Project Overview

React + TypeScript + Vite website for Virginia Tech's AutoBoat team. Styled with Tailwind CSS v4, routed with `react-router-dom`, linted with Biome, tested with Jest. Deployed to `autoboat.aoe.vt.edu` via VT's S4 (Static Site Storage) service backed by Amazon S3.

## Essential Commands

```bash
bun install            # install deps (also activates git hooks via `prepare`)
bun run dev            # dev server at http://localhost:3000
bun run build          # production build → dist/ (+ SPA fallback copies)
bun run test           # jest unit tests
bun run test:watch     # jest watch mode
bun run lint           # biome lint (MUST use --config-path=./biome.json)
bun run format         # biome format --write
bun run check          # biome check (lint + format)
bun run check:write    # biome check --write (auto-fix)
```

Prefer `bun` over `npm`/`yarn`. Node.js 18+ required.

## Tech Stack

- **React 19** + **Vite 8** + **TypeScript 7** (no `tsc` in build — editor support only)
- **Tailwind CSS v4** (CSS-first config via `@tailwindcss/vite`, no `tailwind.config.js` JS config)
- **Biome 2.5.4** (lint + format, single config at `./biome.json`)
- **Jest 30** with `@swc/jest` for TS/JSX transform, `jest-environment-jsdom`
- **react-router-dom 7** for routing
- **Leaflet 1.9 + react-leaflet 5** for the live map at `/live`
- **lucide-react** + **react-icons** for icons
- ESM project (`"type": "module"`)
- All deps in `package.json` are pinned to `"latest"` (floating) — `bun install` resolves at install time. Lockfile is `bun.lock`.

## Repository Structure

```
src/
  main.tsx              # app entry
  App.tsx               # routes + layout (Header / main / Footer)
  app.css               # Tailwind entry, theme tokens, component-layer CSS
  components/           # shared UI (Header, Footer, Card, Gallery, etc.)
  pages/                # one component per route (Home, OurTeam, Fleet, ...)
  hooks/                # useBoatHistory, useTheme
  lib/                  # telemetry.ts (REST client), vtColors.ts
  test/                 # jest tests + __mocks__/
scripts/
  deploy.sh             # manual deploy to VT GitLab (S4 → S3)
  spa-fallback.mjs      # copies index.html to route paths for S3 SPA routing
  bump-cicd.sh          # manual submodule pointer bump
external/cicd/          # READ-ONLY git submodule (VT S4 CI templates, owned upstream by s4-hosting-sites/cicd on code.vt.edu)
public/                 # static assets, _redirects, images
.github/instructions/   # on-demand instruction files (*.instructions.md) — loaded by Copilot when matching files are edited
```

## Routes

| Path        | Page          | NavLink label  |
| ----------- | ------------- | -------------- |
| `/`         | Home (About)  | "About"        |
| `/ourteam`  | Our Team      | "Meet the Team" |
| `/fleet`    | Our Fleet     | "Our Fleet"    |
| `/live`     | Live Boat Map | "Live Map"     |
| `/sponsors` | Sponsors      | "Sponsors"     |
| `/gallery`  | Gallery       | (not in nav)   |

NavLink items are defined in `src/components/Header.tsx` as `NAV_LINKS`. The home link uses `end: true` (react-router's `end` prop) so it's only active on exact `/`. `/gallery` is reachable from `Home` and `OurTeam`, not from the nav.

If you add a route, update **all three**: `src/App.tsx`, `scripts/spa-fallback.mjs` route list, and the README routes table. The `scripts/spa-fallback.mjs` `ROUTES` array must mirror the routes in `App.tsx` exactly — S3 returns 404 for any route not listed.

## Navigation constants

- **`NAV_LINKS`** (`src/components/Header.tsx`): `[{ to, label, end? }]` — the top nav. Order matters (rendered left-to-right).
- **`FOOTER_LINKS`** (`src/components/Footer.tsx`): `[{ href, label, icon }]` — footer social/external links. External links get `target="_blank"` `rel="noopener noreferrer"` + an sr-only "(opens in a new tab)" span. Footer links have no visible text (icon + sr-only label) — tests must query with `getByRole("link", { name: /^label$/i })`, not `getByText`.

## On-demand instructions

Detailed, topic-specific guidance lives in `.github/instructions/*.instructions.md` files. Copilot auto-loads these when you edit files matching their `applyTo` patterns (and they can also be discovered on-demand via their `description`). This keeps `AGENTS.md` lean and avoids loading detailed reference material into context when it's not relevant.

| File | Applies to | Covers |
| --- | --- | --- |
| `telemetry.instructions.md` | `src/lib/telemetry.ts` | Typed REST client API, wire format (BoatStatus/Sailboat/Motorboat payloads), GPS sentinel, `BoatWithPosition` type, `useBoatHistory` hook |
| `live-map.instructions.md` | `src/pages/LiveMap.tsx`, `src/components/Boat*.tsx`, `src/components/Waypoints.tsx`, `src/components/TrendPlot.tsx`, `src/hooks/useBoatHistory.ts` | Polling, in-flight cancellation, visibility-aware polling, boat selection, `CenterOnFirstData`/`RecenterOnTrigger`/`ScaleControl`, MapTiler tiles, `BoatMarker` rotationAngle imperative-update gotcha |
| `css.instructions.md` | `src/app.css`, `src/components/BoatDetails.tsx` | Tailwind v4 layer cascade, utilities-beats-components gotcha, `!important` layer reversal, shorthand syntax, `app.css` file structure, `transform: scale()` footgun, hash-link navigation |
| `components.instructions.md` | `src/components/Card.tsx`, `src/components/Gallery.tsx`, `src/components/ImageModal.tsx`, `src/components/Hyperlink.tsx`, `src/pages/**` | `Card`, `Gallery`, `ImageModal`, `Hyperlink` (with `UrlString`), page component pattern, React 19 `fetchPriority` |
| `vt-colors.instructions.md` | `src/lib/vtColors.ts`, `src/app.css`, `src/hooks/useTheme.ts` | VT brand palette, shading-vs-tinting rules, Impact Orange, WCAG AA, theme tokens, `useTheme`, FOUC prevention |
| `testing.instructions.md` | `src/test/**`, `jest.config.js` | Jest config, `moduleNameMapper`, react-leaflet mock architecture, `setup.ts` polyfills, `runTests` tool gotcha, `MemoryRouter` wrapping |
| `deploy.instructions.md` | `scripts/**`, `.github/**`, `.githooks/**` | `deploy.sh`, `spa-fallback.mjs`, `bump-cicd.sh`, `build.yml`, `submodule-update.yml`, `VT_GITLAB_TOKEN` scope, read-only submodule enforcement, git workflow |

When adding a new instruction file, add a row to this table so it's discoverable.

## Critical Conventions & Gotchas

### Biome config discovery

Biome walks UP the directory tree looking for `biome.json`/`biome.jsonc`. A parent directory (`../autoboat_vt/biome.jsonc`) gets picked up instead of the local config if you don't pass `--config-path` explicitly. **All biome scripts in `package.json` already pass `--config-path=./biome.json`** — keep it that way. Never run bare `biome lint` / `biome check` without the flag.

The VS Code Biome extension has the same discovery problem. `.vscode/settings.json` (committed — see `.vscode` convention below) sets `"biome.configurationPath": "./biome.json"` so the extension uses the local config too. Don't delete that setting.

### Tailwind CSS v4 layer cascade (summary)

Tailwind v4's layer order is `theme, base, utilities`; `@layer components` in `src/app.css` comes BEFORE `utilities`. Normal utility declarations always beat `@layer components` regardless of specificity — use `!important` on overrides. Full details (shorthand syntax, `!important` reversal, `biome-ignore` placement, `app.css` structure, `transform: scale()` footgun, hash-link navigation) are in `css.instructions.md`, loaded when editing `src/app.css`.

### TypeScript config (`tsconfig.json`)

- `"target": "ES2023"`, `"module": "ESNext"`, `"moduleResolution": "bundler"` — modern ESM, bundler-resolved imports.
- `"strict": true` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` — strictest practical settings.
- `"noEmit": true` — TypeScript is editor/typecheck-only; Vite/SWC handles emission.
- `"types": []` — no `@types/*` auto-inclusion; types are imported explicitly per-file.
- `"jsx": "react-jsx"` — automatic runtime (no `import React`).
- `"isolatedModules": true` + `"moduleDetection": "force"` — every file is a module; required for SWC/Vite per-file transpilation.
- `"include": ["src", "vite.config.ts"]` — `external/`, `scripts/`, `public/` are NOT typechecked.

### Biome config (`biome.json`)

- `"root": true` — but this alone does NOT prevent parent-config discovery (see `biome_config_discovery` gotcha). All `package.json` scripts pass `--config-path=./biome.json` explicitly.
- `files.includes`: first entry `**`, then `!`-negations for `dist`, `node_modules`, `coverage`, `public`, `external`, `**/*.sh`, `**/*.svg`, `package-lock.json`, `bun.lock`.
- Formatter: 4-space indent, 120-char line width, LF line endings.
- JS formatter: double quotes, semicolons always, trailing commas all, arrow parens always, JSX double quotes.
- CSS parser: `tailwindDirectives: true` (recognizes `@apply`, `@theme`, etc.).
- Linter: `preset: "recommended"` (no custom rules).

### Vite config notes

- Dev server runs on port 3000 with `open: true`.
- Plugins: `@vitejs/plugin-react` + `@tailwindcss/vite` (Tailwind v4 CSS-first, no `tailwind.config.js`).
- `define` maps `globalThis.__VITE_TELEMETRY_URL__` from `process.env.VITE_TELEMETRY_URL` at build time. Source reads `globalThis`, not `import.meta.env`, so Jest can polyfill it — `import.meta` is syntax (can't be polyfilled in Jest's CJS runtime). `telemetry.ts` declares `global var __VITE_TELEMETRY_URL__: string | undefined`.
- No `tsc` in the build — TypeScript is editor-only. Type errors won't fail `bun run build` (only `biome check` and the Vite build run).
- `scripts/spa-fallback.mjs` runs as a post-build step (see `package.json` `build` script) to copy `dist/index.html` to each route path for S3 SPA routing.

### File naming & import conventions

- Components are `PascalCase.tsx` (e.g., `BoatMarker.tsx`, `ImageModal.tsx`). Pages match their route name: `OurTeam.tsx`, `LiveMap.tsx`.
- Non-component modules are `camelCase.ts` (e.g., `telemetry.ts`, `vtColors.ts`).
- Hooks are `use<Thing>.ts` in `src/hooks/`.
- Tests mirror the source path under `src/test/`: `src/components/Footer.tsx` → `src/test/components/Footer.test.tsx`.
- Import paths: use relative imports (`./components/Header`), not path aliases. Test imports from `src/test/components/` need two levels up (`../../components/`).
- CSS is imported once in `src/main.tsx` (`import "./app.css"`). Don't add per-component CSS files — put component styles in `@layer components` in `src/app.css`.

### Environment variables & secrets

- `VITE_TELEMETRY_URL` — only Vite-prefixed vars are exposed to the client bundle. Wired through `vite.config.ts` `define` → `globalThis.__VITE_TELEMETRY_URL__`. Empty string if unset (falls back to default URL in `telemetry.ts`).
- `.env`, `.env.local`, `.env.*.local` are gitignored. Don't commit real env files.
- `.vscode/` policy: `.gitignore` has `.vscode/*` then `!.vscode/settings.json` — everything in `.vscode/` is ignored EXCEPT `settings.json`, which is committed so the Biome config-discovery fix (`biome.configurationPath`) is shared with the team. Don't commit personal files like `extensions.json`, `launch.json`, or `tasks.json` — add a new `!.vscode/<file>` negation only if a setting is genuinely project-shared.
- The deploy script uses cached VT GitLab SSH credentials — it does not read a token from env. `VT_GITLAB_TOKEN` is only used by the GitHub Actions `submodule-update.yml` workflow (see `deploy.instructions.md` for scope details).
- MapTiler API key is currently hardcoded in `LiveMap.tsx` (read-only map tiles). If you move it to an env var, use the `VITE_` prefix and wire through `vite.config.ts` `define`.

### Image & asset conventions

- Site images live in `public/images/` organized by page: `a_front_image/`, `gallery/`, `our_team_images/` (with subdirs per subteam: `electronics/`, `mechanical/`, `navarch/`, `sail/`, `software/`).
- Reference images from components/pages as absolute paths from `public/` (e.g., `/images/gallery/foo.jpg`). Vite serves `public/` at the root.
- `BoatMarker` uses `/images/boat-icon.webp` (50px square, centered anchor) — keep this asset in `public/images/`.
- Lazy-load gallery and below-the-fold images (`loading="lazy"`) — they shift layout, which is why the hash-link scroll effect re-scrolls on a decay schedule.
- `public/_redirects` is for Netlify/Cloudflare Pages hosts only. On raw S3 it's ignored — SPA routing is handled by `scripts/spa-fallback.mjs` instead.
- `public/googleeba451f5e3aecfef.html` and `public/robots.txt` / `public/sitemap.xml` are SEO files — don't modify without checking Search Console ownership.

### `index.html` metadata

- `<meta name="theme-color">` — both light (`#f0eee6`) and dark (`#1f1e1d`) variants via `media="(prefers-color-scheme: ...)"`. Controls the mobile browser UI bar color.
- Open Graph tags (`og:type`, `og:title`, `og:description`, `og:image`) — social share preview. `og:image` currently points to `/images/favicon.ico` (not a dedicated preview image).
- `<meta name="description">` — SEO description ("AutoBoat at Virginia Tech designs and builds autonomous sailboats and electric motorboats...").
- Favicon: `/images/favicon.ico`.

### Git hooks

- The `prepare` script in `package.json` runs `git config core.hooksPath .githooks` on every `bun install` — no manual setup needed after cloning.
- `.githooks/pre-commit` is the only hook. It enforces that `external/cicd` (and any future submodule under `external/`) stays read-only for humans — see `deploy.instructions.md` for the full mechanism.
- There is no `pre-push` or `commit-msg` hook. Branch protection on GitHub (`main`) and the CI `build.yml` workflow are the other enforcement layers.

## Working Style Notes

- **Terminal output exceeds scrollback** in this environment. Redirect long output to `/tmp/*.log` and `read_file` it back rather than reading terminal output directly.
- When making multiple independent edits, batch them for efficiency.
- Prefer reading large file chunks over many small reads.
- Don't pass `...existing code...` markers or omitted-line markers to edit tools — include exact literal text with 3-5 lines of context before and after.
