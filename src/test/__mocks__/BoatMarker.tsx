/**
 * Test mock for the BoatMarker component. The real component builds a
 * Leaflet divIcon with inline SVG, which requires Leaflet's renderer —
 * unnecessary in jsdom. This stub renders a div tagged with the boat id so
 * tests can assert which boats were placed on the map.
 */
import type { BoatWithPosition } from "../../lib/telemetry";

export default function BoatMarker({ boat }: { boat: BoatWithPosition }) {
    return (
        <div data-testid="boat-marker" data-boat-id={boat.instance.instance_id}>
            {boat.instance.instance_identifier ?? `Boat #${boat.instance.instance_id}`}
        </div>
    );
}
