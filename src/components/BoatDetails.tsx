import { Anchor, Battery, Compass, Gauge, MapPin, Navigation, Wind } from "lucide-react";
import type { BoatWithPosition } from "../lib/telemetry";
import { boatModeLabel, formatKnots, formatLastSeen, headingToCompass } from "../lib/telemetry";

interface BoatDetailsProps {
    /** Boats with a valid GPS position (the ones rendered on the map). */
    boats: BoatWithPosition[];
}

/**
 * A compact stat tile rendered below the map for each reporting boat.
 *
 * The map popup (see BoatMarker.tsx) shows the same fields on click; this
 * component mirrors them as always-visible cards so you can read telemetry
 * without interacting with the marker. Fields that the boat hasn't reported
 * are omitted rather than rendered as "—", to keep the grid tidy.
 */
export default function BoatDetails({ boats }: BoatDetailsProps) {
    if (boats.length === 0) return null;

    return (
        <section className="boat-details" aria-label="Boat telemetry details">
            <ul className="boat-details__list m-0 list-none p-0 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {boats.map((boat) => {
                    const { instance, status, position, lastUpdated } = boat;
                    const name = instance.instance_identifier || `Boat #${instance.instance_id}`;
                    const mode = boatModeLabel(status);
                    return (
                        <li key={instance.instance_id} className="boat-details__card">
                            <header className="boat-details__header">
                                <h4 className="boat-details__name m-0">{name}</h4>
                                {mode && <span className="boat-details__mode">{mode}</span>}
                            </header>

                            <dl className="boat-details__stats m-0 grid grid-cols-2 gap-x-3 gap-y-2">
                                <Stat icon={<Gauge size={13} />} label="Speed" value={formatKnots(status?.speed)} />
                                <Stat
                                    icon={<Compass size={13} />}
                                    label="Heading"
                                    value={headingToCompass(status?.heading)}
                                />
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
                                        <MapPin size={11} className="inline" /> {position.lat.toFixed(5)},{" "}
                                        {position.lng.toFixed(5)}
                                    </span>
                                )}
                            </footer>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

interface StatProps {
    icon: React.ReactNode;
    label: string;
    value: string;
}

function Stat({ icon, label, value }: StatProps) {
    return (
        <div className="boat-details__stat">
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
