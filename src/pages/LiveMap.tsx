import L from "leaflet";
import { AlertCircle, Crosshair, Loader2, RefreshCw, Sailboat } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import BoatMarker from "../components/BoatMarker";
import BoatPanel from "../components/BoatPanel";
import Card from "../components/Card";
import Waypoints from "../components/Waypoints";
import { useBoatHistory } from "../hooks/useBoatHistory";
import {
    type BoatWithPosition,
    fetchFleetState,
    formatLastSeen,
    TELEMETRY_URL,
    TelemetryError,
} from "../lib/telemetry";

/** Polling interval in ms. The server is REST-only (no WebSocket/SSE). */
const POLL_INTERVAL_MS = 3000;

/** Default map center and zoom when no boats are reporting. */
const DEFAULT_CENTER: [number, number] = [0, 0];
const DEFAULT_ZOOM = 15;

/**
 * Collects all positions (boats + waypoints) for the given fleet, used to
 * compute a centroid for centering the map.
 */
function collectPositions(boats: BoatWithPosition[]): Array<[number, number]> {
    const positions: Array<[number, number]> = [];
    for (const b of boats) {
        if (b.position) positions.push([b.position.lat, b.position.lng]);
        if (b.waypoints) {
            for (const [lat, lng] of b.waypoints) {
                positions.push([lat, lng]);
            }
        }
    }
    return positions;
}

/**
 * Builds a Leaflet LatLngBounds that encloses all boat positions and
 * waypoints. Returns null if there are no positions to bound.
 */
function boundsOf(boats: BoatWithPosition[]): L.LatLngBounds | null {
    const positions = collectPositions(boats);
    if (positions.length === 0) return null;
    const bounds = L.latLngBounds(positions.map(([lat, lng]) => L.latLng(lat, lng)));
    return bounds;
}

/**
 * Initial centering: on first data arrival, fits the map view to show the
 * selected boat and its waypoints. The map starts at DEFAULT_CENTER ([0,0])
 * which is usually far from the actual boats — without this one-time fit the
 * user would see an empty ocean until they click "Recenter". Fires exactly
 * once (guarded by a ref) so it never overrides the user's subsequent pan/zoom.
 */
function CenterOnFirstData({ selectedBoat }: { selectedBoat: BoatWithPosition | null }) {
    const map = useMap();
    const didInitialCenter = useRef(false);
    useEffect(() => {
        if (didInitialCenter.current) return;
        if (!selectedBoat) return;
        const bounds = boundsOf([selectedBoat]);
        if (!bounds) return;
        didInitialCenter.current = true;
        map.fitBounds(bounds, { animate: false, padding: [40, 40] });
    }, [selectedBoat, map]);
    return null;
}

/**
 * Recenter helper: a child of <MapContainer> that imperatively re-centers
 * the map on the selected boat when `fitTrigger` changes. Lives inside the
 * MapContainer so it can grab the map instance via useMap().
 *
 * Only fires on an explicit user action (the Recenter button) — polling
 * new data does NOT trigger a recenter, so the user's pan/zoom is preserved
 * across updates. Uses fitBounds (not panTo) so the view adjusts both
 * center and zoom to bring the boat and its waypoints into view — a plain
 * panTo to the centroid would leave the boat off-center whenever waypoints
 * pull the average away from the boat's actual position.
 *
 * The latest `selectedBoat` is kept in a ref so the effect's dependency
 * array is just `[fitTrigger]` — without this, every 3s poll (which may
 * update the selected boat's data) would re-run the effect and re-fit the
 * bounds, disrupting the user's zoom/pan each time new data arrives.
 */
function RecenterOnTrigger({
    selectedBoat,
    fitTrigger,
}: {
    selectedBoat: BoatWithPosition | null;
    fitTrigger: number;
}) {
    const map = useMap();
    const boatRef = useRef(selectedBoat);
    boatRef.current = selectedBoat;
    useEffect(() => {
        if (fitTrigger === 0) return;
        const boat = boatRef.current;
        if (!boat) return;
        const bounds = boundsOf([boat]);
        if (!bounds) return;
        map.fitBounds(bounds, { animate: true, padding: [40, 40] });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitTrigger, map]);
    return null;
}

/**
 * Scale control — mimics ground_station's `control.scale().addTo(map)`.
 * Renders a small scale bar in the bottom-left of the map.
 */
function ScaleControl() {
    const map = useMap();
    useEffect(() => {
        const scale = L.control.scale({ imperial: true, metric: true });
        scale.addTo(map);
        return () => {
            map.removeControl(scale);
        };
    }, [map]);
    return null;
}

export default function LiveMap() {
    const [boats, setBoats] = useState<BoatWithPosition[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);
    const [fitTrigger, setFitTrigger] = useState(0);

    /**
     * The instance_id of the boat to display on the map, or null for
     * "auto" mode (pick the most recently reporting boat). The user can
     * switch via the dropdown in the toolbar; only one boat is drawn at a
     * time (marker + waypoints + telemetry panel).
     */
    const [selectedBoatId, setSelectedBoatId] = useState<number | null>(null);

    // Abort controller for in-flight polls; cancelled on unmount or when a
    // newer poll starts. Keeps state clean across rapid re-renders.
    const abortRef = useRef<AbortController | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pausedRef = useRef(false);

    const poll = useCallback(async () => {
        // Cancel any in-flight poll before starting a new one.
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const fleet = await fetchFleetState({ signal: controller.signal });
            // If we were aborted while awaiting, drop the result.
            if (controller.signal.aborted) return;
            setBoats(fleet);
            setLastUpdated(Date.now());
            setError(null);
        } catch (err) {
            if (controller.signal.aborted) return; // Expected on unmount/replace.
            const msg =
                err instanceof TelemetryError ? err.message : err instanceof Error ? err.message : "Unknown error";
            setError(msg);
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    }, []);

    // Initial load + polling loop with visibility-aware pause.
    useEffect(() => {
        poll();
        intervalRef.current = setInterval(() => {
            if (pausedRef.current) return;
            if (document.hidden) return;
            poll();
        }, POLL_INTERVAL_MS);

        const onVisibility = () => {
            pausedRef.current = document.hidden;
            // On becoming visible again, immediately poll rather than waiting
            // for the next interval tick — feels more "live".
            if (!document.hidden) poll();
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            if (intervalRef.current) clearInterval(intervalRef.current);
            abortRef.current?.abort();
        };
    }, [poll]);

    const boatsWithPosition = useMemo(() => boats.filter((b) => b.position), [boats]);
    const boatsWithoutPosition = useMemo(() => boats.filter((b) => !b.position), [boats]);

    /**
     * The most-recently-reporting boat (highest `lastUpdated`). Ties broken
     * by instance_id for determinism. Used as the "auto" selection when the
     * user hasn't explicitly picked a boat, and as the fallback when the
     * selected boat stops reporting.
     */
    const mostRecentBoat = useMemo(() => {
        if (boatsWithPosition.length === 0) return null;
        return boatsWithPosition.reduce<BoatWithPosition | null>((best, b) => {
            if (!best) return b;
            const bestT = best.lastUpdated ?? -1;
            const bT = b.lastUpdated ?? -1;
            if (bT > bestT) return b;
            if (bT === bestT && b.instance.instance_id < best.instance.instance_id) return b;
            return best;
        }, null);
    }, [boatsWithPosition]);

    /**
     * Keep `selectedBoatId` valid: if it's null (auto) or points to a boat
     * that no longer has a position, fall back to the most-recent boat.
     * Runs whenever the fleet changes so the user always sees *some* boat
     * without having to re-pick. We intentionally don't override an
     * explicit selection that's still valid — only stale/null ones.
     */
    useEffect(() => {
        const selectedStillValid =
            selectedBoatId !== null && boatsWithPosition.some((b) => b.instance.instance_id === selectedBoatId);
        if (selectedStillValid) return;
        const fallback = mostRecentBoat?.instance.instance_id ?? null;
        if (fallback !== selectedBoatId) setSelectedBoatId(fallback);
    }, [selectedBoatId, boatsWithPosition, mostRecentBoat]);

    /**
     * The single boat to render on the map + telemetry panel. Resolved
     * from `selectedBoatId` with a defensive fallback to `mostRecentBoat`
     * for the brief render between a poll update and the effect above
     * re-syncing the selection.
     */
    const selectedBoat = useMemo<BoatWithPosition | null>(() => {
        if (selectedBoatId !== null) {
            const found = boatsWithPosition.find((b) => b.instance.instance_id === selectedBoatId);
            if (found) return found;
        }
        return mostRecentBoat;
    }, [selectedBoatId, boatsWithPosition, mostRecentBoat]);

    // Accumulate per-boat speed/distance samples for the trend plots.
    // Session-scoped (server has no history endpoint); resets on reload.
    const boatHistory = useBoatHistory(boats, lastUpdated);

    const handleRecenter = () => setFitTrigger((t) => t + 1);
    const handleRetry = () => {
        setLoading(true);
        setError(null);
        poll();
    };

    // MapTiler-hosted OpenStreetMap raster style. We use a single style for
    // both light and dark site modes because MapTiler's dark styles render
    // empty ocean tiles as solid black (0,0,0) — at (0,0) the map would look
    // blank. The OSM style renders ocean as light blue, which stays visible.
    // 512px tiles + zoomOffset -1 is MapTiler's hi-DPI convention.
    const mapTilerKey = "M9yBkV9J49pYUg5o8SGC";
    const tileUrl = `https://api.maptiler.com/maps/openstreetmap/{z}/{x}/{y}.jpg?key=${mapTilerKey}`;
    const tileAttribution =
        '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';

    return (
        <section className="section mx-auto grid max-w-275 gap-6 px-4 py-10 lg:max-w-350">
            <Card>
                <span className="kicker">Live Telemetry</span>
                <h3>Boat Tracker</h3>
                <p>
                    Real-time positions of AutoBoat vessels reporting to the{" "}
                    <a
                        href="https://github.com/autoboat-vt/telemetry_server"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent underline"
                    >
                        telemetry server
                    </a>
                    . Updates every {POLL_INTERVAL_MS / 1000}s; pauses when this tab is hidden.
                </p>

                <div className="live-map__toolbar mt-4 flex flex-wrap items-center gap-3">
                    <span className="live-map__status text-sm text-fontcolor/70">
                        {loading && boats.length === 0 ? (
                            <>
                                <Loader2 size={14} className="inline animate-spin" /> Connecting...
                            </>
                        ) : error ? (
                            <>
                                <AlertCircle size={14} className="inline" /> Error
                            </>
                        ) : (
                            <>
                                <span
                                    className={`live-map__dot ${boatsWithPosition.length > 0 ? "is-live" : ""}`}
                                    aria-hidden="true"
                                />
                                {boatsWithPosition.length} of {boats.length} boats reporting · updated{" "}
                                {formatLastSeen(lastUpdated)}
                            </>
                        )}
                    </span>
                    {boatsWithPosition.length > 0 && (
                        <label className="live-map__select-wrap inline-flex items-center gap-1.5 text-sm text-fontcolor/70">
                            <span className="sr-only">Boat to display</span>
                            <select
                                className="live-map__select rounded-lg border border-black/10 bg-white/60 px-2 py-1.5 text-sm font-semibold text-fontcolor transition-colors hover:bg-white dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
                                value={selectedBoatId ?? ""}
                                onChange={(e) =>
                                    setSelectedBoatId(e.target.value === "" ? null : Number(e.target.value))
                                }
                            >
                                <option value="">Auto (most recent)</option>
                                {boatsWithPosition.map((b) => {
                                    const id = b.instance.instance_id;
                                    const name = b.instance.instance_identifier || `Boat #${id}`;
                                    return (
                                        <option key={id} value={id}>
                                            {name}
                                        </option>
                                    );
                                })}
                            </select>
                        </label>
                    )}
                    <button type="button" onClick={handleRecenter} className="btn btn--primary btn--sm">
                        <Crosshair size={14} /> Recenter
                    </button>
                    <button type="button" onClick={handleRetry} className="btn btn--primary btn--sm">
                        <RefreshCw size={14} /> Refresh now
                    </button>
                </div>
            </Card>

            {error && boats.length === 0 && (
                <Card className="live-map__error-card">
                    <div className="flex items-start gap-3">
                        <AlertCircle size={24} className="mt-1 shrink-0 text-accent" />
                        <div>
                            <h4 className="m-0 text-xl font-bold">Can&apos;t reach the telemetry server</h4>
                            <p className="mt-1 text-sm text-fontcolor/70">{error}</p>
                            <p className="mt-2 text-sm text-fontcolor/70">
                                Endpoint: <code className="font-mono text-xs">{TELEMETRY_URL}</code>
                            </p>
                            <p className="mt-2 text-sm text-fontcolor/70">
                                If this persists, the server may be offline, or CORS may not be configured to allow
                                requests from this site.
                            </p>
                            <button type="button" onClick={handleRetry} className="mt-3 btn btn--solid btn--sm">
                                <RefreshCw size={14} /> Try again
                            </button>
                        </div>
                    </div>
                </Card>
            )}

            {/* Map + telemetry side-by-side on wide screens (map left,
                telemetry right); stacked on narrow viewports. Wrapped together
                so the grid owns both children.

                The map is only rendered when there's a selected boat to draw —
                hiding it entirely (rather than showing an empty ocean at 0,0)
                when no boats are registered, none are reporting, or the initial
                load failed. The map stays mounted across transient poll errors
                as long as we still have a previously-fetched boat to display
                (stale-but-visible), so a single failed fetch doesn't tear down
                and rebuild the whole map (re-fetching tiles, losing pan/zoom
                state). */}
            {selectedBoat && (
                <div className="live-map__layout">
                    <Card className="live-map__card">
                        {error && boats.length > 0 && (
                            <div
                                className="live-map__stale-banner mb-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent dark:border-accent/30 dark:bg-accent/10 dark:text-accent"
                                role="status"
                            >
                                <AlertCircle size={14} className="shrink-0" />
                                <span>
                                    Connection lost — showing last known positions.{" "}
                                    <button
                                        type="button"
                                        onClick={handleRetry}
                                        className="font-semibold no-underline hover:opacity-80"
                                    >
                                        Retry now
                                    </button>
                                </span>
                            </div>
                        )}
                        <section className="live-map" aria-label="Live boat positions map">
                            <MapContainer
                                center={DEFAULT_CENTER}
                                zoom={DEFAULT_ZOOM}
                                minZoom={3}
                                maxZoom={20}
                                preferCanvas
                                scrollWheelZoom
                                className="live-map__leaflet"
                            >
                                <TileLayer
                                    url={tileUrl}
                                    attribution={tileAttribution}
                                    tileSize={512}
                                    zoomOffset={-1}
                                    crossOrigin
                                />
                                {selectedBoat?.waypoints && selectedBoat.waypoints.length > 0 && (
                                    <Waypoints
                                        key={`wp-${selectedBoat.instance.instance_id}`}
                                        waypoints={selectedBoat.waypoints}
                                        currentIndex={selectedBoat.status?.current_waypoint_index}
                                    />
                                )}
                                {selectedBoat && (
                                    <BoatMarker key={selectedBoat.instance.instance_id} boat={selectedBoat} />
                                )}
                                <CenterOnFirstData selectedBoat={selectedBoat} />
                                <RecenterOnTrigger selectedBoat={selectedBoat} fitTrigger={fitTrigger} />
                                <ScaleControl />
                            </MapContainer>
                        </section>
                    </Card>

                    {selectedBoat && (
                        <Card className="live-map__details-card">
                            <h4 className="m-0 mb-4 text-lg font-bold">Boat telemetry</h4>
                            <div className="live-map__panels">
                                <BoatPanel
                                    key={selectedBoat.instance.instance_id}
                                    boat={selectedBoat}
                                    history={boatHistory}
                                />
                            </div>
                        </Card>
                    )}
                </div>
            )}

            {!selectedBoat && !error && boats.length === 0 && !loading && (
                <Card>
                    <div className="flex flex-col items-center gap-3 py-8 text-center">
                        <Sailboat size={48} className="text-fontcolor/30" />
                        <h4 className="m-0 text-xl font-bold">No boats registered</h4>
                        <p className="max-w-md text-sm text-fontcolor/70">
                            No instances are registered on the telemetry server yet. Boats will appear here
                            automatically once they start reporting.
                        </p>
                    </div>
                </Card>
            )}

            {boatsWithoutPosition.length > 0 && (
                <Card>
                    <h4 className="m-0 mb-3 text-lg font-bold">Registered but no GPS fix</h4>
                    <ul className="m-0 grid gap-2 p-0 list-none sm:grid-cols-2">
                        {boatsWithoutPosition.map((b) => (
                            <li
                                key={b.instance.instance_id}
                                className="flex items-center justify-between gap-2 rounded-lg border border-black/5 bg-black/3 px-3 py-2 text-sm dark:border-white/5 dark:bg-white/3"
                            >
                                <span className="font-semibold">
                                    {b.instance.instance_identifier || `Boat #${b.instance.instance_id}`}
                                </span>
                                <span className="text-xs text-fontcolor/60">
                                    last seen {formatLastSeen(b.lastUpdated)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
        </section>
    );
}
