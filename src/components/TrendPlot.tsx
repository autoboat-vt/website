import { useMemo } from "react";
import type { BoatSample } from "../hooks/useBoatHistory";

interface TrendPlotProps {
    /** Accumulated samples for a single boat. */
    samples: BoatSample[] | undefined;
    /** Which field to plot. */
    field: "speed" | "distance";
    /** Human-readable label, e.g. "Speed". */
    label: string;
    /** Unit suffix for axis labels and the current-value badge. */
    unit: string;
    /** Stroke color for the data line (hex). */
    color: string;
    /** Conversion applied to raw values before plotting/display, e.g. m/s→kn. */
    convert?: (v: number) => number;
    /** Number of decimals for displayed values. */
    decimals?: number;
}

// SVG viewBox dimensions.
const VB_W = 340;
const VB_H = 132;
const PAD = { top: 16, right: 46, bottom: 22, left: 38 };
const PLOT_W = VB_W - PAD.left - PAD.right;
const PLOT_H = VB_H - PAD.top - PAD.bottom;

/** Maximum age of samples shown on the plot (matches the history window). */
const WINDOW_MS = 5 * 60 * 1000;

/**
 * A lightweight SVG line chart for a single telemetry field. No external
 * charting dependency — just a polyline, area fill, and minimal axis
 * labels. Responsive via viewBox + width=100%.
 *
 * Handles empty data, single samples, and flat lines (min === max) by
 * padding the y-range so the line doesn't collapse to a point.
 */
export default function TrendPlot({
    samples,
    field,
    label,
    unit,
    color,
    convert = (v) => v,
    decimals = 1,
}: TrendPlotProps) {
    const points = useMemo(() => {
        if (!samples) return [];
        const now = Date.now();
        const cutoff = now - WINDOW_MS;
        return samples
            .filter((s) => s.t >= cutoff && typeof s[field] === "number")
            .map((s) => ({ t: s.t, v: convert(s[field] as number) }));
    }, [samples, field, convert]);

    const { polyline, areaPath, yMin, yMax, lastVal } = useMemo(() => {
        if (points.length === 0) {
            return { polyline: "", areaPath: "", yMin: 0, yMax: 0, lastVal: null };
        }
        const vals = points.map((p) => p.v);
        let min = Math.min(...vals);
        let max = Math.max(...vals);
        // Pad the range so a flat line isn't a single pixel. Also ensures
        // min < max for the interpolation math.
        if (min === max) {
            const pad = Math.max(Math.abs(min) * 0.1, 1);
            min -= pad;
            max += pad;
        } else {
            const pad = (max - min) * 0.1;
            min -= pad;
            max += pad;
        }

        const now = Date.now();
        const cutoff = now - WINDOW_MS;
        const span = now - cutoff;

        const coords = points.map((p) => {
            const x = PAD.left + ((p.t - cutoff) / span) * PLOT_W;
            const y = PAD.top + PLOT_H - ((p.v - min) / (max - min)) * PLOT_H;
            return { x, y };
        });

        const first = coords[0];
        const last = coords[coords.length - 1];
        const lastPoint = points[points.length - 1];
        if (!first || !last || !lastPoint) {
            return { polyline: "", areaPath: "", yMin: 0, yMax: 0, lastVal: null };
        }

        const poly = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");
        const area =
            `M ${first.x.toFixed(2)},${(PAD.top + PLOT_H).toFixed(2)} ` +
            coords.map((c) => `L ${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ") +
            ` L ${last.x.toFixed(2)},${(PAD.top + PLOT_H).toFixed(2)} Z`;

        return {
            polyline: poly,
            areaPath: area,
            yMin: min,
            yMax: max,
            lastVal: lastPoint.v,
        };
    }, [points]);

    const fmt = (v: number) => v.toFixed(decimals);

    return (
        <div className="trend-plot">
            <div className="trend-plot__header">
                <span className="trend-plot__label">{label}</span>
                {lastVal !== null && (
                    <span className="trend-plot__current" style={{ color }}>
                        {fmt(lastVal)} {unit}
                    </span>
                )}
            </div>
            <svg
                className="trend-plot__svg"
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`${label} trend over the last 5 minutes`}
            >
                {/* Gridlines: top, middle, bottom */}
                <line x1={PAD.left} y1={PAD.top} x2={VB_W - PAD.right} y2={PAD.top} className="trend-plot__grid" />
                <line
                    x1={PAD.left}
                    y1={PAD.top + PLOT_H / 2}
                    x2={VB_W - PAD.right}
                    y2={PAD.top + PLOT_H / 2}
                    className="trend-plot__grid"
                />
                <line
                    x1={PAD.left}
                    y1={PAD.top + PLOT_H}
                    x2={VB_W - PAD.right}
                    y2={PAD.top + PLOT_H}
                    className="trend-plot__grid"
                />

                {/* Y-axis labels: max (top), min (bottom) */}
                {points.length > 0 && (
                    <>
                        <text x={PAD.left - 6} y={PAD.top + 4} className="trend-plot__axis" textAnchor="end">
                            {fmt(yMax)}
                        </text>
                        <text
                            x={PAD.left - 6}
                            y={PAD.top + PLOT_H + 4}
                            className="trend-plot__axis"
                            textAnchor="end"
                        >
                            {fmt(yMin)}
                        </text>
                    </>
                )}

                {/* X-axis labels: -5m, now */}
                <text x={PAD.left} y={VB_H - 6} className="trend-plot__axis">
                    −5m
                </text>
                <text x={VB_W - PAD.right} y={VB_H - 6} className="trend-plot__axis" textAnchor="end">
                    now
                </text>

                {/* Area fill + line */}
                {points.length > 0 && (
                    <>
                        <path d={areaPath} fill={color} fillOpacity={0.1} stroke="none" />
                        <polyline points={polyline} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
                        {/* Dot at the latest point */}
                        {points.length > 0 && lastVal !== null && (
                            <circle
                                cx={PAD.left + PLOT_W}
                                cy={
                                    PAD.top +
                                    PLOT_H -
                                    ((lastVal - yMin) / (yMax - yMin)) * PLOT_H
                                }
                                r={3}
                                fill={color}
                            />
                        )}
                    </>
                )}

                {/* Empty state */}
                {points.length === 0 && (
                    <text
                        x={PAD.left + PLOT_W / 2}
                        y={PAD.top + PLOT_H / 2}
                        className="trend-plot__empty"
                        textAnchor="middle"
                        dominantBaseline="middle"
                    >
                        No data yet
                    </text>
                )}
            </svg>
        </div>
    );
}
