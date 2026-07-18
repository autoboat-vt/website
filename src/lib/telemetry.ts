/**
 * Typed client for the AutoBoat telemetry server REST API.
 *
 * API docs: https://github.com/autoboat-vt/telemetry_server
 * Production: https://vt-autoboat-telemetry.uk (Flask behind Cloudflare Tunnel)
 *
 * Wire format notes:
 *  - `boat_status` is a `dict[str, Any]`; field names are registered per
 *    instance via `/boat_status/set_mapping/<id>`. The boat's autopilot
 *    software (autoboat-vt/autoboat_vt) always sends `latitude`/`longitude`
 *    as floats in the base BoatStatusPayload, plus mode-specific fields.
 *  - There is no WebSocket/SSE; this client polls REST endpoints.
 *  - The server has no built-in CORS (see companion PR to telemetry_server).
 *
 * Every method throws on network/HTTP failure so callers can decide how to
 * surface errors (the LiveMap page shows a friendly error state).
 */

/**
 * Base URL of the telemetry server. Override per-environment with
 * `VITE_TELEMETRY_URL` (e.g. for local dev against a tunnel). Falls back to
 * the production URL.
 *
 * We read this from `globalThis.__VITE_TELEMETRY_URL__` (populated by Vite's
 * `define` in vite.config.ts) rather than `import.meta.env` so the source
 * parses under Jest's CJS runtime, where `import.meta` is a syntax error.
 */
declare global {
    // eslint-disable-next-line no-var
    var __VITE_TELEMETRY_URL__: string | undefined;
}

export const TELEMETRY_URL: string = globalThis.__VITE_TELEMETRY_URL__ || "https://vt-autoboat-telemetry.uk";

/** An instance registered on the telemetry server (one per boat/config). */
export interface InstanceInfo {
    instance_id: number;
    instance_identifier: string;
    user: string;
    current_config_hash: string;
    created_at: string;
    updated_at: string;
}

/**
 * A boat_status payload. The base struct (always present when a boat is
 * actively reporting) includes GPS + navigation fields. Sailboats add wind
 * fields; motorboats add power/battery fields. We type the common fields
 * and treat the rest as an index of optional values.
 */
export interface BoatStatus {
    // --- Base BoatStatusPayload (always present) ---
    latitude: number;
    longitude: number;
    distance_to_next_waypoint?: number;
    speed?: number;
    velocity_x?: number;
    velocity_y?: number;
    desired_heading?: number;
    heading?: number;
    desired_rudder_angle?: number;
    current_rudder_angle?: number;
    rudder_angle_error?: number;
    current_waypoint_index?: number;
    boat_control_mode?: number;

    // --- SailboatStatusPayload (optional) ---
    true_wind_speed?: number;
    true_wind_angle?: number;
    apparent_wind_speed?: number;
    apparent_wind_angle?: number;
    current_sail_angle?: number;
    desired_sail_angle?: number;
    sail_angle_error?: number;
    boat_autopilot_state?: number;

    // --- MotorboatStatusPayload (optional) ---
    rpm?: number;
    duty_cycle?: number;
    amp_hours?: number;
    amp_hours_charged?: number;
    current_to_vesc?: number;
    voltage_to_motor?: number;
    voltage_to_vesc?: number;
    wattage_to_motor?: number;
    motor_temperature?: number;
    vesc_temperature?: number;
    time_since_vesc_startup?: number;

    // Allow any other fields the boat registered.
    [key: string]: unknown;
}

/**
 * A boat with its latest known position and metadata, ready to render on
 * the map. `position` is null when the boat has no GPS fix yet.
 *
 * `waypoints` holds the latest waypoint list for the boat's instance, or
 * null if the waypoints fetch failed / hadn't been requested.
 */
export interface BoatWithPosition {
    instance: InstanceInfo;
    status: BoatStatus | null;
    /** Epoch ms of the last status update we successfully fetched. */
    lastUpdated: number | null;
    position: { lat: number; lng: number } | null;
    /**
     * Latest waypoint list for this instance (read from
     * `/waypoints/get/<id>`), or null if the fetch failed or returned no
     * list. Each waypoint is `[lat, lng]` in decimal degrees.
     */
    waypoints: Waypoint[] | null;
}

/**
 * A single waypoint as stored on the telemetry server. The server stores
 * waypoints as `[[lat, lng], ...]` (see telemetry_server `routes/waypoints.py`
 * — each point must be a `[lat, lng]` pair of numbers). We model the pair as
 * a typed tuple for clarity at call sites.
 */
export type Waypoint = [number, number];

/** Options for fetchWithTimeout. */
interface FetchOptions {
    signal?: AbortSignal;
    /** Request timeout in ms. Defaults to 8000 (8s). */
    timeoutMs?: number;
}

/**
 * Fetch wrapper with timeout. Throws a `TelemetryError` on any failure
 * (network error, timeout, non-2xx response, JSON parse error) so callers
 * get a single error type to handle.
 */
export class TelemetryError extends Error {
    readonly statusCode?: number;
    constructor(message: string, statusCode?: number) {
        super(message);
        this.name = "TelemetryError";
        this.statusCode = statusCode;
    }
}

async function fetchJson<T>(path: string, opts: FetchOptions = {}): Promise<T> {
    const url = `${TELEMETRY_URL}${path}`;
    const timeoutMs = opts.timeoutMs ?? 8000;

    // Abort on timeout, but also respect a caller-supplied signal (e.g. for
    // pausing polling when the tab is hidden).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);

    // Bridge a caller-supplied AbortSignal to our controller. We must remove
    // the listener afterwards to avoid a leak across many polls.
    const callerSignal = opts.signal;
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
        if (callerSignal.aborted) {
            controller.abort(callerSignal.reason);
        } else {
            callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }
    }

    try {
        let response: Response;
        try {
            response = await fetch(url, {
                signal: controller.signal,
                headers: { Accept: "application/json" },
                mode: "cors",
            });
        } catch (err) {
            if (err instanceof DOMException && err.name === "TimeoutError") {
                throw new TelemetryError(`Request to ${path} timed out after ${timeoutMs}ms`);
            }
            if (controller.signal.aborted) {
                // Caller aborted (e.g. tab hidden, or component unmounted).
                throw new TelemetryError(`Request to ${path} was aborted`);
            }
            // Most common in practice: CORS failure, DNS, or offline. Hard to
            // distinguish from fetch() alone, so give a generic message.
            throw new TelemetryError(`Network error reaching ${url}: ${(err as Error).message}`);
        }

        if (!response.ok) {
            throw new TelemetryError(
                `${path} returned HTTP ${response.status} ${response.statusText}`,
                response.status,
            );
        }

        try {
            return (await response.json()) as T;
        } catch (err) {
            throw new TelemetryError(`Failed to parse JSON from ${path}: ${(err as Error).message}`);
        }
    } finally {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    }
}

/** True if a value looks like a finite GPS coordinate. */
function isValidCoord(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** Extract a `{lat, lng}` from a status payload, or null if missing/invalid. */
export function positionFromStatus(status: BoatStatus | null): { lat: number; lng: number } | null {
    if (!status) return null;
    const { latitude, longitude } = status;
    if (isValidCoord(latitude) && isValidCoord(longitude)) {
        // Reject the obvious sentinel (0,0) which means "no GPS fix" on most
        // GPS modules. The boat will still send it as a float; we treat it
        // as "no position" so the marker doesn't snap to the Gulf of Guinea.
        if (latitude === 0 && longitude === 0) return null;
        return { lat: latitude, lng: longitude };
    }
    return null;
}

/**
 * GET /instance_manager/get_all_instance_info
 * Returns every instance registered on the server.
 */
export async function fetchAllInstances(opts?: FetchOptions): Promise<InstanceInfo[]> {
    const data = await fetchJson<InstanceInfo[]>("/instance_manager/get_all_instance_info", opts);
    if (!Array.isArray(data)) {
        throw new TelemetryError("Expected an array from get_all_instance_info");
    }
    return data;
}

/**
 * GET /boat_status/get/<id>
 * Returns the full boat_status dict for an instance. May be `{}` if the
 * boat has never reported.
 */
export async function fetchBoatStatus(instanceId: number, opts?: FetchOptions): Promise<BoatStatus | null> {
    const data = await fetchJson<BoatStatus | Record<string, never>>(`/boat_status/get/${instanceId}`, opts);
    if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
        return null;
    }
    return data as BoatStatus;
}

/**
 * GET /boat_status/get_new/<id>
 * Returns the boat_status dict only if it has been updated since the last
 * call to this endpoint; otherwise returns `{}`. Ideal for polling.
 */
export async function fetchBoatStatusIfNew(instanceId: number, opts?: FetchOptions): Promise<BoatStatus | null> {
    const data = await fetchJson<BoatStatus | Record<string, never>>(`/boat_status/get_new/${instanceId}`, opts);
    if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
        return null;
    }
    return data as BoatStatus;
}

/**
 * GET /waypoints/get/<id>
 * Returns the current waypoint list for an instance, or null when the
 * instance has no waypoints (server returns `[]`) or the payload is
 * malformed. The server stores waypoints as `[[lat, lng], ...]`.
 */
export async function fetchWaypoints(instanceId: number, opts?: FetchOptions): Promise<Waypoint[] | null> {
    const data = await fetchJson<unknown>(`/waypoints/get/${instanceId}`, opts);
    if (!Array.isArray(data)) return null;
    // Normalize: keep only entries that are `[lat, lng]` pairs of finite
    // numbers. The server validates on write, but the client is defensive.
    const waypoints: Waypoint[] = [];
    for (const point of data) {
        if (!Array.isArray(point) || point.length !== 2) continue;
        const [lat, lng] = point;
        if (typeof lat === "number" && Number.isFinite(lat) && typeof lng === "number" && Number.isFinite(lng)) {
            waypoints.push([lat, lng]);
        }
    }
    return waypoints.length > 0 ? waypoints : null;
}

/**
 * Fetch all instances and their latest boat_status in parallel, returning a
 * list of `BoatWithPosition` ready for the map. Instances whose status fetch
 * fails (e.g. transient error) are still included with `status: null` so the
 * UI can show "last known" without dropping the boat entirely.
 *
 * Waypoints are fetched alongside each instance's status (one extra
 * `/waypoints/get/<id>` call per boat). A failed waypoints fetch leaves
 * `waypoints: null` on that boat but keeps the rest of its data intact.
 */
export async function fetchFleetState(opts?: FetchOptions): Promise<BoatWithPosition[]> {
    const instances = await fetchAllInstances(opts);

    const results = await Promise.allSettled(
        instances.map(async (instance): Promise<BoatWithPosition> => {
            // Fetch status and waypoints in parallel — they're independent
            // endpoints. If either fails, we keep the other's result and
            // surface null for the failed one so the UI still shows the boat.
            const [statusResult, waypointsResult] = await Promise.allSettled([
                fetchBoatStatus(instance.instance_id, opts),
                fetchWaypoints(instance.instance_id, opts),
            ]);
            const status = statusResult.status === "fulfilled" ? statusResult.value : null;
            const waypoints = waypointsResult.status === "fulfilled" ? waypointsResult.value : null;
            return {
                instance,
                status,
                lastUpdated: status ? Date.now() : null,
                position: positionFromStatus(status),
                waypoints,
            };
        }),
    );

    return results.map((result, i) => {
        const instance = instances[i];
        if (!instance) {
            // Should be impossible (results come from instances), but
            // noUncheckedIndexedAccess requires the guard.
            throw new TelemetryError("Instance list shifted during fetchFleetState");
        }
        if (result.status === "fulfilled") {
            return result.value;
        }
        // Status fetch failed — keep the instance with no position so the UI
        // can still show it as "registered but unreachable".
        return {
            instance,
            status: null,
            lastUpdated: null,
            position: null,
            waypoints: null,
        } satisfies BoatWithPosition;
    });
}

/** Format a heading in degrees as a compass direction, e.g. 0→N, 225→SW. */
export function headingToCompass(degrees?: number): string {
    if (typeof degrees !== "number" || !Number.isFinite(degrees)) return "—";
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
    const idx = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
    const dir = dirs[idx] ?? "?";
    return `${dir} (${degrees.toFixed(0)}°)`;
}

/** Format a speed in m/s, or "—" if missing. */
export function formatSpeed(speedMs?: number): string {
    if (typeof speedMs !== "number" || !Number.isFinite(speedMs)) return "—";
    return `${speedMs.toFixed(3)} m/s`;
}

/** Format a Unix epoch ms as a relative "x seconds ago" string. */
export function formatLastSeen(epochMs: number | null): string {
    if (epochMs === null) return "never";
    const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

/**
 * Infer a human label for the boat's mode from which optional field groups
 * are present. The boat registers either SailboatStatusPayload or
 * MotorboatStatusPayload (both inherit the base), so presence of a
 * mode-specific field is a reliable signal. Returns null if the boat has
 * no status yet or its mode can't be inferred.
 */
export function boatModeLabel(status: BoatStatus | null): string | null {
    if (!status) return null;
    if (status.apparent_wind_speed !== undefined || status.current_sail_angle !== undefined) {
        return "Sailboat";
    }
    if (status.rpm !== undefined || status.voltage_to_vesc !== undefined || status.duty_cycle !== undefined) {
        return "Motorboat";
    }
    return null;
}
