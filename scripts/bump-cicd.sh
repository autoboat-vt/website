#!/usr/bin/env bash
# bump-cicd.sh — manually bump the external/cicd submodule to upstream main.
#
# The cicd repo (https://code.vt.edu/s4-hosting-sites/cicd) is private and
# requires VT InCommon Federation auth. Run this on a machine where you have
# code.vt.edu credentials cached (e.g. after signing in via SSH/HTTPS).
#
# This is the manual fallback for when the submodule-update.yml workflow
# has no VT_GITLAB_TOKEN secret configured. See the workflow file for how
# to enable automated daily updates.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -d external/cicd ]; then
    echo "error: external/cicd not found. Run 'git submodule update --init' first." >&2
    exit 1
fi

echo "Fetching upstream cicd main..."
git -C external/cicd fetch origin main

current_sha="$(git submodule status external/cicd | awk '{print $1}' | sed 's/^[-+]//')"
upstream_sha="$(git -C external/cicd rev-parse origin/main)"

echo "current:  $current_sha"
echo "upstream: $upstream_sha"

if [ "$current_sha" = "$upstream_sha" ]; then
    echo "Already up to date."
    exit 0
fi

echo
echo "Upstream log (newest first):"
git -C external/cicd log --oneline --no-decorate "${current_sha}..${upstream_sha}" | head -20

# Move the submodule pointer. The pre-commit hook allows this because the
# new entry mode is 160000 (gitlink), not a content edit.
git -C external/cicd checkout "$upstream_sha"
git add external/cicd
git commit -m "chore(submodule): bump external/cicd to ${upstream_sha:0:12}

Upstream: https://code.vt.edu/s4-hosting-sites/cicd
$current_sha → $upstream_sha"

echo
echo "Done. Pointer bumped to ${upstream_sha:0:12}."
echo "Push with: git push"
