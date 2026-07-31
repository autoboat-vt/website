---
description: "Use when deploying the site, running deploy.sh, syncing the vendored external/cicd files, working on CI workflows, or troubleshooting S3/S4 SPA routing. Covers deploy.sh internals, spa-fallback.mjs, bump-cicd.sh (vendor-update), build.yml, and the vendored external/cicd model."
applyTo: "scripts/**, .github/**"
---

# Deploying

Deployment is manual via `./scripts/deploy.sh` from a local checkout with VT GitLab credentials cached. There is **no CI deploy** — GitHub Actions (`.github/workflows/build.yml`) does build-only validation on PRs.

```bash
./scripts/deploy.sh              # build + deploy
./scripts/deploy.sh --skip-build # deploy an existing dist/
```

How it works:
1. `bun run build` → `dist/` (Vite build + `spa-fallback.mjs` copies `index.html` to each route path)
2. `git fetch aoe_sites main` → `git worktree add --detach` (isolated from source tree)
3. `git rm -rf .` in the worktree, copy `dist/` contents via `tar`
4. Commit + fast-forward push to `aoe_sites:main` (NO force-push — VT GitLab `main` is protected)
5. S4 service syncs `aoe_sites:main` → S3 (a few minutes)

**Never run `git rm -rf .` in the source working tree** — it can partially clear `node_modules` and `dist/`. Always use the worktree. macOS `cp` has no `-A` flag — use `tar -C src -cf - . | tar -xf -` for portable copy.

## SPA routing on S3

S3 returns 404 for client-side routes (`/sponsors`, `/ourteam`, etc.) because no file exists at those paths. `public/_redirects` only works on Netlify/Cloudflare Pages, NOT raw S3. `scripts/spa-fallback.mjs` solves this by copying `dist/index.html` to each route path (`dist/sponsors/index.html`, etc.) and generating `dist/404.html`.

## Scripts

- **`scripts/deploy.sh`**: manual deploy to VT GitLab (`aoe_sites:main`) → S4 → S3. Uses a temp worktree (NOT the source tree) to avoid sweeping `node_modules`/`dist/` into the deploy commit. Steps: commit uncommitted source changes → `bun run build` → push source to GitHub → fetch `aoe_sites/main` → create worktree → `git rm -rf .` → copy `dist/` via `tar` (portable, macOS `cp` has no `-A`) → commit `Deploy: built from <sha>` → fast-forward push (NO force — `main` is protected). Cleanup trap removes the worktree on exit. Flags: `--skip-build` deploys an existing `dist/`.
  - Env overrides: `AOE_REMOTE` (default `aoe_sites`), `AOE_BRANCH` (default `main`).
- **`scripts/spa-fallback.mjs`**: post-build step. Copies `dist/index.html` to each route path (`dist/ourteam/index.html`, etc.) and generates `dist/404.html`. The `ROUTES` array `["/ourteam", "/fleet", "/sponsors", "/gallery", "/live"]` MUST match `src/App.tsx`. S3 returns 404 for client-side routes otherwise.
- **`scripts/bump-cicd.sh`**: syncs `external/cicd/` (vendored tracked files, NOT a submodule) with upstream's latest `main` from `code.vt.edu/s4-hosting-sites/cicd`. Clones upstream into a temp dir, copies files over `external/cicd/`, stages the diff, and commits. Uses cached VT GitLab creds (anonymous HTTPS fetch of `code.vt.edu` returns 403 — VT InCommon Federation auth required).

## Continuous integration

`.github/workflows/build.yml` runs on PRs (build-only validation, no deploy):
- Installs deps with `bun install`.
- Runs `bun run check` (biome lint + format).
- Runs `bun run build` (Vite build + `spa-fallback.mjs`).
- Triggers: `push` to `main`, PRs to `main`, `workflow_dispatch`.
- Concurrency: `build-${{ github.ref }}` with `cancel-in-progress: true` (cancels superseded runs on the same ref).

`.github/workflows/manual.yml` runs on `push` when files under `public/images/**` change — converts PNG/JPG originals to WebP in place and commits. No submodule or deploy interaction.

`.github/workflows/code-coverage.yml` runs `bun run test:coverage` (jest with `--coverage`) on PRs and pushes to `main`. Coverage config lives in `jest.config.js` (`collectCoverageFrom` reports ALL `src/` files, not just those imported during the test run, so untested files show as 0%; `coverageReporters` emits `text`, `lcov`, `html`, and `json-summary`). The `coverage/` directory is uploaded as an artifact (14-day retention). On PRs, an `actions/github-script` step parses `coverage/coverage-summary.json` and posts/updates an idempotent coverage-summary table comment (tagged with `<!-- coverage-report -->` so successive pushes update the same comment instead of stacking duplicates). Requires `pull-requests: write` permission for the comment step. Same triggers, concurrency group pattern (`coverage-${{ github.ref }}` with `cancel-in-progress`), and Bun setup as `build.yml`.

There is **no automated CI workflow for syncing `external/cicd/`**. The old `.github/workflows/submodule-update.yml` (daily cron that bumped the submodule pointer) was removed when `external/cicd` was converted from a submodule to vendored tracked files. Syncs are manual via `scripts/bump-cicd.sh` (which uses locally-cached VT GitLab creds — `code.vt.edu` requires VT InCommon Federation auth, anonymous HTTPS returns 403). If automated syncs are wanted in the future, a new workflow would need to clone upstream `code.vt.edu/s4-hosting-sites/cicd` using a `VT_GITLAB_TOKEN` secret (read_repository scope) and copy files into `external/cicd/`.

`.github/CODEOWNERS`:
- Default owner for everything: `@autoboat-vt/software`.
- `external/` and `external/cicd/` — same team; paired with a branch protection rule requiring CODEOWNERS review for the `external/` path. Changes should come from `scripts/bump-cicd.sh` (upstream sync), not hand-edits; the review rule catches any PR touching the vendored files.

## Dependabot

`.github/dependabot.yml` configures version updates with two update sets:

- **`github-actions`** (active): opens weekly PRs (Monday) to bump actions used in `.github/workflows/*.yml`. All actions are grouped into a single PR; commit prefix `ci:`, labels `dependencies` + `github-actions`.
- **`npm`** (disabled): all deps in `package.json` are pinned to `"latest"` (floating) and resolved at `bun install` time, so Dependabot's npm updater (which pins to specific versions) would fight that convention. The config has `open-pull-requests-limit: 0` and an `ignore: "*"` for all semver update types as a guard. Groupings (react, leaflet, build-tooling, testing) are pre-defined — flip the limit to a positive number if the team ever moves to pinned versions.

### Auto-merge

Dependabot's YAML schema does NOT support an `enable-auto-merge` key — GitHub rejects it with "Property enable-auto-merge is not allowed". Auto-merge for Dependabot PRs is instead handled by `.github/workflows/dependabot-automerge.yml`, which triggers on `pull_request_target: [opened]` for PRs by `dependabot[bot]` and runs `gh pr merge --auto --squash`. `--auto` means GitHub waits for the required status checks and reviews to pass before merging; if CI fails, the PR stays open for manual review.

`gh pr merge --auto` does not bypass repo/branch-protection requirements. Auto-merge still needs:

1. **Repo-level "Allow auto-merge"** enabled: GitHub repo Settings -> General -> Pull Requests -> check "Allow auto-merge". Without this, `gh pr merge --auto` fails.
2. **Branch protection on `main`** with `build.yml` (the workflow in `.github/workflows/build.yml`) listed as a required status check. Auto-merge waits for required checks; if `build.yml` isn't required, the PR merges immediately on open (before CI runs), which defeats the point.
3. **Required reviews** set to 0 (or the auto-merge PR will wait forever for a human review). Dependabot PRs don't auto-satisfy CODEOWNERS review.

Verify in GitHub Settings -> Branches -> `main` rule: "Require status checks to pass before merging" with `build.yml` (or its check name) required, and "Require pull request reviews before merging" set to 0.

`scripts/configure-dependabot-automerge.sh` automates all three of the above via `gh api` (requires repo admin + `gh auth login`). It:
- PATCHes the repo to set `allow_auto_merge=true` and the squash merge convention.
- PUTs a branch protection rule on `main` requiring the `build` status check (strict: branch must be up to date), with no required reviews, no force pushes, no deletions.
- Prints a verification summary at the end.

The status check name is `build` (the workflow is `name: Build` with a single `build:` job, so the check that appears on PRs is lowercase `build`). If GitHub's PR checks UI shows a different name (e.g. `Build` or `build / build`), update `CHECK_NAME` in the script and re-run. The script is idempotent — re-running just re-applies the same settings.

Run it once from a checkout:

```bash
./scripts/configure-dependabot-automerge.sh
```

Dependabot auto-creates the `dependencies`, `npm`, and `github-actions` labels on first run if they don't already exist.

These same three settings also gate `.github/workflows/update-citation-date.yml`, which auto-merges a daily `date-released` bump PR via `gh pr merge --auto --squash`. If auto-merge is disabled, the `build` check is removed from required checks, or required reviews is raised above 0, the citation PR will sit open (or the merge step will fail) instead of landing.

# Vendored files: `external/cicd/`

`external/cicd/` is a **vendored copy** of VT's reference S4 CI templates, owned upstream by the `s4-hosting-sites/cicd` project on `code.vt.edu` (GitLab). The files are committed directly to this repo as ordinary tracked files (NOT a git submodule). They are excluded from Biome linting via `biome.json` `files.includes` (`!external`).

**Updating**: run `scripts/bump-cicd.sh` to sync with upstream's latest `main`. The script clones `code.vt.edu/s4-hosting-sites/cicd` into a temp dir (requires cached VT GitLab creds — anonymous fetch returns 403), copies files over `external/cicd/`, stages the diff, and commits. There is no pre-commit hook or CI check blocking content edits under `external/` anymore — those existed to protect the submodule pointer and were removed when the submodule was deinit'd. CODEOWNERS review on PRs touching `external/` is the remaining guardrail.

**Why vendored, not a submodule?** GitHub only renders a clickable submodule link for submodules hosted on `github.com`. Because the upstream lives on `code.vt.edu` (GitLab), the submodule click-through 404'd on GitHub, and `code.vt.edu` requires VT InCommon Federation auth so `actions/checkout` couldn't use `submodules: true`. Vendoring the files makes them browseable on GitHub and removes the auth hurdle from CI.

# Git Workflow

- Source-of-truth `main` lives on GitHub (`autoboat-vt/website`).
- VT GitLab `main` (`aoe_sites`) is the deploy target — accumulates deploy commits containing only built files.
- No `deploy` branch, no force-push. Each deploy is a fast-forward commit on top of existing `main`.
- Commit messages for deploys: `Deploy: built from <sha>`.
