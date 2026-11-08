import { Activity, AlertCircle, Database, Gauge, Loader2, type LucideIcon, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { errorRate, fetchMetrics, type MetricsPayload, totalDbQueries, totalRequests } from "../lib/metricsClient";
import Card from "./Card";

/** Polling interval. The Worker caches the payload for 15s, so faster is wasted. */
const POLL_INTERVAL_MS = 15_000;

/** Shared sparkline stroke, so every trend in the grid matches. */
const SPARKLINE_STROKE = "var(--color-hovercolor, #6b7280)";

/**
 * How many samples of history the sparklines keep.
 *
 * The payload carries only the CURRENT value, so history is accumulated in the
 * browser across polls. 40 samples at 15s is 10 minutes of trend -- enough to
 * see a spike without holding an unbounded array in memory on a page someone
 * leaves open all day.
 */
const HISTORY_LENGTH = 40;

/** A named time series kept in component state for the sparkline charts. */
interface Series {
    label: string;
    values: number[];
    /** Rendered beside the current value and in the trend's label. */
    format: (value: number) => string;
    /** Optional glyph for the tile's label, matching the old headline tiles. */
    icon?: LucideIcon;
}

/**
 * Format a count with a thin-space group separator.
 *
 * `toLocaleString` would follow the visitor's locale, which makes the same
 * dashboard render differently per machine and makes screenshots hard to
 * compare. Metrics should look identical for everyone.
 */
function formatCount(value: number): string {
    return Math.round(value)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
}

/** Format a byte count as B / kB / MB. */
function formatBytes(value: number): string {
    if (value < 1024) return `${formatCount(value)} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a duration in seconds as ms / s. */
function formatSeconds(value: number | null): string {
    if (value === null) return "—";
    if (value < 1) return `${(value * 1000).toFixed(0)} ms`;
    return `${value.toFixed(2)} s`;
}

/**
 * Format a 0..1 ratio as a percentage.
 *
 * NOTE: The precision here is a deliberate joke, on the maintainer's request.
 * An error rate is a ratio of two small integers, so every digit past the second
 * is floating-point noise presented with total confidence. Do not "tidy" this to
 * `toFixed(1)` -- the extra digits are the point.
 *
 * `toFixed` rather than `toPrecision` on purpose: `toPrecision` flips to
 * `1e-9`-style exponential notation for tiny rates, which would render as a
 * broken metric rather than a precise-looking one. The tradeoff is that this can
 * be long enough to wrap, so the tile carries `break-all`.
 */
function formatPercent(value: number | null): string {
    if (value === null) return "—";
    return `${(value * 100).toFixed(12)}%`;
}

/**
 * Push a value onto a bounded history array.
 *
 * Returns the SAME array reference when the value is unchanged, so a poll that
 * brings no new data does not re-render the chart. On a quiet server every poll
 * would otherwise produce identical geometry and a wasted paint.
 */
function pushBounded(previous: number[], value: number): number[] {
    if (previous.length > 0 && previous[previous.length - 1] === value) return previous;
    const next = [...previous, value];
    return next.length > HISTORY_LENGTH ? next.slice(next.length - HISTORY_LENGTH) : next;
}

/**
 * A minimal inline SVG sparkline.
 *
 * WHY NO CHART LIBRARY: this is one small line chart per tile. Adding recharts
 * (and its d3 dependencies) to render ~10 polylines would cost more bundle than
 * every other component on the page combined, and the site already code-splits
 * per route. A polyline over a viewBox is a dozen lines and has no dependencies.
 *
 * Accessibility: the SVG is `aria-hidden` and the numeric value is always
 * rendered as text beside it, so the trend is decorative and the number is the
 * accessible content. A sparkline with no axis labels conveys nothing to a
 * screen reader anyway.
 */
function Sparkline({ values, stroke }: { values: number[]; stroke: string }) {
    // A single point has no line to draw; two identical points would be a zero
    // height line, which reads as "no data" when it means "flat".
    if (values.length < 2) {
        return <div className="h-8" aria-hidden="true" />;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat series has a zero range; dividing by it would produce NaN coords
    // and an invisible path. Pin it to the middle instead so "flat" looks flat.
    const span = max - min || 1;

    const width = 100;
    const height = 32;
    const points = values
        .map((value, index) => {
            const x = (index / (values.length - 1)) * width;
            // SVG y grows downward, so a larger value needs a smaller y.
            const y = height - ((value - min) / span) * (height - 2) - 1;
            return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");

    return (
        <svg
            className="h-8 w-full"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
        >
            <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
    );
}

/**
 * One trend tile: label, current value, and a sparkline of recent values.
 *
 * WARNING: Every metric appears in exactly ONE tile on this page. `Requests` and
 * `DB queries` used to render twice -- once in a headline row and again here --
 * because the two rows were written for different metrics and then both given
 * the same four. If you add a tile, check it is not already in `statTiles` or
 * the grid below.
 */
function MetricTile({ series, stroke }: { series: Series; stroke: string }) {
    // `values` is typed as number[] but a sparse history means the last element
    // is still `number | undefined` under noUncheckedIndexedAccess. Falling back
    // to null keeps the "—" rendering rather than passing undefined to format().
    const last = series.values[series.values.length - 1];
    const current = last ?? null;
    const Icon = series.icon;

    return (
        <div className="rounded-xl border border-cardborder bg-background/40 p-4">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide opacity-60">
                {Icon && <Icon size={12} aria-hidden="true" />}
                {series.label}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
                {current === null ? "—" : series.format(current)}
            </div>
            <Sparkline values={series.values} stroke={stroke} />
        </div>
    );
}

/**
 * A value-only tile for a metric with no time series.
 *
 * `Error rate` is derived from two counters rather than published as its own
 * gauge, and the payload carries the latency histogram as a single running mean,
 * so neither can be plotted from one sample per poll. They get the current value
 * without a trend rather than a flat line invented from a single point.
 */
function StatTile({ label, value, icon }: { label: string; value: ReactNode; icon?: LucideIcon }) {
    const Icon = icon;
    return (
        <div className="rounded-xl border border-cardborder bg-background/40 p-4">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide opacity-60">
                {Icon && <Icon size={12} aria-hidden="true" />}
                {label}
            </div>
            {/* `break-all`: the error rate is rendered with a comical number of
                decimal places and must wrap rather than widen the grid column. */}
            <div className="mt-1 text-xl font-semibold tabular-nums break-all">{value}</div>
        </div>
    );
}

/**
 * Live Prometheus metrics for the telemetry server.
 *
 * Fetches the Worker's reduced `/telemetry/metrics` payload (see
 * `worker/src/metrics.ts`) on an interval and accumulates a short history in
 * component state for the sparklines. Rendered by `src/pages/Metrics.tsx`.
 *
 * DEGRADES QUIETLY. This panel is the whole of the `/metrics` page, which is a
 * dashboard someone may leave open rather than a page they act on; a metrics
 * outage is not a reason to shout. A failed fetch keeps the last good numbers on
 * screen and shows a subdued "stale" note, while `ok: false` from the Worker
 * (upstream unreachable) renders as "no data" rather than a row of zeroes, which
 * would read as a real measurement.
 */
export default function MetricsPanel() {
    const [payload, setPayload] = useState<MetricsPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [history, setHistory] = useState<Record<string, number[]>>({});

    // Abort in-flight requests on unmount so a pending poll cannot setState on
    // an unmounted component.
    const abortRef = useRef<AbortController | null>(null);

    const poll = useCallback(async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const next = await fetchMetrics(controller.signal);

            // A stale response from an aborted attempt must not overwrite newer
            // data; the abort above usually prevents it, but the guard is cheap.
            if (controller.signal.aborted) return;

            setPayload(next);
            setError(null);

            if (next.ok) {
                // Accumulate history only from real data. Pushing a zero for an
                // outage would put a false dip in the trend line.
                setHistory((previous) => ({
                    requests: pushBounded(previous.requests ?? [], totalRequests(next)),
                    dbQueries: pushBounded(previous.dbQueries ?? [], totalDbQueries(next)),
                    instances: pushBounded(previous.instances ?? [], next.gauges.instances_total ?? 0),
                    imageBytes: pushBounded(previous.imageBytes ?? [], next.gauges.image_storage_bytes ?? 0),
                }));
            }
        } catch (caught) {
            if (controller.signal.aborted) return;
            // Keep the last good payload on screen; only surface the problem.
            setError(caught instanceof Error ? caught.message : "Could not load metrics.");
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void poll();
        const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
        return () => {
            clearInterval(timer);
            abortRef.current?.abort();
        };
    }, [poll]);

    /**
     * The plotted metrics -- each one appears here and NOWHERE else on the page.
     *
     * `Requests` / `DB queries` are totals carried in the payload, so they are
     * plotted from the accumulated history rather than repeated as headline
     * numbers. That is why the stat row below holds only the two metrics with no
     * series.
     */
    const trendSeries: Series[] = [
        { label: "Instances", values: history.instances ?? [], format: formatCount },
        { label: "Image storage", values: history.imageBytes ?? [], format: formatBytes },
        { label: "HTTP requests", values: history.requests ?? [], format: formatCount, icon: Gauge },
        { label: "DB queries", values: history.dbQueries ?? [], format: formatCount, icon: Database },
    ];

    const rate = payload?.ok ? errorRate(payload) : null;
    const latency = payload?.ok ? payload.latency.meanSeconds : null;

    return (
        <Card>
            <div className="flex items-center justify-between gap-4">
                <h2 className="flex items-center gap-2 text-xl font-semibold">
                    <Activity size={20} aria-hidden="true" />
                    Server metrics
                </h2>
                <button
                    type="button"
                    onClick={() => void poll()}
                    className="flex items-center gap-1.5 rounded-lg border border-cardborder px-3 py-1.5 text-sm hover:bg-background/60"
                >
                    <RefreshCw size={14} aria-hidden="true" />
                    Refresh
                </button>
            </div>

            {loading && payload === null && (
                <div className="flex items-center gap-2 py-8 text-hovercolor" role="status" aria-live="polite">
                    <Loader2 className="animate-spin" size={18} aria-hidden="true" />
                    <span>Loading metrics...</span>
                </div>
            )}

            {error && (
                <p className="mt-3 flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                    <AlertCircle size={14} aria-hidden="true" />
                    {error} Showing the last values received.
                </p>
            )}

            {payload && !payload.ok && (
                <p className="mt-3 flex items-center gap-2 text-sm opacity-70">
                    <AlertCircle size={14} aria-hidden="true" />
                    The telemetry server is not reporting metrics right now.
                </p>
            )}

            {payload?.ok && (
                <>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                        <StatTile label="Error rate" value={formatPercent(rate)} />
                        <StatTile label="Mean latency" value={formatSeconds(latency)} />
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {trendSeries.map((series) => (
                            <MetricTile key={series.label} series={series} stroke={SPARKLINE_STROKE} />
                        ))}
                    </div>

                    <p className="mt-3 text-xs opacity-50">
                        Updated {new Date(payload.generatedAt).toLocaleTimeString()} · refreshes every{" "}
                        {POLL_INTERVAL_MS / 1000}s
                    </p>
                </>
            )}
        </Card>
    );
}
