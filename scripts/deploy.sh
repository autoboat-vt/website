#!/usr/bin/env bash
#
# Deploy the built AutoBoat website to the VT S4 (Static Site Storage) service.
#
# The site (autoboat.aoe.vt.edu) is served from Amazon S3 via VT's S4 service.
# The S4 backing repo is `aoe_sites` (ssh://git@code.vt.edu/s4-hosting-sites/aoe/sailbot).
# S4 syncs the contents of that repo's main branch to S3 automatically on push
# — there is NO build step on the VT side. So we push the contents of `dist/`
# (built index.html + hashed assets/ + images/ + _redirects) as the root of
# `aoe_sites:main`, and S3 picks it up within a few minutes.
#
# Strategy: fast-forward commit on top of existing main (NO force push).
#   1. Commit any uncommitted changes (prompts for message)
#   2. Build the site with `bun run build` → dist/
#   3. Deploy the Cloudflare Worker (`wrangler deploy` in worker/)
#   4. Push source to GitHub (origin/main)
#   5. Fetch the latest aoe_sites/main
#   6. Create a worktree based on aoe_sites/main
#   7. Remove all tracked files, copy in dist/ contents, commit
#   8. Push (fast-forward — no force, no orphan branch)
#
# The site and the Worker are separate artifacts on separate hosts (VT S4/S3
# and Cloudflare respectively), but this script ships both so a single command
# leaves them consistent. Step 3 runs before either push — see the comment on
# that step for why.
#
# This adds a regular commit on top of the remote main's history. The commit's
# tree contains ONLY built files (source is removed from the index), but the
# history is preserved, so the push is always a fast-forward.
#
# Doing the work in a separate worktree (rather than the source tree) ensures
# untracked files like node_modules/ don't get swept into the deploy commit.
#
# Usage:
#   ./scripts/deploy.sh               # build + deploy site and Worker
#   ./scripts/deploy.sh --skip-build  # deploy existing dist/ without rebuilding
#   ./scripts/deploy.sh --skip-worker # site only; leave the Worker untouched
#
set -euo pipefail

REMOTE="${AOE_REMOTE:-aoe_sites}"
REMOTE_BRANCH="${AOE_BRANCH:-main}"
WORKTREE_DIR="$(mktemp -d -t autoboat-deploy.XXXXXX)"

# --- Flags ------------------------------------------------------------------
# Parsed in a loop rather than by positional index, so the flags work in any
# order and an unrecognised one fails loudly instead of being ignored.
SKIP_BUILD=false
SKIP_WORKER=false
for arg in "$@"; do
    case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-worker) SKIP_WORKER=true ;;
    -h | --help)
        echo "Usage: $0 [--skip-build] [--skip-worker]"
        echo "  --skip-build   deploy the existing dist/ without rebuilding"
        echo "  --skip-worker  skip the Cloudflare Worker deploy"
        exit 0
        ;;
    *)
        echo "ERROR: unknown option: $arg" >&2
        echo "Usage: $0 [--skip-build] [--skip-worker]" >&2
        exit 2
        ;;
    esac
done

cleanup() {
    local exit_code=$?
    set +e
    if [[ -d "$WORKTREE_DIR" ]]; then
        git worktree remove --force "$WORKTREE_DIR" 2>/dev/null
    fi
    rmdir "$WORKTREE_DIR" 2>/dev/null
    exit $exit_code
}
trap cleanup EXIT

cd "$(git rev-parse --show-toplevel)"

# --- Step 1: Commit any uncommitted changes ---------------------------------
# Ask the user for a commit message and commit any staged/unstaged changes
# before building. If there's nothing to commit, skip the prompt entirely.
if ! git diff --quiet || ! git diff --cached --quiet; then
    DEFAULT_MSG="Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "==> You have uncommitted changes:"
    git status -sb
    echo
    # Use readline (`-e`) so arrow keys, Home/End, etc. work when editing the
    # commit message. Also bind the Delete key explicitly: some terminals send
    # `\e[3~` which readline doesn't bind to delete-char by default, causing it
    # to insert a literal `~`. `bind` only works in interactive shells, so
    # silence errors when the script runs non-interactively.
    if [[ $- == *i* ]]; then
        bind '"\e[3~": delete-char' 2>/dev/null || true
    fi
    read -r -e -p "   Commit message [\"$DEFAULT_MSG\"]: " COMMIT_MSG
    COMMIT_MSG="${COMMIT_MSG:-$DEFAULT_MSG}"
    git add -A
    git commit -m "$COMMIT_MSG"
    echo "   Committed: $(git rev-parse --short HEAD)"
else
    echo "==> No uncommitted changes; using HEAD ($(git rev-parse --short HEAD))"
fi

# --- Step 2: Build ----------------------------------------------------------
if [[ "$SKIP_BUILD" != true ]]; then
    echo "==> Building site (bun run build)"
    bun run build
fi

if [[ ! -d dist ]]; then
    echo "ERROR: dist/ does not exist. Run \`bun run build\` first or run without --skip-build." >&2
    exit 1
fi

if [[ -z "$(ls -A dist)" ]]; then
    echo "ERROR: dist/ is empty." >&2
    exit 1
fi

SOURCE_COMMIT="$(git rev-parse HEAD)"
SOURCE_ROOT="$(git rev-parse --show-toplevel)"

# --- Step 3: Deploy the Cloudflare Worker -----------------------------------
# The site and the Worker are separate artifacts on separate hosts: the site
# goes to VT S4/S3, the Worker to Cloudflare. Both are deployed here so one
# command ships a consistent pair.
#
# The Worker goes FIRST, before either push, for two reasons:
#   1. Fail fast. Cloudflare auth (`wrangler login`, or CLOUDFLARE_API_TOKEN)
#      is a different credential from the cached VT GitLab creds and is the
#      likeliest thing to have expired. If it has, nothing has been pushed yet
#      and both remotes still describe the previous, working state.
#   2. Backend before frontend. A newer Worker with an older site degrades
#      gracefully -- the site simply ignores what it does not use yet -- while
#      the reverse can leave a deployed site expecting a field the live Worker
#      does not send.
#
# This is a REAL production deploy of worker/. It does not need the Discord bot
# token: that lives in Cloudflare as a secret and survives redeploys. See
# worker/README.md for the one-time Cloudflare setup.
if [[ "$SKIP_WORKER" == true ]]; then
    echo "==> Skipping Worker deploy (--skip-worker)"
else
    # The repo's preferred runner is bun; fall back to npx when bun is absent.
    if command -v bunx >/dev/null 2>&1; then
        WRANGLER_RUNNER="bunx"
    elif command -v npx >/dev/null 2>&1; then
        WRANGLER_RUNNER="npx"
    else
        echo "ERROR: neither 'bunx' nor 'npx' is on PATH; cannot run wrangler." >&2
        exit 1
    fi

    if [[ ! -f "$SOURCE_ROOT/worker/wrangler.jsonc" ]]; then
        echo "ERROR: $SOURCE_ROOT/worker/wrangler.jsonc not found." >&2
        echo "The Worker lives in worker/; run without --skip-worker from the repo root." >&2
        exit 1
    fi

    # wrangler resolves from worker/node_modules. Install on demand rather than
    # letting bunx quietly fetch its own unpinned copy.
    if [[ ! -x "$SOURCE_ROOT/worker/node_modules/.bin/wrangler" ]]; then
        echo "   Worker dependencies not installed; running 'bun install' in worker/"
        (cd "$SOURCE_ROOT/worker" && bun install)
    fi

    echo "==> Deploying Cloudflare Worker ($WRANGLER_RUNNER wrangler deploy)"
    # Subshell so the worktree steps below still run from the repo root.
    if ! (cd "$SOURCE_ROOT/worker" && "$WRANGLER_RUNNER" wrangler deploy); then
        echo "ERROR: Worker deploy failed." >&2
        echo "Check Cloudflare auth: cd worker && $WRANGLER_RUNNER wrangler whoami" >&2
        echo "Nothing has been pushed to GitHub or VT." >&2
        exit 1
    fi
fi

# --- Step 4: Push source to GitHub (origin) first ---------------------------
# Ensures the source commit being deployed is already on GitHub before we
# push the built files to the VT GitLab. Aborts if origin/main has diverged
# so the user can pull/rebase and retry.
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"
ORIGIN_BRANCH="${ORIGIN_BRANCH:-main}"
echo "==> Pushing source to $ORIGIN_REMOTE/$ORIGIN_BRANCH"
if ! git push "$ORIGIN_REMOTE" "HEAD:$ORIGIN_BRANCH" 2>/tmp/origin-push.log; then
    echo "ERROR: Push to $ORIGIN_REMOTE/$ORIGIN_BRANCH failed:" >&2
    echo "The remote may have new commits. Pull/rebase and retry." >&2
    cat /tmp/origin-push.log >&2
    exit 1
fi
echo "   Source pushed: $(git rev-parse --short HEAD)"

# --- Step 5: Fetch latest remote main ---------------------------------------
echo "==> Fetching $REMOTE/$REMOTE_BRANCH"
git fetch "$REMOTE" "$REMOTE_BRANCH"
REMOTE_HEAD="$(git rev-parse "$REMOTE/$REMOTE_BRANCH")"
echo "   Remote HEAD: $REMOTE_HEAD"

# --- Step 6: Create worktree based on remote main ---------------------------
echo "==> Preparing worktree at $WORKTREE_DIR (based on $REMOTE/$REMOTE_BRANCH)"
git worktree add --detach "$WORKTREE_DIR" "$REMOTE/$REMOTE_BRANCH"
cd "$WORKTREE_DIR"

# --- Step 7: Replace all contents with dist/ --------------------------------
echo "==> Replacing worktree contents with dist/"
# Remove all tracked files from the index and working tree
git rm -rf --quiet . 2>/dev/null || true
# Copy in the built files (tar is portable across macOS and Linux)
tar -C "$SOURCE_ROOT/dist" -cf - . | tar -xf -

git add -A

# If the built files are byte-identical to what's already on the remote,
# there's nothing to commit — exit early with a clear message.
if git diff --cached --quiet; then
    echo
    echo "   No SITE changes to deploy — dist/ is identical to $REMOTE/$REMOTE_BRANCH."
    if [[ "$SKIP_WORKER" == true ]]; then
        echo "   The Worker was skipped too (--skip-worker)."
    else
        echo "   The Worker was deployed (step 3)."
    fi
    echo "   Source is on GitHub at $SOURCE_COMMIT."
    echo "   Live site: https://autoboat.aoe.vt.edu/ (unchanged)"
    exit 0
fi

git commit --quiet -m "Deploy: built from $SOURCE_COMMIT

Generated by scripts/deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Sanity check: the commit should contain only built assets
echo "==> Deploy commit contents:"
git --no-pager ls-tree --name-only HEAD

# --- Step 8: Push (fast-forward, NO force) ----------------------------------
echo "==> Pushing to $REMOTE/$REMOTE_BRANCH (fast-forward, no force)"
if ! git push "$REMOTE" "HEAD:$REMOTE_BRANCH" 2>/tmp/push-err.log; then
    echo "ERROR: Push to $REMOTE/$REMOTE_BRANCH failed:" >&2
    echo "The remote main may have new commits since we fetched." >&2
    echo "Re-run this script to retry with the latest remote state." >&2
    cat /tmp/push-err.log >&2
    exit 1
fi

echo
echo "✅ Deployed to $REMOTE/$REMOTE_BRANCH"
echo "   Live site: https://autoboat.aoe.vt.edu/"
echo "   (Give the VT server ~30s to refresh; hard-refresh your browser to bypass cache.)"
