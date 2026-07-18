import { useMemo } from "react";
import { CircleMarker, Polyline, Tooltip } from "react-leaflet";
import type { Waypoint } from "../lib/telemetry";

interface WaypointsProps {
    waypoints: Waypoint[];
    /** Zero-based index of the waypoint the boat is currently heading to.
     *  Highlighted with the accent color; the rest use the muted color. */
    currentIndex?: number;
}

/**
 * Renders a boat's waypoint list on the map as a dashed polyline connecting
 * numbered circle markers. Mimics the essentials of the ground_station map
 * widget (which shows waypoints as colored markers), adapted for the
 * read-only website: the route line is shown because a viewer can't click
 * to add/remove waypoints, so the connecting path is the most useful
 * extra information.
 *
 * - Polyline: dashed, semi-transparent, themed for light/dark.
 * - Markers: small circles with a permanent numbered tooltip (1-based).
 *   The waypoint matching `currentIndex` (from boat_status) is rendered in
 *   the accent color to show which one the boat is heading toward.
 */
export default function Waypoints({ waypoints, currentIndex }: WaypointsProps) {
    const positions = useMemo<Array<[number, number]>>(() => {
        // Leaflet wants [lat, lng] tuples; our Waypoint type is already that.
        return waypoints.map(([lat, lng]) => [lat, lng] as [number, number]);
    }, [waypoints]);

    // CSS color vars resolved at paint time, so they adapt to light/dark
    // site themes. Leaflet renders canvas paths with the exact string we
    // pass, so this picks up the current theme without a re-render.
    const lineColor = "var(--live-map-route, #2563eb)";
    const inactiveColor = "var(--live-map-waypoint, #6b7280)";
    const activeColor = "var(--live-map-waypoint-active, #dc2626)";

    if (positions.length === 0) return null;

    return (
        <>
            {positions.length > 1 && (
                <Polyline
                    positions={positions}
                    pathOptions={{
                        color: lineColor,
                        weight: 2,
                        opacity: 0.7,
                        dashArray: "6 6",
                        lineCap: "round",
                        lineJoin: "round",
                    }}
                />
            )}
            {positions.map((pos, i) => {
                const isActive = typeof currentIndex === "number" && i === currentIndex;
                const color = isActive ? activeColor : inactiveColor;
                return (
                    <CircleMarker
                        key={`wp-${pos[0]}-${pos[1]}-${i}`}
                        center={pos}
                        radius={6}
                        pathOptions={{
                            color,
                            weight: 2,
                            fillColor: color,
                            fillOpacity: 0.9,
                        }}
                    >
                        <Tooltip permanent direction="top" offset={[0, -4]} className="live-map__wp-tooltip">
                            {i + 1}
                        </Tooltip>
                    </CircleMarker>
                );
            })}
        </>
    );
}
