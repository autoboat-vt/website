#!/usr/bin/env bash
# bump-cicd.sh — sync external/cicd/ (vendored tracked files) with upstream main.
#
# `external/cicd/` is a vendored copy of VT's reference S4 CI templates, owned
# upstream by the s4-hosting-sites/cicd project on code.vt.edu (GitLab). The
# files are committed directly to this repo (NOT a git submodule). This script
# pulls the latest from upstream and updates the vendored copy in place.
#
# The cicd repo (https://code.vt.edu/s4-hosting-sites/cicd) is private and
# requires VT InCommon Federation auth. Run this on a machine where you have
# code.vt.edu credentials cached (e.g. after signing in via SSH/HTTPS).
# Anonymous HTTPS fetch returns 403.
#
# There is no automated CI workflow for this sync (the old submodule-update.yml
# daily cron was removed when the submodule was converted to vendored files).
# This script is the only update mechanism.
set -euo pipefail

UPSTREAM_URL="https://code.vt.edu/s4-hosting-sites/cicd.git"
TARGET_DIR="external/cicd"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Run from repo root.
cd "$(git rev-parse --show-toplevel)"

if [ ! -d "$TARGET_DIR" ]; then
    echo "error: $TARGET_DIR not found." >&2
    exit 1
fi

echo "Cloning upstream cicd main into $TMP_DIR ..."
git clone --depth 1 --branch main "$UPSTREAM_URL" "$TMP_DIR/upstream"

# Current state — record the upstream HEAD we're syncing from.
upstream_sha="$(git -C "$TMP_DIR/upstream" rev-parse HEAD)"
echo "upstream main HEAD: $upstream_sha"

# Sync files into $TARGET_DIR, removing anything that no longer exists upstream.
# Use rsync if available (preserves nothing we care about here — we want a mirror);
# fall back to a portable rm+cp.
if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude='.git' "$TMP_DIR/upstream/" "$TARGET_DIR/"
else
    # Portable: wipe target contents, copy upstream files (skip upstream's .git).
    find "$TARGET_DIR" -mindepth 1 -delete
    # Copy everything except the .git dir from upstream.
    (cd "$TMP_DIR/upstream" && tar --exclude='./.git' -cf - .) | tar -C "$TARGET_DIR" -xf -
fi

# Stage and show the diff.
git add "$TARGET_DIR"

staged_count="$(git diff --cached --name-only -- "$TARGET_DIR" | wc -l | tr -d ' ')"
if [ "$staged_count" -eq 0 ]; then
    echo "Already up to date — vendored files match upstream $upstream_sha."
    exit 0
fi

echo
echo "Staged changes ($staged_count file(s)):"
git diff --cached --stat -- "$TARGET_DIR"

echo
echo "Upstream log (newest first):"
git -C "$TMP_DIR/upstream" log --oneline --no-decorate -10

git commit -m "chore(vendor): sync external/cicd with upstream ${upstream_sha:0:12}

Pulled from $UPSTREAM_URL (branch main)
Upstream HEAD: $upstream_sha

Synced via scripts/bump-cicd.sh (vendored, not a submodule)."

echo
echo "Done. Vendored $TARGET_DIR synced to ${upstream_sha:0:12}."
echo "Push with: git push"
