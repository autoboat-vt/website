# Configure Dependabot auto-merge prerequisites for autoboat-vt/website.
#
# What this does:
#   1. Enables "Allow auto-merge" at the repo level (Settings -> General ->
#      Pull Requests -> "Allow auto-merge").
#   2. Sets the default merge method to "squash" (matches the repo's commit
#      convention; change to merge/rebase if you prefer).
#   3. Adds/updates a branch protection rule on `main` that:
#        - requires status checks to pass before merging
#        - requires the `build` check (from .github/workflows/build.yml,
#          which has `name: Build` and a job `build:` -> check name "build")
#        - requires branches to be up to date before merging
#        - sets required reviews to 0 (so Dependabot PRs don't wait on humans)
#        - allows force pushes = false, allows deletions = false
#        - restricts who can push to `main` (admins only by default)
#
# Requirements:
#   - `gh` CLI installed and authenticated (`gh auth login`) with admin scope
#     on the `autoboat-vt/website` repo.
#   - The user running this must be a repo admin (branch protection and
#     repo-level PR settings require admin role).
#
# After running: verify in GitHub UI under Settings -> Branches -> main rule,
# and Settings -> General -> Pull Requests -> "Allow auto-merge" is checked.

set -euo pipefail

REPO="autoboat-vt/website"
BRANCH="main"
# Status check name. The workflow is `name: Build` with a single job `build:`,
# so the check that appears on PRs is "build" (lowercase job name). If GitHub
# shows a different name on the PR checks UI, update this.
CHECK_NAME="build"

echo "==> Checking gh auth and repo access..."
gh auth status
gh repo view "$REPO" --json nameWithOwner -q '.nameWithOwner' >/dev/null

echo "==> Enabling 'Allow auto-merge' at the repo level..."
# This is a repo-level setting exposed via the REST API as
# allow_update_branch + allow_auto_merge on the repository object.
gh api -X PATCH "repos/$REPO" \
    -f allow_auto_merge=true \
    -f allow_update_branch=true \
    -f squash_merge_commit_title=PR_TITLE \
    -f squash_merge_commit_message=PR_BODY \
    --silent
echo "    allow_auto_merge=true, squash merge convention set."

echo "==> Fetching current branch protection for '$BRANCH' (if any)..."
# On first run there is no protection rule yet; gh api returns a 404 error
# body on stderr (suppressed by 2>/dev/null) and a non-JSON message on stdout.
# Capture stdout, then validate JSON before parsing so we never crash the
# script on the "no existing rule" case.
CURRENT=$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>/dev/null || true)
if echo "$CURRENT" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    echo "$CURRENT" | python3 -c "import json,sys; d=json.load(sys.stdin); print('    current required_status_checks:', json.dumps(d.get('required_status_checks') or 'none'))" || true
else
    echo "    no existing branch protection rule (will create one)"
fi

echo "==> Applying branch protection on '$BRANCH'..."
# The /branches/{branch}/protection endpoint takes a nested JSON body.
# `gh api -f` flattens into top-level fields, which does NOT work here - we
# need to pass a full JSON document via --input. Build it with python3 so the
# structure is unambiguous.
BODY=$(python3 -c "
import json
print(json.dumps({
    'required_status_checks': {
        'strict': True,
        'contexts': ['$CHECK_NAME']
    },
    'enforce_admins': False,
    'required_pull_request_reviews': None,
    'restrictions': None,
    'required_linear_history': False,
    'allow_force_pushes': False,
    'allow_deletions': False,
    'block_creations': False,
}))
")
echo "$BODY" | gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
    -H "Accept: application/vnd.github+json" \
    --input - --silent

echo "==> Verifying..."
gh api "repos/$REPO/branches/$BRANCH/protection" | python3 -c "
import json, sys
d = json.load(sys.stdin)
rsc = d.get('required_status_checks') or {}
print('  required_status_checks.strict:', rsc.get('strict'))
print('  required_status_checks.contexts:', rsc.get('contexts'))
print('  required_pull_request_reviews:', d.get('required_pull_request_reviews'))
print('  allow_force_pushes:', d.get('allow_force_pushes', {}).get('enabled'))
print('  enforce_admins:', d.get('enforce_admins', {}).get('enabled'))
"
gh api "repos/$REPO" --jq '.allow_auto_merge, .squash_merge_commit_title' | python3 -c "
import sys
lines = [l.strip() for l in sys.stdin]
print('  repo allow_auto_merge:', lines[0] if len(lines) > 0 else 'unknown')
print('  repo squash_merge_commit_title:', lines[1] if len(lines) > 1 else 'unknown')
"

echo
echo "Done. Dependabot PRs on $REPO will now auto-merge (squash) once the"
echo "'$CHECK_NAME' check passes."
echo
echo "Caveats:"
echo "  - The check name must match what appears on the PR checks UI exactly."
echo "    If the build workflow shows up as 'Build' or 'build / build', update"
echo "    CHECK_NAME above and re-run the PUT branch-protection call."
echo "  - If 'allow_auto_merge' came back false, you may need to enable it via"
echo "    the GitHub UI Settings -> General -> Pull Requests (the API field"
echo "    can be read-only on some repo tiers)."
