---
description: "Use for routine feature work and bug fixes across the repo. Covers the default workflow: inspect the relevant files first, reproduce or confirm the issue, add or update focused tests when practical, implement the smallest consistent change, and verify before declaring success."
applyTo: "src/**, scripts/**, .github/**, AGENTS.md, README.md, package.json"
---

# Default workflow for this repo

- Start with the smallest relevant scope: the affected component/page, its nearby tests, and any matching instruction file.
- For bugs and regressions, reproduce the issue or confirm the behavior before changing code. If there is no focused test, add one when practical.
- Prefer the smallest change that matches existing patterns. Avoid introducing new abstractions or broad refactors unless the current structure is clearly insufficient.
- If the change affects UI, logic, shared utilities, or routing, update the relevant tests in the same pass rather than leaving the repo partially changed.
- Keep route changes synchronized across the app, the SPA fallback script, and the route documentation.
- Verify before claiming completion. Run the relevant tests and the repo check or build command when the change affects behavior, styling, or shared utilities.
- When the request is ambiguous about routes, copy, asset placement, or deployment behavior, ask for clarification instead of guessing.

## Definition of done

A change is not done until:

1. the relevant code and tests are updated,
2. the intended behavior is verified with the relevant command(s), and
3. the result is reviewed in context rather than assumed.
