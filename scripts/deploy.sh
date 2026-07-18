#!/usr/bin/env bash
#
# Deploy the built AutoBoat website to the VT AOE hosting GitLab.
#
# The VT server (autoboat.aoe.vt.edu) serves files from the root of the
# `aoe_sites` remote (ssh://git@code.vt.edu/s4-hosting-sites/aoe/sailbot) as
# static content. It does NOT run a build step, so we must push the contents
# of `dist/` (built index.html + hashed assets/ + images/ + _redirects) as
# the root of that remote.
#
# Strategy: fast-forward commit on top of existing main (NO force push).
#   1. Commit any uncommitted changes (prompts for message)
#   2. Build the site with `bun run build` → dist/
#   3. Push source to GitHub (origin/main)
#   4. Fetch the latest aoe_sites/main
#   5. Create a worktree based on aoe_sites/main
#   6. Remove all tracked files, copy in dist/ contents, commit
#   7. Push (fast-forward — no force, no orphan branch)
#
# This adds a regular commit on top of the remote main's history. The commit's
# tree contains ONLY built files (source is removed from the index), but the
# history is preserved, so the push is always a fast-forward.
#
# Doing the work in a separate worktree (rather than the source tree) ensures
# untracked files like node_modules/ don't get swept into the deploy commit.
#
# Usage:
#   ./scripts/deploy.sh               # build + deploy
#   ./scripts/deploy.sh --skip-build  # deploy existing dist/ without rebuilding
#
set -euo pipefail

REMOTE="${AOE_REMOTE:-aoe_sites}"
REMOTE_BRANCH="${AOE_BRANCH:-main}"
WORKTREE_DIR="$(mktemp -d -t autoboat-deploy)"

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
    DEFAULT_MSG="Deploy $(date -u +%Y-%m-%d)"
    echo "==> You have uncommitted changes:"
    git status -sb
    echo
    read -r -p "   Commit message [\"$DEFAULT_MSG\"]: " COMMIT_MSG
    COMMIT_MSG="${COMMIT_MSG:-$DEFAULT_MSG}"
    git add -A
    git commit -m "$COMMIT_MSG"
    echo "   Committed: $(git rev-parse --short HEAD)"
else
    echo "==> No uncommitted changes; using HEAD ($(git rev-parse --short HEAD))"
fi

# --- Step 2: Build ----------------------------------------------------------
if [[ "${1:-}" != "--skip-build" ]]; then
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

# --- Step 3: Push source to GitHub (origin) first ---------------------------
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

# --- Step 4: Fetch latest remote main ---------------------------------------
echo "==> Fetching $REMOTE/$REMOTE_BRANCH"
git fetch "$REMOTE" "$REMOTE_BRANCH"
REMOTE_HEAD="$(git rev-parse "$REMOTE/$REMOTE_BRANCH")"
echo "   Remote HEAD: $REMOTE_HEAD"

# --- Step 5: Create worktree based on remote main ---------------------------
echo "==> Preparing worktree at $WORKTREE_DIR (based on $REMOTE/$REMOTE_BRANCH)"
git worktree add --detach "$WORKTREE_DIR" "$REMOTE/$REMOTE_BRANCH"
cd "$WORKTREE_DIR"

# --- Step 6: Replace all contents with dist/ --------------------------------
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
    echo "   No changes to deploy — dist/ is identical to $REMOTE/$REMOTE_BRANCH."
    echo "   Source is on GitHub at $SOURCE_COMMIT."
    echo "   Live site: https://autoboat.aoe.vt.edu/ (unchanged)"
    exit 0
fi

git commit --quiet -m "Deploy: built from $SOURCE_COMMIT

Generated by scripts/deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Sanity check: the commit should contain only built assets
echo "==> Deploy commit contents:"
git --no-pager ls-tree --name-only HEAD

# --- Step 7: Push (fast-forward, NO force) ----------------------------------
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
