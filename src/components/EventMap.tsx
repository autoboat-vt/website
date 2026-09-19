import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, TileLayer } from "react-leaflet";

/**
 * Small static map for a calendar event's physical location. The location is
 * a free-text field from Discord event metadata; it has to be geocoded at
 * render time (via OpenStreetMap's public Nominatim service) to get
 * coordinates. The map renders once the first result resolves, shows a single
 * marker, and stays non-interactive in light of the modal (no scroll-wheel
 * zoom hijacking). An "Open directions" link below the map drops out to
 * Google Maps for real navigation.
 */

/** Same read-only MapTiler style as LiveMap so the two maps look the same. */
const MAPTILER_KEY = "M9yBkV9J49pYUg5o8SGC";
const TILE_URL = `https://api.maptiler.com/maps/openstreetmap/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`;
const TILE_ATTRIBUTION =
    '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">MapTiler</a> ' +
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';

const MAP_ZOOM = 16;

interface GeocodeResult {
    lat: string;
    lon: string;
}

export interface EventMapProps {
    /** Free-text location ("Holden Auditorium", "1830 Alumni Mall"). */
    location: string;
}

/**
 * Geocode a free-text location via Nominatim. Returns null when nothing
 * matches or the request fails (the map silently stays hidden in that case).
 * A descriptive User-Agent is required by the public-service usage policy.
 */
async function geocode(query: string, signal: AbortSignal): Promise<[number, number] | null> {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    try {
        const res = await fetch(url, {
            signal,
            headers: { "User-Agent": "autoboat-website/1.0 (https://autoboat.aoe.vt.edu)" },
        });
        if (!res.ok) return null;
        const results = (await res.json()) as GeocodeResult[];
        if (!Array.isArray(results) || results.length === 0) return null;
        const first = results[0];
        if (!first) return null;
        const lat = Number.parseFloat(first.lat);
        const lng = Number.parseFloat(first.lon);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
    } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return null;
        return null;
    }
}

function directionsUrl([lat, lng]: [number, number], query: string): string {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&query=${encodeURIComponent(query)}`;
}

export default function EventMap({ location }: EventMapProps) {
    const [coords, setCoords] = useState<[number, number] | null>(null);
    const [settled, setSettled] = useState(false);
    const requestRef = useRef<AbortController | null>(null);

    useEffect(() => {
        requestRef.current?.abort();
        const ctrl = new AbortController();
        requestRef.current = ctrl;
        setCoords(null);
        setSettled(false);
        geocode(location, ctrl.signal).then((result) => {
            if (ctrl.signal.aborted) return;
            setCoords(result);
            setSettled(true);
        });
        return () => ctrl.abort();
    }, [location]);

    // Don't render anything at all until a geocode attempt has completed; while
    // loading (or when nothing matched / the location was virtual) the modal
    // just shows the text location on its own.
    if (!settled || !coords) return null;

    return (
        <div className="event-map">
            <MapContainer
                className="event-map__container"
                center={coords}
                zoom={MAP_ZOOM}
                scrollWheelZoom={false}
                attributionControl={false}
                zoomControl={false}
                dragging={false}
                touchZoom={false}
                doubleClickZoom={false}
                keyboard={false}
            >
                <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
                <CircleMarker
                    center={coords}
                    radius={8}
                    pathOptions={{
                        color: "var(--vt-maroon)",
                        weight: 2,
                        fillColor: "var(--vt-maroon)",
                        fillOpacity: 0.35,
                    }}
                />
            </MapContainer>
            <a
                className="event-map__directions"
                href={directionsUrl(coords, location)}
                target="_blank"
                rel="noopener noreferrer"
            >
                Open directions <ExternalLink size={12} aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
            </a>
        </div>
    );
}
