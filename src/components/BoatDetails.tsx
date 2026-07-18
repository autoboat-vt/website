import { Anchor, Battery, Compass, Gauge, MapPin, Navigation, Ship, Wind } from "lucide-react";
import type { BoatWithPosition } from "../lib/telemetry";
import { boatModeLabel, formatLastSeen, formatSpeed, headingToCompass } from "../lib/telemetry";

interface BoatDetailsProps {
    /** A single boat with a valid GPS position. */
    boat: BoatWithPosition;
}

/**
 * Current-telemetry stat grid for a single boat.
 *
 * The boat marker itself is icon-only (no click popup); this component
 * shows the same telemetry fields as always-visible stats so you can read
 * them without interacting with the marker. Fields that the boat hasn't
 * reported are omitted rather than rendered as "—", to keep the grid tidy.
 *
 * Rendered inside a `BoatPanel` "Current" tab.
 */
export default function BoatDetails({ boat }: BoatDetailsProps) {
    const { instance, status, position, lastUpdated } = boat;
    const name = instance.instance_identifier || `Boat #${instance.instance_id}`;
    const mode = boatModeLabel(status);

    return (
        <div className="boat-details">
            <dl className="boat-details__stats m-0 grid grid-cols-2 gap-x-3 gap-y-2">
                <Stat icon={<Ship size={13} />} label="Name" value={name} fullWidth />
                {mode && <Stat icon={<Anchor size={13} />} label="Type" value={mode} fullWidth />}
                <Stat icon={<Gauge size={13} />} label="Speed" value={formatSpeed(status?.speed)} />
                <Stat icon={<Compass size={13} />} label="Heading" value={headingToCompass(status?.heading)} />
                {typeof status?.current_waypoint_index === "number" && (
                    <Stat
                        icon={<Navigation size={13} />}
                        label="Waypoint"
                        value={`#${status.current_waypoint_index}`}
                    />
                )}
                {typeof status?.distance_to_next_waypoint === "number" && (
                    <Stat
                        icon={<Anchor size={13} />}
                        label="To next WP"
                        value={`${status.distance_to_next_waypoint.toFixed(0)} m`}
                    />
                )}
                {typeof status?.voltage_to_vesc === "number" && (
                    <Stat
                        icon={<Battery size={13} />}
                        label="Battery"
                        value={`${status.voltage_to_vesc.toFixed(1)} V`}
                    />
                )}
                {typeof status?.apparent_wind_speed === "number" && (
                    <Stat
                        icon={<Wind size={13} />}
                        label="App. wind"
                        value={`${status.apparent_wind_speed.toFixed(1)} m/s`}
                    />
                )}
            </dl>

            <footer className="boat-details__footer">
                <span className="boat-details__dot" aria-hidden="true" />
                <span className="boat-details__updated">Updated {formatLastSeen(lastUpdated)}</span>
                {position && (
                    <span className="boat-details__coords">
                        <MapPin size={11} className="inline" /> {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
                    </span>
                )}
            </footer>
        </div>
    );
}

interface StatProps {
    icon: React.ReactNode;
    label: string;
    value: string;
    /** Span both columns of the stats grid (for the name/type fields). */
    fullWidth?: boolean;
}

function Stat({ icon, label, value, fullWidth }: StatProps) {
    return (
        <div className={`boat-details__stat${fullWidth ? " boat-details__stat--full" : ""}`}>
            <dt className="boat-details__stat-label">
                <span className="boat-details__stat-icon" aria-hidden="true">
                    {icon}
                </span>
                {label}
            </dt>
            <dd className="boat-details__stat-value m-0">{value}</dd>
        </div>
    );
}
