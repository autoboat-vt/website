---
description: "Use when working on the live boat map, polling logic, boat selection, map centering, BoatMarker/BoatPanel/BoatDetails/Waypoints/TrendPlot components, or the useBoatHistory hook. Covers polling cadence, in-flight cancellation, visibility-aware polling, boat selection state, CenterOnFirstData/RecenterOnTrigger/ScaleControl patterns, MapTiler tiles, and the react-leaflet Marker rotationAngle imperative-update gotcha."
applyTo: "src/pages/LiveMap.tsx, src/components/BoatMarker.tsx, src/components/BoatPanel.tsx, src/components/BoatDetails.tsx, src/components/BoatTrends.tsx, src/components/Waypoints.tsx, src/components/TrendPlot.tsx, src/hooks/useBoatHistory.ts"
---

# LiveMap page internals (`src/pages/LiveMap.tsx`)

`LiveMap` is the most complex page — it manages polling, boat selection, map centering, and history accumulation. Key constants and patterns:

- `POLL_INTERVAL_MS = 3000` — REST polling cadence (server has no WebSocket/SSE).
- `DEFAULT_CENTER: [0, 0]`, `DEFAULT_ZOOM = 15` — initial map view before data arrives. (0,0) is intentionally far from real boats so the `CenterOnFirstData` effect can detect "first data" and fit bounds.
- **In-flight cancellation**: `abortRef` holds an `AbortController`; each `poll()` aborts the previous before starting. Aborted results are dropped (state not updated).
- **Visibility-aware polling**: `pausedRef` tracks `document.hidden`. On becoming visible, immediately polls rather than waiting for the next interval tick. This avoids wasted requests on background tabs and feels more "live" on refocus.
- **Boat selection state**: `selectedBoatId: number | null` — `null` means "auto" (pick most-recently reporting boat). The user can switch via the toolbar dropdown; only one boat is drawn at a time (marker + waypoints + telemetry panel).
- **`mostRecentBoat`**: derived from `boatsWithPosition` via `reduce`, picking the highest `lastUpdated`; ties broken by lower `instance_id` for determinism. Used as auto-selection and fallback when the selected boat stops reporting.
- **Selection re-sync effect**: if `selectedBoatId` becomes stale (boat stopped reporting), it falls back to `mostRecentBoat.instance_id`. Does NOT override an explicit selection that's still valid.
- **`CenterOnFirstData`**: child of `<MapContainer>` using `useMap()`. Fits bounds to the selected boat + its waypoints on first data arrival only (guarded by `didInitialCenter` ref). Never overrides user pan/zoom afterwards.
- **`RecenterOnTrigger`**: child of `<MapContainer>`. Re-centers on the selected boat when `fitTrigger` increments (the Recenter button click). Uses `fitBounds` not `panTo` so both center and zoom adjust to bring boat + waypoints into view. The latest boat is kept in a ref so the effect dep array is just `[fitTrigger]` — otherwise every 3s poll would re-fit and disrupt the user's view.
- **`ScaleControl`**: child of `<MapContainer>` adding `L.control.scale({ imperial: true, metric: true })` on mount, removed on unmount. Mimics ground_station's `control.scale().addTo(map)`.
- **MapTiler tiles**: `mapTilerKey = "M9yBkV9J49pYUg5o8SGC"` (hardcoded, read-only OSM raster style). URL: `https://api.maptiler.com/maps/openstreetmap/{z}/{x}/{y}.jpg?key=...`. 512px tiles + `zoomOffset: -1` is MapTiler's hi-DPI convention. Uses the OSM style (not a dark style) for both light and dark site modes because MapTiler's dark styles render empty ocean tiles as solid black — at the default (0,0) center the map would look blank.
- **History**: `useBoatHistory(boats, lastUpdated)` accumulates samples once per successful poll.

# Live-map component patterns

## `BoatMarker` (`src/components/BoatMarker.tsx`)

Leaflet `Marker` for a single boat. Props: `boat: BoatWithPosition`. Icon: `/images/boat-icon.webp`, 50px square, centered anchor. Rotation: `90 - heading` (icon's bow points east at 0°, so `90 - heading` makes heading 0° = north). **Important**: react-leaflet's `Marker` wrapper does NOT auto-update custom options like `rotationAngle` after mount — `BoatMarker` keeps a `markerRef` and calls `marker.setRotationAngle(...)` imperatively in a `useEffect` when heading changes. Returns `null` if `boat.position` is null (no GPS fix). No click popup — keeps the map uncluttered. Stubbed in tests (`src/test/__mocks__/BoatMarker.tsx`) because Leaflet needs a real layout engine.

## `BoatPanel` (`src/components/BoatPanel.tsx`)

Per-boat box with Current/History tab switcher. Props: `boat: BoatWithPosition`, `history: BoatHistoryMap`. State: `useState<"current"|"history">`. Renders `BoatDetails` (current) or `BoatTrends` (history). Uses `role="tablist"`/`role="tab"`/`role="tabpanel"` with `aria-selected`. `LiveMap` renders one `<BoatPanel>` per reporting boat.

## `BoatDetails` (`src/components/BoatDetails.tsx`)

Current-telemetry stat grid for a single boat. Props: `boat: BoatWithPosition`. Uses the `transform: scale()` image-zoom pattern with hotspots repositioned via the inverse transform formula (see AGENTS.md "CSS `transform: scale()` affects all descendants" gotcha). Fields the boat hasn't reported are omitted rather than rendered as `—`. Don't pass a `boats[]` array. Icons from `lucide-react`.

## `Waypoints` (`src/components/Waypoints.tsx`)

Dashed `Polyline` + numbered `CircleMarker`s with permanent `Tooltip`s. Props: `waypoints: Waypoint[]`, `currentIndex?: number` (zero-based index of the waypoint the boat is currently heading to). Active waypoint (matching `boat_status.current_waypoint_index`) rendered in the accent color. Colors via CSS vars so they adapt to light/dark without a re-render: `--live-map-route` (polyline), `--live-map-waypoint` (inactive), `--live-map-waypoint-active` (active, burnt orange). CircleMarker radius 6. Tooltip is 1-based (`i + 1`).

## `TrendPlot` (`src/components/TrendPlot.tsx`)

Single-field SVG line chart (no charting library). Props: `samples: BoatSample[] | undefined`, `field: "speed"|"distance"`, `label: string`, `unit: string`, `color: string`, `convert?: (v: number) => number`, `decimals?: number = 1`. SVG viewBox 340×132, padding `{top:16, right:46, bottom:22, left:38}`. `WINDOW_MS = 5 * 60 * 1000` (matches the history window). Handles empty data, single samples, and flat lines (min === max) by padding the y-range so the line doesn't collapse to a point. Responsive via `viewBox` + `width=100%`. `BoatTrends` renders two of them (speed + distance) from the `useBoatHistory` hook.
