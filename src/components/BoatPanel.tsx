import { useState } from "react";
import type { BoatHistoryMap } from "../hooks/useBoatHistory";
import type { BoatWithPosition } from "../lib/telemetry";
import { boatModeLabel } from "../lib/telemetry";
import BoatDetails from "./BoatDetails";
import BoatTrends from "./BoatTrends";

interface BoatPanelProps {
    /** A single boat with a valid GPS position. */
    boat: BoatWithPosition;
    /** Accumulated per-boat history (from useBoatHistory). */
    history: BoatHistoryMap;
}

type Tab = "current" | "history";

/**
 * A single boat's telemetry box with two tabs:
 *
 * - **Current** — live stat grid (speed, heading, waypoint, battery, …).
 * - **History** — 5-minute line plots for speed and distance to next WP.
 *
 * One `BoatPanel` is rendered per reporting boat, so each boat gets its
 * own card with independently switchable Current/History views.
 */
export default function BoatPanel({ boat, history }: BoatPanelProps) {
    const [tab, setTab] = useState<Tab>("current");

    const name = boat.instance.instance_identifier || `Boat #${boat.instance.instance_id}`;
    const mode = boatModeLabel(boat.status);

    return (
        <section className="boat-panel" aria-label={`Telemetry for ${name}`}>
            <header className="boat-panel__header">
                <h5 className="boat-panel__title">{name}</h5>
                {mode && <span className="boat-panel__mode">{mode}</span>}
            </header>

            <div className="boat-panel__tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "current"}
                    className={`boat-panel__tab${tab === "current" ? " is-active" : ""}`}
                    onClick={() => setTab("current")}
                >
                    Current
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "history"}
                    className={`boat-panel__tab${tab === "history" ? " is-active" : ""}`}
                    onClick={() => setTab("history")}
                >
                    History
                </button>
            </div>

            {tab === "current" ? (
                <div className="boat-panel__body" role="tabpanel">
                    <BoatDetails boat={boat} />
                </div>
            ) : (
                <div className="boat-panel__body" role="tabpanel">
                    <BoatTrends boat={boat} history={history} />
                </div>
            )}
        </section>
    );
}
