import { useEffect, useState } from "react";
import type { BoatHistoryMap } from "../hooks/useBoatHistory";
import { boatModeLabel } from "../lib/telemetry";
import type { BoatWithPosition } from "../lib/telemetry";
import TrendPlot from "./TrendPlot";

interface BoatTrendsProps {
    /** Boats with a valid GPS position (the ones rendered on the map). */
    boats: BoatWithPosition[];
    /** Accumulated per-boat history (from useBoatHistory). */
    history: BoatHistoryMap;
}

/** m/s → knots conversion factor. */
const MS_TO_KN = 1.94384;

/**
 * Per-boat tabbed trends panel. Shows one tab per reporting boat; each tab
 * contains two TrendPlots: speed (kn) and distance to next waypoint (m).
 *
 * The tab list is derived from `boats` (current fleet with positions), so
 * boats that stop reporting are removed from the tabs. If the selected
 * boat disappears, the selection resets to the first available boat.
 */
export default function BoatTrends({ boats, history }: BoatTrendsProps) {
    const [selectedId, setSelectedId] = useState<number | null>(null);

    // Reset selection when the selected boat is no longer reporting.
    useEffect(() => {
        if (selectedId !== null && !boats.some((b) => b.instance.instance_id === selectedId)) {
            setSelectedId(boats[0]?.instance.instance_id ?? null);
        }
    }, [boats, selectedId]);

    if (boats.length === 0) return null;

    // Auto-select the first boat if nothing is selected. The empty-array
    // case is handled by the early return above, but noUncheckedIndexedAccess
    // still requires an explicit guard on boats[0].
    const firstBoat = boats[0];
    if (!firstBoat) return null;
    const effectiveId = selectedId ?? firstBoat.instance.instance_id;
    const selectedBoat = boats.find((b) => b.instance.instance_id === effectiveId) ?? firstBoat;
    const samples = history.get(effectiveId);

    return (
        <section className="boat-trends" aria-label="Boat telemetry trends">
            <h5 className="boat-trends__title">Trends (last 5 min)</h5>
            <div className="boat-trends__tabs" role="tablist">
                {boats.map((boat) => {
                    const id = boat.instance.instance_id;
                    const name = boat.instance.instance_identifier || `Boat #${id}`;
                    const mode = boatModeLabel(boat.status);
                    const isActive = id === effectiveId;
                    return (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            className={`boat-trends__tab${isActive ? " is-active" : ""}`}
                            onClick={() => setSelectedId(id)}
                        >
                            <span className="boat-trends__tab-name">{name}</span>
                            {mode && <span className="boat-trends__tab-mode">{mode}</span>}
                        </button>
                    );
                })}
            </div>
            <div className="boat-trends__plots" role="tabpanel">
                <TrendPlot
                    samples={samples}
                    field="speed"
                    label="Speed"
                    unit="kn"
                    color="#861f41"
                    convert={(v) => v * MS_TO_KN}
                    decimals={1}
                />
                <TrendPlot
                    samples={samples}
                    field="distance"
                    label="Distance to next WP"
                    unit="m"
                    color="#e5751f"
                    decimals={0}
                />
            </div>
            <p className="boat-trends__hint">
                Showing {selectedBoat.instance.instance_identifier || `Boat #${selectedBoat.instance.instance_id}`}.
                History resets when you reload the page.
            </p>
        </section>
    );
}
