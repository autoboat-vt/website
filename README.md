# AutoBoat @ Virginia Tech — Website

React + TypeScript + Vite site for Virginia Tech's AutoBoat team, styled with Tailwind CSS v4 and routed with `react-router-dom`.

## Structure

- `src/main.tsx` — app entry (renders `<App />` into `#root`)
- `src/App.tsx` — routes and layout (Header / main / Footer)
- `src/app.css` — Tailwind entry, theme tokens, component-layer CSS
- `src/components/` — shared UI (`Header`, `Footer`, `Card`, `Gallery`, `ImageModal`)
- `src/pages/` — one component per route (`Home`, `OurTeam`, `Fleet`, `Sponsors`, `Gallery`)
- `public/images/` — site images
- `scripts/deploy.sh` — manual deploy to VT GitLab (see below)
- `external/cicd/` — read-only git submodule (see below)

## Routes

| Path           | Page          |
| -------------- | ------------- |
| `/`            | About (Home)  |
| `/ourteam`     | Meet the Team |
| `/fleet`       | Our Fleet     |
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

The site is hosted at [autoboat.aoe.vt.edu](https://autoboat.aoe.vt.edu/), served from Amazon S3 via VT's **S4 (Static Site Storage) service**. The S4 backing repo is `code.vt.edu/s4-hosting-sites/aoe/sailbot` (remote name `aoe_sites`).

### How S4 deploys work

```
Your workstation → aoe_sites:main (code.vt.edu) → S3 (sync, ~minutes)
                                                   ├─ stage: sailbot.aoe.vt.edu.s3-website-us-east-1.amazonaws.com
                                                   └─ prod:  autoboat.aoe.vt.edu  (launched domain)
```

- The S4 service syncs the contents of `aoe_sites:main` to S3 automatically on push — there is **no build step** on the VT side. So we push *built* `dist/` contents (not source) to `aoe_sites:main`.
- **Stage** (`sailbot.aoe.vt.edu.s3-website-us-east-1.amazonaws.com`) is the default S4 staging bucket. It returns 403 when empty (no deploys yet to that bucket).
- **Prod** (`autoboat.aoe.vt.edu`) is the launched production domain. Launching a stage site to its public domain requires a [Web Hosting Support](https://webapps.es.vt.edu/support/) ticket (launch days are Tue/Thu afternoons 1–4pm ET). This site is already launched.

Source-of-truth `main` lives on GitHub (`autoboat-vt/website`). Each deploy fast-forwards a commit containing only built files onto VT GitLab's `main` — no force-push.

### One-time setup

Contact the Software Officer for VT GitLab access, then:

```bash
git remote add aoe_sites ssh://git@code.vt.edu/s4-hosting-sites/aoe/sailbot
```

### Deploying

```bash
./scripts/deploy.sh              # build + deploy
./scripts/deploy.sh --skip-build # deploy an existing dist/
```

The script builds, fetches `aoe_sites/main`, replaces the worktree contents with `dist/`, commits, and fast-forward pushes. The S4 service then syncs the new `main` to S3 (a few minutes).

> **SPA routing:** `scripts/spa-fallback.mjs` (chained to `build`) copies `index.html` to each route path so client-side routing works on direct visits. `public/_redirects` covers hosts that respect it.

> **S4 CI templates:** The `external/cicd` submodule (see below) contains VT's reference `.gitlab-ci.yml` templates for S4 sites — e.g. `default.yml` does `aws s3 sync . s3://$S3_BUCKET_NAME`. We don't currently use them (our `deploy.sh` builds locally and the S4 service handles the S3 sync), but they're vendored for reference if we ever move the build into GitLab CI.

## Vendored submodule: `external/cicd`

The `external/cicd` directory is a **read-only git submodule** tracking
[`code.vt.edu/s4-hosting-sites/cicd`](https://code.vt.edu/s4-hosting-sites/cicd)
(upstream `main`). It's pinned at a specific commit; the contents come from
the upstream repo and **must not be edited in this repo**.

### Working with the submodule

```bash
git clone --recurse-submodules <repo>      # fresh clone incl. submodule
bun install                              # installs deps + activates git hooks
git submodule update --init --recursive    # existing clone, init submodule
```

The `prepare` script in `package.json` runs `git config core.hooksPath .githooks`
automatically on every `bun install` / `npm install` / `yarn install`, so the
read-only pre-commit hook is active with no extra step.

To bump the pointer to upstream's latest `main`:

```bash
git submodule update --remote --merge external/cicd
git add external/cicd
git commit -m "chore(submodule): bump external/cicd"
```

Or just run the helper script (fetches, diffs, commits in one step):

```bash
./scripts/bump-cicd.sh
```

### Read-only enforcement

Three layers prevent accidental hand-edits to the submodule's contents:

1. **Pre-commit hook** — `.githooks/pre-commit` (tracked in the repo, activated
   automatically via `core.hooksPath` on `bun install`) blocks any staged
   content change under `external/cicd`. The submodule *pointer* bump is
   allowed; file edits inside the submodule are not.
2. **CI check** — the `verify-readonly-submodule` job in
   `.github/workflows/build.yml` fails any PR that touches file contents under
   `external/`. This check diffs gitlink entries in the superproject tree and
   does **not** need to clone the submodule (which lives on a private VT
   GitLab repo GitHub Actions can't reach).
3. **CODEOWNERS** — `.github/CODEOWNERS` marks `external/` as owned by
   `@autoboat-vt/software`; pair with a branch protection rule requiring
   CODEOWNERS review for that path.

### Automatic upstream tracking

The `submodule-update.yml` workflow runs daily (09:00 UTC) and checks the
upstream `cicd` repo's `main` for new commits. If found, it opens a PR bumping
the pointer and **auto-merges** once CI passes. Nothing reaches `main` without
a green build.

> **Auth required.** `code.vt.edu` is not publicly accessible (VT InCommon
> Federation sign-in). The workflow needs a read-only VT GitLab personal access
> token stored as the GitHub secret `VT_GITLAB_TOKEN`. Without it, the workflow
> exits gracefully with a notice (no failure, no 403). To enable:
>
> 1. Create a PAT at <https://code.vt.edu/-/profile/personal_access_tokens>
>    with `read_repository` scope.
> 2. Add it as a repository secret named `VT_GITLAB_TOKEN` at
>    <https://github.com/autoboat-vt/website/settings/secrets/actions>.
>
> Until the secret is set, bump the submodule manually with
> `./scripts/bump-cicd.sh` (run on a machine with VT GitLab credentials).

> Requires "Allow auto-merge" enabled in the repo's Settings → General → Pull
> Requests. If disabled, the PR stays open for manual review.

## CI

`.github/workflows/build.yml` runs on push to `main` and on PRs — installs deps, builds, uploads `dist/` as an artifact. Deploys to VT GitLab are manual (see above). `.github/workflows/manual.yml` auto-converts new PNG/JPG images under `images/` to WebP on push.

