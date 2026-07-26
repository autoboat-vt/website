---
description: "Use when deploying the site, running deploy.sh, bumping the external/cicd submodule, working on CI workflows, or troubleshooting S3/S4 SPA routing. Covers deploy.sh internals, spa-fallback.mjs, bump-cicd.sh, build.yml, submodule-update.yml, VT_GITLAB_TOKEN scope, and the read-only submodule enforcement layers."
applyTo: "scripts/**, .github/**, .githooks/**"
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
- **`scripts/bump-cicd.sh`**: bumps the `external/cicd` submodule pointer to upstream's latest `main`. Uses cached VT GitLab SSH creds. `code.vt.edu` requires VT InCommon Federation sign-in — anonymous HTTPS fetch returns 403.

## Continuous integration

`.github/workflows/build.yml` runs on PRs (build-only validation, no deploy):
- Installs deps with `bun install`.
- Runs `bun run check` (biome lint + format).
- Runs `bun run build` (Vite build + `spa-fallback.mjs`).
- **`verify-readonly-submodule`** job: fails PRs with content changes under `external/`. Diffs gitlink entries (mode `160000`) rather than cloning the submodule — `actions/checkout` MUST NOT use `submodules: true` (would fail on `code.vt.edu` 403). Uses `fetch-depth: 0` to diff against the base ref on PRs.
- Triggers: `push` to `main`, PRs to `main`, `workflow_dispatch`.
- Concurrency: `build-${{ github.ref }}` with `cancel-in-progress: true` (cancels superseded runs on the same ref).

`.github/workflows/submodule-update.yml` is a daily cron (`0 9 * * *` UTC) that bumps `external/cicd` to upstream's latest `main`. Requires the `VT_GITLAB_TOKEN` GitHub secret (used only here, not by `deploy.sh`). If the secret is not set, the workflow exits gracefully with a notice (no failure, no 403). Creates a PR with the pointer bump and auto-merges once CI passes. Permissions: `contents: write`, `pull-requests: write`. Concurrency: `submodule-update` group with `cancel-in-progress: false`.

**`VT_GITLAB_TOKEN` scope**: create a VT GitLab PAT at <https://code.vt.edu/-/profile/personal_access_tokens> with **`read_repository`** scope only. The token only ever performs read operations against `code.vt.edu` (`git submodule update --init`, `git fetch origin main`, `git checkout <sha>`) — it never pushes to VT GitLab. Deploys go through `scripts/deploy.sh` using locally-cached SSH credentials, not this token. Store it as the repo secret `VT_GITLAB_TOKEN` at <https://github.com/autoboat-vt/website/settings/secrets/actions>. `code.vt.edu` requires VT InCommon Federation sign-in (anonymous HTTPS returns 403), which is why `actions/checkout` must NOT use `submodules: true` — the workflow inits the submodule manually with the token-rewritten URL instead.

`.github/CODEOWNERS`:
- Default owner for everything: `@autoboat-vt/software`.
- `external/` — same team; paired with a branch protection rule requiring CODEOWNERS review for the `external/` path. Direct commits to submodule contents are blocked by the pre-commit hook and CI check; this rule ensures any PR bumping the pointer still gets reviewed.

# Read-Only Submodule: `external/cicd/`

`external/cicd` is a **read-only git submodule** tracking `code.vt.edu/s4-hosting-sites/cicd` (VT's reference S4 CI templates). It is pinned at a specific commit. Owned upstream by VT's `s4-hosting-sites/cicd` project on `code.vt.edu` (GitLab), NOT by autoboat.

**Do not edit files under `external/cicd/`.** Three layers enforce this:
1. Pre-commit hook `.githooks/pre-commit` (activated automatically via `prepare` script on every `bun install`) — allows submodule pointer bumps (gitlink mode `160000`), blocks content edits.
2. CI job `verify-readonly-submodule` in `.github/workflows/build.yml` — fails PRs with content changes under `external/`.
3. `.github/CODEOWNERS` — `external/` owned by `@autoboat-vt/software`.

The pre-commit hook detects content edits by inspecting `git diff --cached --raw` output: submodule pointer bumps show up as gitlink entries with mode `160000`, while real file content edits have modes like `100644`/`100755`/`040000`. The hook blocks any staged entry under `external/` whose mode is NOT `160000`. Scoping to `external/` (not `external/cicd`) also catches stray files added at sibling paths like `external/sibling-path/`.

To bump the pointer to upstream's latest `main`:
```bash
./scripts/bump-cicd.sh   # local, uses cached VT GitLab creds
```
Or via the daily cron workflow `.github/workflows/submodule-update.yml` (requires `VT_GITLAB_TOKEN` GitHub secret).

**Note**: `code.vt.edu` requires VT InCommon Federation sign-in. Anonymous HTTPS fetch returns 403. Don't use `submodules: true` in `actions/checkout` — the CI check diffs gitlink entries instead of cloning the submodule.

# Git Workflow

- Source-of-truth `main` lives on GitHub (`autoboat-vt/website`).
- VT GitLab `main` (`aoe_sites`) is the deploy target — accumulates deploy commits containing only built files.
- No `deploy` branch, no force-push. Each deploy is a fast-forward commit on top of existing `main`.
- Commit messages for deploys: `Deploy: built from <sha>`.
