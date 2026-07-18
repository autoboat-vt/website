import { useEffect, useRef, useState } from "react";
import type { BoatWithPosition } from "../lib/telemetry";

/**
 * A single telemetry sample captured at time `t` (ms epoch).
 * Fields are optional — a boat may report speed but not distance, or
 * vice versa. The plot components filter to the field they care about.
 */
export interface BoatSample {
    /** Capture time in ms (epoch). */
    t: number;
    /** Boat speed in m/s (may be undefined if not reported). */
    speed?: number;
    /** Distance to next waypoint in meters (may be undefined). */
    distance?: number;
}

/** Map of instance_id → accumulated samples (oldest first). */
export type BoatHistoryMap = Map<number, BoatSample[]>;

/** How far back to keep samples. Matches the "last 5 minutes" plot window. */
const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Accumulates per-boat telemetry samples each time `lastUpdated` changes
 * (i.e. once per successful poll). Samples older than 5 minutes are
 * trimmed. The server is REST-only with no history endpoint, so all
 * history is session-scoped and resets on page reload.
 *
 * Uses a ref for `boats` so the effect's dependency array is just
 * `[lastUpdated]` — this fires exactly once per poll, avoiding
 * double-appending in React StrictMode (dev).
 */
export function useBoatHistory(boats: BoatWithPosition[], lastUpdated: number | null): BoatHistoryMap {
    const [history, setHistory] = useState<BoatHistoryMap>(new Map());
    const boatsRef = useRef(boats);
    boatsRef.current = boats;

    useEffect(() => {
        if (lastUpdated === null) return;
        const currentBoats = boatsRef.current;
        const now = Date.now();
        const cutoff = now - MAX_AGE_MS;

        setHistory((prev) => {
            const next = new Map(prev);
            for (const boat of currentBoats) {
                if (!boat.position) continue;
                const id = boat.instance.instance_id;
                const sample: BoatSample = {
                    t: now,
                    speed: boat.status?.speed,
                    distance: boat.status?.distance_to_next_waypoint,
                };
                const existing = next.get(id) ?? [];
                // Append + trim in one pass (filter keeps ordering).
                const updated = existing.filter((s) => s.t >= cutoff);
                updated.push(sample);
                next.set(id, updated);
            }
            // Drop boats that have stopped reporting.
            const currentIds = new Set(currentBoats.map((b) => b.instance.instance_id));
            for (const id of next.keys()) {
                if (!currentIds.has(id)) next.delete(id);
            }
            return next;
        });
    }, [lastUpdated]);

    return history;
}
