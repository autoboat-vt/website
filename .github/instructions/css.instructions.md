---
description: "Use when editing src/app.css, writing Tailwind utility classes, debugging CSS cascade/layer issues, overriding inline utilities, writing biome-ignore comments in CSS, or working on the transform: scale() image-zoom pattern. Covers Tailwind v4 layer order, the utilities-beats-components gotcha, !important layer reversal, shorthand syntax, app.css file structure, and the scale-affects-descendants footgun."
applyTo: "src/app.css, src/components/BoatDetails.tsx"
---

# Tailwind CSS v4 layer cascade

Tailwind v4 establishes layer order: `theme, base, utilities`. Custom CSS in `@layer components` in `src/app.css` is merged into the `components` slot, which comes BEFORE `utilities`. Key consequences:

- **Normal (non-`!important`) declarations in `utilities` always beat `components`**, regardless of specificity. A utility class like `grid-cols-[...]` on an element overrides a higher-specificity `.page-foo .bar` rule in `@layer components`.
- To override an inline utility from `@layer components`, use `!important` on the override declaration (preferred), or move the override outside any `@layer` block (fragile — risks unlayering subsequent rules).
- `!important` reverses layer priority: earlier layers beat later layers, and unlayered `!important` loses to all layered `!important`.
- `biome-ignore` comments for CSS must go INSIDE the declaration block, immediately before the property — not before the selector.

# Tailwind v4 shorthand syntax

Use the shorthand forms, not bracket notation:
- `border-black/6` not `border-black/[0.06]`
- `max-w-275` not `max-w-[1100px]`
- `aspect-4/3` not `aspect-[4/3]`
- `h-(--nav-height)` not `h-[var(--nav-height)]`

Theme tokens are defined in `src/app.css` under `@theme` (light) and `.dark` (dark overrides). The `dark:` variant is a **class strategy** (`.dark` on `<html>`), NOT `prefers-color-scheme`.

# CSS `transform: scale()` affects all descendants

Applying `transform: scale(s)` to a container scales ALL descendants (images, text, overlays). For image-zoom with positioned hotspots, scale the `<img>` element only and reposition overlays mathematically using the inverse transform formula. See `src/components/BoatDetails.tsx` for the pattern.

# CSS organization in `src/app.css`

The file has a fixed structure — keep new CSS in the right slot:
- `@custom-variant dark` (line ~13) — defines the `dark:` variant as a class strategy (`.dark` on `<html>`), NOT `prefers-color-scheme`. The `useTheme` hook toggles the `.dark` class.
- `:root` (line ~19) — static CSS custom properties (e.g., `--nav-height: 72px`).
- `@theme` (line ~27) — Tailwind theme tokens (light defaults). Dark-mode overrides live in a separate `.dark {}` block below. Adding a token here makes a `bg-*` / `text-*` / `border-*` utility available.
- `.dark` (line ~52) — dark-mode token overrides (`.dark` class on `<html>`). Brand vars (`--vt-*`) do NOT change between light/dark.
- `@layer base` (line ~71) — element-level resets and base styles (body bg, heading defaults, `:target` scroll-margin).
- `@layer components` (line ~368) — component-scoped classes (`.boat-panel`, `.live-map__panels`, `.trend-plot`, hero animations, hotspots, mobile nav, image modal transitions). Page-scoped classes use `.page-<name>` prefix (e.g., `.page-ourteam .gallery`).

Rules outside any `@layer` block are unlayered and beat all layered normal declarations — use sparingly to avoid breaking the cascade.

# Hash-link navigation

`useEffect` in `App.tsx` watches `useLocation()` and manually scrolls to hash targets offset by `--nav-height` (72px desktop, 64px mobile). Lazy-loaded images shift layout, so the effect re-scrolls on a decay schedule (200/400/700/1100/1600ms). Don't use `window.addEventListener('load', ...)` — the load event can fire before React mounts on client-side navigation.
