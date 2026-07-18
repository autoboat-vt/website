import L from "leaflet";
import { useMemo } from "react";
import { Marker, Popup } from "react-leaflet";
import type { BoatWithPosition } from "../lib/telemetry";
import { formatKnots, formatLastSeen, headingToCompass } from "../lib/telemetry";

interface BoatMarkerProps {
    boat: BoatWithPosition;
}

/**
 * A Leaflet marker for a single boat, rendered as a rotated SVG boat icon
 * (heading-aware) with a popup showing live telemetry.
 *
 * Uses `L.divIcon` with an inline SVG so we avoid the well-known Leaflet
 * default-marker-icon path issue entirely (no asset URL setup needed) and
 * can rotate the boat to match its heading.
 */
export default function BoatMarker({ boat }: BoatMarkerProps) {
    const { position, status, instance, lastUpdated } = boat;

    // Build the divIcon once per (instance, heading) so Leaflet doesn't
    // tear down/rebuild the DOM node on every poll tick.
    const heading = status?.heading;
    const icon = useMemo(() => {
        const rotation = typeof heading === "number" && Number.isFinite(heading) ? heading : 0;
        return L.divIcon({
            className: "boat-marker",
            html: boatIconSvg(rotation),
            iconSize: [36, 36],
            iconAnchor: [18, 18],
            popupAnchor: [0, -18],
        });
    }, [heading]);

    if (!position) return null;

    const name = instance.instance_identifier || `Boat #${instance.instance_id}`;
    const mode = boatModeLabel(status);

    return (
        <Marker position={[position.lat, position.lng]} icon={icon}>
            <Popup>
                <div className="boat-popup">
                    <h3 className="boat-popup__title">{name}</h3>
                    {mode && <p className="boat-popup__mode">{mode}</p>}
                    <dl className="boat-popup__stats">
                        <div>
                            <dt>Speed</dt>
                            <dd>{formatKnots(status?.speed)}</dd>
                        </div>
                        <div>
                            <dt>Heading</dt>
                            <dd>{headingToCompass(heading)}</dd>
                        </div>
                        {typeof status?.current_waypoint_index === "number" && (
                            <div>
                                <dt>Waypoint</dt>
                                <dd>#{status.current_waypoint_index}</dd>
                            </div>
                        )}
                        {typeof status?.distance_to_next_waypoint === "number" && (
                            <div>
                                <dt>To next WP</dt>
                                <dd>{status.distance_to_next_waypoint.toFixed(0)} m</dd>
                            </div>
                        )}
                        {typeof status?.voltage_to_vesc === "number" && (
                            <div>
                                <dt>Battery</dt>
                                <dd>{status.voltage_to_vesc.toFixed(1)} V</dd>
                            </div>
                        )}
                        {typeof status?.apparent_wind_speed === "number" && (
                            <div>
                                <dt>App. wind</dt>
                                <dd>{status.apparent_wind_speed.toFixed(1)} m/s</dd>
                            </div>
                        )}
                    </dl>
                    <p className="boat-popup__last-seen">
                        <span className="boat-popup__dot" aria-hidden="true" />
                        Updated {formatLastSeen(lastUpdated)}
                    </p>
                    <p className="boat-popup__coords">
                        {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
                    </p>
                </div>
            </Popup>
        </Marker>
    );
}

/**
 * Infer a human label for the boat's mode from which optional field groups
 * are present. The boat registers either SailboatStatusPayload or
 * MotorboatStatusPayload (both inherit the base), so presence of a
 * mode-specific field is a reliable signal.
 */
function boatModeLabel(status: BoatWithPosition["status"]): string | null {
    if (!status) return null;
    if (status.apparent_wind_speed !== undefined || status.current_sail_angle !== undefined) {
        return "Sailboat";
    }
    if (status.rpm !== undefined || status.voltage_to_vesc !== undefined || status.duty_cycle !== undefined) {
        return "Motorboat";
    }
    return null;
}

/**
 * Inline SVG for the boat icon. The hull points up (north = 0°) by default;
 * the whole `<svg>` is rotated by `heading` degrees clockwise so it points
 * in the direction of travel. Uses `currentColor` so CSS can theme it.
 */
function boatIconSvg(rotation: number): string {
    return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36" style="transform: rotate(${rotation}deg);">
  <circle cx="18" cy="18" r="17" fill="rgba(31,30,29,0.85)" stroke="#e5751f" stroke-width="2"/>
  <path d="M18 7 L23 24 L18 21 L13 24 Z" fill="#e5751f"/>
</svg>`;
}
