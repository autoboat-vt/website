---
description: "Use when writing or running Jest tests, troubleshooting test mocks for leaflet/react-leaflet, or debugging 'document is not defined' errors in tests. Covers jest.config.js, the react-leaflet mock architecture, moduleNameMapper patterns, setup.ts polyfills, and the VS Code runTests tool gotcha."
applyTo: "src/test/**, jest.config.js"
---

# Testing

- Tests live in `src/test/` mirroring `src/` structure (`src/test/components/`, `src/test/pages/`, `src/test/lib/`)
- Test match: `<rootDir>/src/**/*.{test,spec}.{ts,tsx}`
- `src/test/setup.ts` polyfills `TextEncoder`/`TextDecoder` (needed by react-router's dev bundle) and `window.matchMedia`
- Mocks in `src/test/__mocks__/`: CSS → `styleMock.js`, images → `fileMock.js`, `leaflet.ts`, `react-leaflet.tsx`, `BoatMarker.tsx`
- **The VS Code `runTests` tool does NOT pick up `jest.config.js`** — it runs in a node env and fails with `document is not defined`. Run tests via `bun run test` or `npx jest` in a terminal instead.
- Footer links render a visible `<span>{label}</span>` (icon + visible label text; external links also get an sr-only "(opens in a new tab)" span). Query with `getByText(label)`.
- Components using `<Link>` from `react-router-dom` must be wrapped in `<MemoryRouter>` in tests.

## Jest config (`jest.config.js`)

- `testEnvironment: "jsdom"`, `testMatch: ["<rootDir>/src/**/*.{test,spec}.{ts,tsx}"]`.
- Transform: `@swc/jest` with `parser.syntax: "typescript"`, `tsx: true`, `react.runtime: "automatic"`, `module.type: "es6"`.
- `extensionsToTreatAsEsm: [".ts", ".tsx"]` — ESM in tests.
- `moduleNameMapper` (NOT `jest.mock()` hoisting — unreliable under SWC ESM):
  - `\.(css|less|sass|scss)$` → `styleMock.js`
  - `\.(jpg|jpeg|png|gif|svg|webp|avif)$` → `fileMock.js`
  - `^react-leaflet$` → `react-leaflet.tsx` mock
  - `^leaflet$` → `leaflet.ts` mock
  - `^../components/BoatMarker$` AND `^../../components/BoatMarker$` → `BoatMarker.tsx` mock (both relative depths, because test files live at different depths under `src/test/`)
- `setupFilesAfterEnv: ["<rootDir>/src/test/setup.ts"]` — polyfills `TextEncoder`/`TextDecoder` (react-router dev bundle) and `window.matchMedia`.

## Test mock architecture

The `react-leaflet` mock (`src/test/__mocks__/react-leaflet.tsx`) stubs the entire react-leaflet surface because Leaflet needs a real layout engine and doesn't run cleanly in jsdom. Stubs render plain `<div>` elements tagged with `data-testid` so tests can assert which layers were placed on the map:
- `MapContainer` → `<div data-testid="map-container">`
- `TileLayer` → `<div data-testid="tile-layer" />`
- `Polyline` → `<div data-testid="polyline" data-positions={JSON.stringify(positions)} />`
- `CircleMarker` → `<div data-testid="circle-marker" data-center={JSON.stringify(center)} />`
- `Tooltip` → `<div data-testid="tooltip" data-permanent={...} />`
- `useMap()` returns stubs with no-op `setView`, `fitBounds`, `panTo`, `addControl`, `removeControl`.

Mocks are wired via `jest.config.js` `moduleNameMapper` (not `jest.mock()` hoisting, which is unreliable under SWC ESM). This is why test files don't need a `jest.mock("react-leaflet")` call at the top.
