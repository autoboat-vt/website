# AutoBoat @ Virginia Tech — Website

React + TypeScript + Vite site for Virginia Tech's AutoBoat team, styled with Tailwind CSS v4 and routed with `react-router-dom`. Deployed to [autoboat.aoe.vt.edu](https://autoboat.aoe.vt.edu/) via VT's S4 (Static Site Storage) service backed by Amazon S3.

> **Contributing?** See [`AGENTS.md`](./AGENTS.md) for project conventions, file-naming rules, config gotchas, and working-style notes. This README is a quick-start overview.

## Routes

| Path           | Page          |
| -------------- | ------------- |
| `/`            | About (Home)  |
| `/ourteam`     | Meet the Team |
| `/fleet`       | Our Fleet     |
| `/live`        | Live Boat Map |
| `/sponsors`    | Sponsors      |
| `/gallery`     | Gallery       |

## Quick start

Requires Node.js 18+. [Bun](https://bun.sh) is the default runner (npm/yarn also work).

```bash
bun install            # install deps
bun run dev            # dev server at http://localhost:3000
bun run build          # production build → dist/
bun run preview        # preview the build
bun run test           # jest unit tests
bun run lint           # biome lint
```

## Deploying

Deployment is manual via `./scripts/deploy.sh` from a local checkout with VT GitLab credentials cached. There is no CI deploy — GitHub Actions does build-only validation on PRs.

```bash
./scripts/deploy.sh              # build + deploy
./scripts/deploy.sh --skip-build # deploy an existing dist/
```

The script builds, fetches `aoe_sites/main`, replaces the worktree contents with `dist/`, commits, and fast-forward pushes to `code.vt.edu/s4-hosting-sites/aoe/sailbot`. The S4 service then syncs `main` to S3 (a few minutes).

One-time setup (contact the Software Officer for VT GitLab access):

```bash
git remote add aoe_sites ssh://git@code.vt.edu/s4-hosting-sites/aoe/sailbot
```
