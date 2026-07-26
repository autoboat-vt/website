---
description: "Use when working on the telemetry REST client, boat status types, waypoint fetching, or polling logic. Covers the typed client API, wire format for boat_status/sailboat/motorboat payloads, GPS sentinel, and the BoatWithPosition canonical type."
applyTo: "src/lib/telemetry.ts"
---

# Telemetry client (`src/lib/telemetry.ts`)

Typed REST client for the telemetry server (Flask behind Cloudflare Tunnel; API docs: `github.com/autoboat-vt/telemetry_server`). The server is REST-only — no WebSocket/SSE, so the client polls. The server has no built-in CORS (handled in a companion PR to `telemetry_server`).

## Key exports

- `TELEMETRY_URL` — base URL (from `globalThis.__VITE_TELEMETRY_URL__` or default `https://vt-autoboat-telemetry.uk`).
- `fetchFleetState()` → `BoatWithPosition[]` — fetches instances, then status + waypoints in parallel per instance via `Promise.allSettled`. Failed per-boat fetches are filtered out, not thrown.
- `positionFromStatus(status)` → `{lat, lng} | null` — applies the GPS sentinel (near-zero noise → null).
- `fetchWaypoints(instanceId)` → `Waypoint[] | null` — filters malformed entries.
- `fetchWithTimeout(url, opts)` — wrapper around `fetch` with an `AbortController`-based timeout (default 8000ms). Every method throws on network/HTTP failure so callers can decide how to surface errors.
- Formatters: `headingToCompass`, `formatSpeed`, `formatLastSeen`, `boatModeLabel`.
- Error class: `TelemetryError` — typed error for downstream handling.

`BoatWithPosition` is the canonical type passed to UI components — it joins `InstanceInfo`, `BoatStatus`, `Waypoint[]`, `position`, and `lastUpdated`. Don't fetch raw endpoints from components; go through this module.

## API endpoints

- `GET /instance_manager/get_all_instance_info` → `InstanceInfo[]`
- `GET /boat_status/get/<id>` → `BoatStatus` (has `latitude`, `longitude`)
- `GET /waypoints/get/<id>` → `[[lat, lng], ...]`

## Wire format

`boat_status` is a `dict[str, Any]`; field names are registered per instance via `/boat_status/set_mapping/<id>`. The boat's autopilot software (`autoboat-vt/autoboat_vt`) always sends `latitude`/`longitude` as floats in the base `BoatStatusPayload`, plus mode-specific fields. The `BoatStatus` interface types the common fields and treats the rest as an index of optional values (`[key: string]: unknown`):

- **Base BoatStatusPayload** (always present when a boat is actively reporting): `latitude`, `longitude`, `distance_to_next_waypoint?`, `speed?`, `velocity_x?`, `velocity_y?`, `desired_heading?`, `heading?`, `desired_rudder_angle?`, `current_rudder_angle?`, `rudder_angle_error?`, `current_waypoint_index?`, `boat_control_mode?`.
- **SailboatStatusPayload** (optional): `true_wind_speed?`, `true_wind_angle?`, `apparent_wind_speed?`, `apparent_wind_angle?`, `current_sail_angle?`, `desired_sail_angle?`, `sail_angle_error?`, `boat_autopilot_state?`.
- **MotorboatStatusPayload** (optional): `rpm?`, `duty_cycle?`, `amp_hours?`, `amp_hours_charged?`, `current_to_vesc?`, `voltage_to_motor?`, `voltage_to_vesc?`, `wattage_to_motor?`, `motor_temperature?`, `vesc_temperature?`, `time_since_vesc_startup?`.

`Waypoint` is a typed tuple `[number, number]` (`[lat, lng]` in decimal degrees). The server stores waypoints as `[[lat, lng], ...]` (see `telemetry_server` `routes/waypoints.py`).

## GPS sentinel

Treat `(0, 0)` AND near-zero noise (`Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001`) as "no GPS fix" → return null. Strict `=== 0` lets through tiny floats that snap the map to empty ocean.

## Config

`TELEMETRY_URL` defaults to `https://vt-autoboat-telemetry.uk`. Override at build time via `VITE_TELEMETRY_URL` env var (wired through `vite.config.ts` `define` → `globalThis.__VITE_TELEMETRY_URL__`). Uses `globalThis` not `import.meta.env` because `import.meta` is syntax (can't be polyfilled in Jest).

## `useBoatHistory` hook (`src/hooks/useBoatHistory.ts`)

Accumulates per-boat samples each time `lastUpdated` changes (i.e. once per successful poll). Returns a `BoatHistoryMap` (`Map<number, BoatSample[]>`) keyed by `instance_id`. Samples older than `MAX_AGE_MS = 5 * 60 * 1000` are trimmed. The server is REST-only with no history endpoint, so all history is session-scoped and resets on page reload. Uses a ref for `boats` so the effect's dependency array is just `[lastUpdated]` — this fires exactly once per poll, avoiding double-appending in React StrictMode (dev).

`BoatSample` type: `{ t: number; speed?: number; distance?: number }` — `t` is ms epoch; `speed` is m/s; `distance` is meters to next waypoint. Fields are optional because a boat may report one but not the other; plot components filter to the field they care about.
