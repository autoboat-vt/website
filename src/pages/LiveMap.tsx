import L from "leaflet";
import { AlertCircle, Crosshair, Loader2, RefreshCw, Sailboat, Satellite } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import BoatMarker from "../components/BoatMarker";
import Card from "../components/Card";
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
 * Recenter helper: a child of <MapContainer> that imperatively fits the map
 * bounds to all boat positions when `fitTrigger` changes. Lives inside the
 * MapContainer so it can grab the map instance via useMap().
 */
function RecenterOnTrigger({ boats, fitTrigger }: { boats: BoatWithPosition[]; fitTrigger: number }) {
    const map = useMap();
    useEffect(() => {
        if (fitTrigger === 0) return;
        const positions: Array<[number, number]> = [];
        for (const b of boats) {
            if (b.position) positions.push([b.position.lat, b.position.lng]);
        }
        if (positions.length === 0) return;
        if (positions.length === 1) {
            const first = positions[0];
            if (first) map.setView(first, 17, { animate: true });
            return;
        }
        const latLngs = positions.map((p) => {
            const [lat, lng] = p;
            return L.latLng(lat ?? 0, lng ?? 0);
        });
        const bounds = L.latLngBounds(latLngs);
        map.fitBounds(bounds, { padding: [50, 50], animate: true });
    }, [fitTrigger, boats, map]);
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
    const [autoRecenter, setAutoRecenter] = useState(true);

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

    // Auto-recenter whenever the fleet changes, if the user hasn't disabled it.
    useEffect(() => {
        if (autoRecenter && boats.some((b) => b.position)) {
            setFitTrigger((t) => t + 1);
        }
    }, [boats, autoRecenter]);

    const boatsWithPosition = useMemo(() => boats.filter((b) => b.position), [boats]);
    const boatsWithoutPosition = useMemo(() => boats.filter((b) => !b.position), [boats]);

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
        <section className="section mx-auto grid max-w-275 gap-6 px-4 py-10">
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
                                <Loader2 size={14} className="inline animate-spin" /> Connecting…
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
                    <button
                        type="button"
                        onClick={handleRecenter}
                        className="live-map__btn inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-white/60 px-3 py-1.5 text-sm font-semibold text-fontcolor no-underline transition-colors hover:bg-white dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
                    >
                        <Crosshair size={14} /> Recenter
                    </button>
                    <button
                        type="button"
                        onClick={() => setAutoRecenter((v) => !v)}
                        aria-pressed={autoRecenter}
                        className={`live-map__btn inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold no-underline transition-colors ${
                            autoRecenter
                                ? "border-accent/40 bg-accent/10 text-accent dark:border-accent-2/40 dark:bg-accent-2/10 dark:text-accent-2"
                                : "border-black/10 bg-white/60 text-fontcolor hover:bg-white dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
                        }`}
                    >
                        <Satellite size={14} /> Auto-follow {autoRecenter ? "on" : "off"}
                    </button>
                    <button
                        type="button"
                        onClick={handleRetry}
                        className="live-map__btn inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-white/60 px-3 py-1.5 text-sm font-semibold text-fontcolor no-underline transition-colors hover:bg-white dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10"
                    >
                        <RefreshCw size={14} /> Refresh now
                    </button>
                </div>
            </Card>

            {error && (
                <Card className="live-map__error-card">
                    <div className="flex items-start gap-3">
                        <AlertCircle size={24} className="mt-1 shrink-0 text-accent dark:text-accent-2" />
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
                            <button
                                type="button"
                                onClick={handleRetry}
                                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white no-underline transition-colors hover:bg-accent/90 dark:bg-accent-2 dark:hover:bg-accent-2/90"
                            >
                                <RefreshCw size={14} /> Try again
                            </button>
                        </div>
                    </div>
                </Card>
            )}

            {!error && (
                <Card className="live-map__card">
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
                            {boatsWithPosition.map((boat) => (
                                <BoatMarker key={boat.instance.instance_id} boat={boat} />
                            ))}
                            <RecenterOnTrigger boats={boats} fitTrigger={fitTrigger} />
                            <ScaleControl />
                        </MapContainer>
                    </section>
                </Card>
            )}

            {!error && boats.length === 0 && !loading && (
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

            {!error && boatsWithoutPosition.length > 0 && (
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
