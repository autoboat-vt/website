/**
 * Typed client for the telemetry metrics Cloudflare Worker route.
 *
 * The Worker (see `worker/src/metrics.ts`) fetches the telemetry server's
 * `/metrics` endpoint and reduces the Prometheus exposition text to a small
 * JSON document. That reduction is the whole point: the raw payload is ~70 kB
 * of text covering ~38 families, while the panel graphs a handful of numbers.
 * Fetching the raw endpoint from the browser would ship all of it on every
 * poll and put the parsing cost on the visitor's device.
 *
 * Wire format notes:
 *  - `ok: false` means the upstream was unreachable. The numeric fields are
 *    then EMPTY rather than zero, so the UI must render "no data" instead of a
 *    real-looking measurement of zero.
 *  - `gauges` is a plain name -> value map of unlabelled series.
 *  - `httpRequests` / `dbQueries` are pre-aggregated by the Worker: `path` is
 *    already dropped, so the client never has to know about cardinality.
 *  - `latency.meanSeconds` is null until the histogram has at least one sample.
 */

declare global {
    // eslint-disable-next-line no-var
    var __VITE_METRICS_URL__: string | undefined;
}

/**
 * Base URL of the Worker. Override per-environment with `VITE_METRICS_URL`
 * (e.g. pointing at `wrangler dev` on localhost:8787).
 *
 * Read from `globalThis` rather than `import.meta.env` so the source parses
 * under Jest's CJS runtime, where `import.meta` is a syntax error -- the same
 * reason `discord.ts` and `telemetry.ts` do it this way.
 */
export const METRICS_URL: string =
    globalThis.__VITE_METRICS_URL__ || "https://autoboat-cloudflare-helper.autoboat-at-virginia-tech.workers.dev";

/** One pre-aggregated row: a label combination and its summed value. */
export interface MetricRow {
    labels: Record<string, string>;
    value: number;
}

/** The reduced payload served by `GET /telemetry/metrics`. */
export interface MetricsPayload {
    /** ISO-8601 UTC time the Worker built the payload. */
    generatedAt: string;
    /** Unlabelled gauges, e.g. `{ instances_total: 3 }`. */
    gauges: Record<string, number>;
    /** HTTP request counts, aggregated across paths. */
    httpRequests: MetricRow[];
    /** DB statement counts by verb. */
    dbQueries: MetricRow[];
    /** Request-latency histogram reduced to a running mean. */
    latency: { meanSeconds: number | null; count: number };
    /** False when the telemetry server was unreachable. */
    ok: boolean;
}

/** Thrown for network failures and non-2xx responses. */
export class MetricsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MetricsError";
    }
}

/**
 * Fetch the reduced metrics payload.
 *
 * Throws on network/HTTP failure so the caller can decide how to present it;
 * the panel shows a quiet "unavailable" state rather than an alarm, because
 * this is a dashboard, not a page someone is trying to get work done on.
 *
 * A 200 with `ok: false` is NOT an error -- that is the Worker reporting an
 * upstream outage, which is rendered as "no data".
 */
export async function fetchMetrics(signal?: AbortSignal): Promise<MetricsPayload> {
    const response = await fetch(`${METRICS_URL}/telemetry/metrics`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
    });

    if (!response.ok) {
        throw new MetricsError(`Metrics request failed with status ${response.status}.`);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new MetricsError("Metrics response was not valid JSON.");
    }

    if (!isMetricsPayload(body)) {
        throw new MetricsError("Metrics response did not match the expected shape.");
    }

    return body;
}

/**
 * Runtime shape check.
 *
 * WARNING: Not defensive paranoia -- a Worker deploy that changes the route or a
 * proxy returning an HTML error page both produce a 200 with the wrong body,
 * and a blind cast would surface that as `undefined` deep inside the panel's
 * arithmetic rather than a clear error here.
 */
export function isMetricsPayload(value: unknown): value is MetricsPayload {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<MetricsPayload>;

    return (
        typeof candidate.generatedAt === "string" &&
        typeof candidate.ok === "boolean" &&
        typeof candidate.gauges === "object" &&
        candidate.gauges !== null &&
        Array.isArray(candidate.httpRequests) &&
        Array.isArray(candidate.dbQueries) &&
        typeof candidate.latency === "object" &&
        candidate.latency !== null &&
        typeof candidate.latency.count === "number"
    );
}

/**
 * Total HTTP requests across every label combination.
 *
 * Summing client-side rather than asking the Worker for a total keeps the
 * payload reusable: the same `httpRequests` array also feeds the error-rate and
 * per-status breakdowns.
 */
export function totalRequests(payload: MetricsPayload): number {
    return payload.httpRequests.reduce((sum, row) => sum + row.value, 0);
}

/**
 * Share of requests that returned 4xx/5xx, in the range 0..1.
 *
 * Returns `null` when there are no requests yet, so the caller renders "—"
 * rather than a misleading 0%.
 */
export function errorRate(payload: MetricsPayload): number | null {
    const total = totalRequests(payload);
    if (total === 0) return null;

    const failed = payload.httpRequests
        .filter((row) => {
            const status = Number(row.labels.status);
            return Number.isFinite(status) && status >= 400;
        })
        .reduce((sum, row) => sum + row.value, 0);

    return failed / total;
}

/** Total DB statements across every verb. */
export function totalDbQueries(payload: MetricsPayload): number {
    return payload.dbQueries.reduce((sum, row) => sum + row.value, 0);
}
