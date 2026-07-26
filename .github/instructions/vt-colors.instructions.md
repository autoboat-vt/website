---
description: "Use when working on VT brand colors, the vtColors.ts reference module, theme tokens in app.css, dark mode, or choosing colors for new UI. Covers the VT brand palette, shading-vs-tinting rules, Impact Orange for digital text, WCAG AA contrast requirements, and the CSS custom property definitions in app.css."
applyTo: "src/lib/vtColors.ts, src/app.css, src/hooks/useTheme.ts"
---

# VT brand colors (`src/lib/vtColors.ts`)

Reference module for Virginia Tech official brand colors (source: `brand.vt.edu/identity/color.html`). Exports `VT_COLORS` (typed `VtColor` entries with `name`, `hex`, `rgb`, `cssVar`, `cmyk`, `pantone`) and the `VtColor` interface.

- **Primary**: Chicago Maroon (`#861F41`, `--vt-maroon`, PMS 208), Burnt Orange (`#CF4423`, `--vt-orange`), Hokie Stone, Yardline White.
- **Secondary**: Pylon Purple, Boundless Pink, Triumphant Yellow, Sustainable Teal, Vibrant Turquoise, Land Grant Grey, Skipper Smoke, Impact Orange.

## Brand rules

- Logo files must always be Chicago Maroon + Burnt Orange.
- Shading (darkening) of maroon/orange is permitted; **tinting (lightening) is NOT**. For a translucent look, use a multiply treatment instead.
- Hokie Stone, Yardline White, and secondary colors may be shaded OR tinted.
- "Impact Orange" replaces Burnt Orange for digital text — darker with higher contrast for WCAG AA.
- WCAG 2.1 Level AA contrast required (≥4.5:1 normal text, ≥3:1 large text/UI).

The CSS custom properties (`--vt-maroon`, etc.) are NOT defined in this file — it's a reference. To use them in CSS, define them in `@theme` or `:root` in `src/app.css`.

# Theme tokens & color system (`src/app.css`)

Theme tokens live in `src/app.css` under `@theme` (light) and `.dark` (dark overrides). The `useTheme` hook toggles `.dark` on `<html>`; an inline script in `index.html` sets it before first paint to prevent FOUC.

**Color tokens** (light defaults; `.dark` overrides):
- `--color-bgcolor` — page background (`#f0eee6` light / `#1f1e1d` dark)
- `--color-fontcolor` — primary text (`#1f1e1d` light / `#f0eee6` dark)
- `--color-hovercolor` — hover text (`#3a3836` light / `#d8d4c8` dark)
- `--color-accent` — aliases `--vt-maroon` (Chicago Maroon `#861f41`)
- `--color-accent-2` — aliases `--vt-burntOrange` (Burnt Orange `#e5751f`)

**VT brand vars** (`:root`, do NOT change between light/dark — brand rules permit shading but not tinting of maroon/orange):
- `--vt-maroon` (`#861f41`), `--vt-burntOrange` (`#e5751f`), `--vt-hokieStone` (`#75787b`), `--vt-white` (`#ffffff`), `--vt-impactOrange` (`#ca4f00` — use for digital text instead of burnt orange, WCAG AA)

**Layout tokens**:
- `--nav-height: 72px` desktop, `64px` mobile (`@media (max-width: 900px)` override on `:root`)

**Font tokens** (single source of truth — to change the site font, edit ONLY the `@import` URL at the top of `app.css` and `--font-app`):
- `--font-app: "Ubuntu"` (loaded via Google Fonts `@import` at the top of `app.css`)
- `--font-sans`, `--font-heading` — both derive from `--font-app`
- `--font-mono: "JetBrains Mono"` (not loaded by default — falls through to system monospace)

For alpha variants of brand colors, use `rgb(from var(--vt-maroon) r g b / a)` (relative color syntax) rather than tinting.

## `useTheme` hook (`src/hooks/useTheme.ts`)

Toggles the `.dark` class on `document.documentElement`. Persists choice in `localStorage` under the key `autoboat-theme`. `getInitialTheme()` checks (in order): the `.dark` class on `<html>`, then `localStorage`, then `matchMedia("(prefers-color-scheme: dark)")`. Returns `{ theme: Theme; toggleTheme: () => void }` where `Theme = "light" | "dark"`. The `.dark` variant is defined as a class strategy in `src/app.css` (`@custom-variant dark (&:where(.dark, .dark *))`), NOT `prefers-color-scheme`.

## FOUC prevention (inline script in `index.html`)

`index.html` contains an inline `<script>` in `<body>` that runs before React mounts. It reads `localStorage["autoboat-theme"]` (falling back to `matchMedia("(prefers-color-scheme: dark)")`, then light) and sets:
- `document.documentElement.style.colorScheme = "dark" | "light"` — so native UI (scrollbars, form controls) matches the theme immediately, before CSS loads.
- The `.dark` class on `<html>` — so the first paint already has the correct theme.

This MUST stay in `index.html` (not a React effect) because React mounts after first paint — moving it to React would cause a flash of light theme on every dark-mode page load. The `useTheme` hook keeps React state in sync with the DOM after hydration.
