import L from "leaflet";
import "leaflet-rotatedmarker";
import { useMemo } from "react";
import { Marker, Popup } from "react-leaflet";
import type { BoatWithPosition } from "../lib/telemetry";
import { formatKnots, formatLastSeen, headingToCompass } from "../lib/telemetry";

interface BoatMarkerProps {
    boat: BoatWithPosition;
}

// Icon size and anchor match ground_station's getBoatIcon(): 50px square,
// centered. The boat-icon.png asset lives in public/images/ so it's served
// at the site root.
const BOAT_ICON_SIZE = 50;
const BOAT_ICON = L.icon({
    iconUrl: "/images/boat-icon.png",
    iconSize: [BOAT_ICON_SIZE, BOAT_ICON_SIZE],
    iconAnchor: [BOAT_ICON_SIZE / 2, BOAT_ICON_SIZE / 2],
    popupAnchor: [0, -BOAT_ICON_SIZE / 2],
});

/**
 * A Leaflet marker for a single boat, rendered with the team's `boat-icon.png`
 * asset and rotated to match its heading. Mimics the ground_station map
 * widget's BoatManager: same icon, same `rotationAngle: 90 - heading`
 * convention (the icon's bow points east at 0°, so we rotate by `90 - heading`
 * to make heading 0° = north).
 */
export default function BoatMarker({ boat }: BoatMarkerProps) {
    const { position, status, instance, lastUpdated } = boat;

    const heading = status?.heading;
    const icon = useMemo(() => BOAT_ICON, []);
    // ground_station convention: icon points east at 0°, so rotate by 90 - heading
    // to align heading 0° with north.
    const rotationAngle = typeof heading === "number" && Number.isFinite(heading) ? 90 - heading : 0;

    if (!position) return null;

    const name = instance.instance_identifier || `Boat #${instance.instance_id}`;
    const mode = boatModeLabel(status);

    return (
        <Marker
            position={[position.lat, position.lng]}
            icon={icon}
            rotationAngle={rotationAngle}
            rotationOrigin="center"
        >
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
