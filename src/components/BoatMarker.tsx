import L from "leaflet";
import "leaflet-rotatedmarker";
import { useEffect, useMemo, useRef } from "react";
import { Marker } from "react-leaflet";
import type { BoatWithPosition } from "../lib/telemetry";

interface BoatMarkerProps {
    boat: BoatWithPosition;
}

// Icon size and anchor match ground_station's getBoatIcon(): 50px square,
// centered. The boat-icon.png asset lives in public/images/ so it's served
// at the site root.
const BOAT_ICON_SIZE = 50;
const BOAT_ICON = L.icon({
    iconUrl: "/images/boat-icon.webp",
    iconSize: [BOAT_ICON_SIZE, BOAT_ICON_SIZE],
    iconAnchor: [BOAT_ICON_SIZE / 2, BOAT_ICON_SIZE / 2],
});

/**
 * A Leaflet marker for a single boat, rendered with the team's `boat-icon.png`
 * asset and rotated to match its heading. Mimics the ground_station map
 * widget's BoatManager: same icon, same `rotationAngle: 90 - heading`
 * convention (the icon's bow points east at 0°, so we rotate by `90 - heading`
 * to make heading 0° = north).
 */
export default function BoatMarker({ boat }: BoatMarkerProps) {
    const { position, status } = boat;
    const markerRef = useRef<L.Marker>(null);

    const heading = status?.heading;
    const icon = useMemo(() => BOAT_ICON, []);
    // Heading is measured counterclockwise from true east. Since the base icon
    // points east at 0°, we rotate by -heading to align with Leaflet's clockwise rotation.
    const rotationAngle = typeof heading === "number" && Number.isFinite(heading) ? -heading : 0;

    // React-Leaflet's Marker wrapper does not automatically update custom options like
    // rotationAngle when they change after mount. We must update the Leaflet Marker
    // instance imperatively when rotationAngle changes.
    useEffect(() => {
        const marker = markerRef.current;
        if (marker) {
            // @ts-expect-error - leaflet-rotatedmarker adds setRotationAngle to L.Marker
            if (typeof marker.setRotationAngle === "function") {
                // @ts-expect-error
                marker.setRotationAngle(rotationAngle);
            }
        }
    }, [rotationAngle]);

    if (!position) return null;

    // The detailed telemetry card below the map (BoatDetails) shows the
    // same fields as always-visible tiles, so the marker itself has no
    // click popup — keeps the map uncluttered and avoids re-rendering the
    // popup content on every poll.
    return (
        <Marker
            ref={markerRef}
            position={[position.lat, position.lng]}
            icon={icon}
            rotationAngle={rotationAngle}
            rotationOrigin="center"
        />
    );
}
