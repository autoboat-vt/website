import type { BoatHistoryMap } from "../hooks/useBoatHistory";
import type { BoatWithPosition } from "../lib/telemetry";
import TrendPlot from "./TrendPlot";

interface BoatTrendsProps {
    /** A single boat with a valid GPS position. */
    boat: BoatWithPosition;
    /** Accumulated per-boat history (from useBoatHistory). */
    history: BoatHistoryMap;
}

/**
 * Historical trend plots for a single boat: speed (m/s) and distance to
 * next waypoint (m) over the last 5 minutes.
 *
 * History is session-scoped (the telemetry server is REST-only with no
 * history endpoint), so plots start empty and accumulate samples each
 * poll while the page is open. Rendered inside a `BoatPanel` "History" tab.
 */
export default function BoatTrends({ boat, history }: BoatTrendsProps) {
    const samples = history.get(boat.instance.instance_id);

    return (
        <div className="boat-trends">
            <div className="boat-trends__plots" role="tabpanel">
                <TrendPlot samples={samples} field="speed" label="Speed" unit="m/s" color="#861f41" decimals={1} />
                <TrendPlot
                    samples={samples}
                    field="distance"
                    label="Distance to next WP"
                    unit="m"
                    color="#e5751f"
                    decimals={0}
                />
            </div>
            <p className="boat-trends__hint">History resets when you reload the page.</p>
        </div>
    );
}
