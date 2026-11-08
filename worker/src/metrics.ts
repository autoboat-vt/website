/**
 * Prometheus text-exposition parsing for the site's metrics panel.
 *
 * The telemetry server exposes `/metrics` in the Prometheus text format (see
 * `src/autoboat_telemetry_server/observability.py` in the telemetry_server repo).
 * That payload is ~72 kB across ~38 metric families and grows with every metric
 * added, while the page graphs a handful of numbers. So the Worker fetches it
 * once, reduces it to just the series the UI reads, and caches that small JSON
 * at the edge -- the browser never sees the raw exposition text.
 *
 * Deliberately pure -- no bindings, no `fetch` -- so the parser is unit-testable
 * without Cloudflare's ambient types. `index.ts` owns the fetch.
 *
 * FORMAT REMINDERS, because each one silently produces wrong numbers:
 *  - Comment lines start with `#` (`# HELP`, `# TYPE`) and carry no sample.
 *  - A sample line is `name{label="value",...} 1.23`, where the label block is
 *    OPTIONAL and may contain escaped quotes in the value.
 *  - Histograms and summaries are exported under derived names, so a query for
 *    `db_query_duration_seconds` must read `db_query_duration_seconds_bucket`,
 *    `_sum`, and `_count`; the base name never appears as a sample.
 *  - Counters also emit a `_created` gauge holding a UNIX timestamp, which is
 *    meaningless to graph and is excluded by pattern.
 *  - Values can be `+Inf`/`-Inf`/`NaN` in some families; those are dropped
 *    rather than sent as `null`, which would need special-casing in the UI.
 */

/** A single parsed sample from the exposition text. */
export interface MetricSample {
    name: string;
    labels: Record<string, string>;
    value: number;
}

/**
 * Metric families the dashboard reads.
 *
 * WARNING: Keep this list aligned with what the UI actually graphs. Every entry
 * costs bytes in the cached payload, and the whole point of this module is that
 * the browser does not download the full exposition text.
 *
 * Histogram families are listed by BASE name; `matchesWanted` expands them to
 * their `_bucket`/`_sum`/`_count` exports (see `histogramExportNames`).
 */
export const WANTED_FAMILIES: readonly string[] = [
    // Gauges describing server state. Cheap, always present.
    "instances_total",
    "config_hashes_total",
    "images_stored_total",
    "image_storage_bytes",
    // Traffic. `http_requests_total` is the family that makes the panel useful.
    "http_requests_total",
    "http_429_total",
    "clean_instances_deleted_total",
    // Latency. Base name; expanded below.
    "http_request_duration_seconds",
    "db_query_duration_seconds",
    // Throughput by statement verb.
    "db_queries_total",
    // Build info; a constant 1 with a version label.
    "telemetry_server_info",
];

/** Histogram/summary exports derived from a base family name. */
const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"] as const;

/**
 * Family names whose base name is a histogram, so the derived exports are kept.
 *
 * Listing these explicitly is what lets `WANTED_FAMILIES` name the base family
 * (the thing a human reads in the docs) while the parser keeps the suffixed
 * names that actually appear in the exposition text.
 */
const HISTOGRAM_FAMILIES: ReadonlySet<string> = new Set(["http_request_duration_seconds", "db_query_duration_seconds"]);

/**
 * Expand the wanted list to the concrete sample names to keep.
 *
 * Counter families additionally emit `<name>_created` (a timestamp gauge) and
 * `_total` is already the canonical counter name in this exposition version, so
 * nothing extra is added for counters.
 */
function wantedSampleNames(): Set<string> {
    const names = new Set<string>();
    for (const family of WANTED_FAMILIES) {
        names.add(family);
        if (HISTOGRAM_FAMILIES.has(family)) {
            for (const suffix of HISTOGRAM_SUFFIXES) names.add(`${family}${suffix}`);
        }
    }
    return names;
}

/** `name{labels} value` -- label block optional, value is a bare token. */
const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+(\S+)$/;

/** One `key="value"` pair inside a label block. */
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** Unescape the sequences Prometheus allows inside a quoted label value. */
function unescapeLabelValue(raw: string): string {
    // The exposition format only defines \\, \", \n for label values. Anything
    // else is left as-is rather than throwing, so an unexpected escape cannot
    // drop an entire sample.
    return raw.replace(/\\([\\"n])/g, (_match, ch: string) => (ch === "n" ? "\n" : ch));
}

/**
 * Parse one exposition line into a sample, or `null` for comments/blank lines.
 *
 * Samples whose name is not wanted are filtered by the caller so this function
 * stays a pure format parser (and stays individually testable).
 */
export function parseSampleLine(line: string): MetricSample | null {
    const trimmed = line.trim();
    // Blank and `# HELP` / `# TYPE` lines carry no sample.
    if (!trimmed || trimmed.startsWith("#")) return null;

    const match = SAMPLE_LINE.exec(trimmed);
    if (!match) return null;

    // Destructured from a regex match, so each group is `string | undefined` to
    // the compiler even though group 1 and 3 are required by the pattern.
    const name = match[1];
    const rawLabels = match[2];
    const rawValue = match[3];
    if (!name || !rawValue) return null;

    const labels: Record<string, string> = {};
    if (rawLabels) {
        // `matchAll` needs a fresh lastIndex per call, which a literal with /g
        // gets automatically here because we recreate it via exec loop.
        LABEL_PAIR.lastIndex = 0;
        for (let pair = LABEL_PAIR.exec(rawLabels); pair !== null; pair = LABEL_PAIR.exec(rawLabels)) {
            const key = pair[1];
            const value = pair[2];
            // Group 2 can be an empty string (a valid, empty label value), so
            // only a truly absent group is skipped.
            if (key === undefined || value === undefined) continue;
            labels[key] = unescapeLabelValue(value);
        }
    }

    const value = Number(rawValue);
    // Drop +Inf/-Inf/NaN and anything unparseable. `Number()` accepts "Infinity"
    // but not "+Inf", so an explicit finite check is what actually filters both.
    if (!Number.isFinite(value)) return null;

    return { name, labels, value };
}

/**
 * Reduce a full exposition payload to the wanted samples.
 *
 * Returns an array rather than an object because the same metric name appears
 * many times with different label sets, which a flat object cannot represent.
 */
export function pickMetrics(body: string): MetricSample[] {
    const wanted = wantedSampleNames();
    const out: MetricSample[] = [];

    for (const line of body.split("\n")) {
        const sample = parseSampleLine(line);
        if (!sample) continue;
        // Counters expose a `<name>_created` timestamp gauge that is noise here.
        if (sample.name.endsWith("_created")) continue;
        // The `le="+Inf"` bucket always equals `_count` exactly, so keeping it
        // would double-count in any average derived by summing buckets.
        if (sample.labels.le === "+Inf") continue;
        if (!wanted.has(sample.name)) continue;
        out.push(sample);
    }

    return out;
}

/**
 * Collapse samples into a name -> value map for the gauges the panel shows.
 *
 * Only UNLABELED samples are included. A labelled family is collapsed by the
 * caller with the aggregation it needs (e.g. summing `http_requests_total`
 * across `path`), because those aggregations differ per panel and doing them
 * here would bake one panel's opinion into the payload.
 *
 * When a name appears more than once unlabelled -- which should not happen, but
 * would mean the exposition text is malformed -- the FIRST sample wins so the
 * number is stable across polls rather than jittering between values.
 */
export function collapseUnlabelled(samples: MetricSample[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const sample of samples) {
        if (Object.keys(sample.labels).length > 0) continue;
        if (sample.name in out) continue;
        out[sample.name] = sample.value;
    }
    return out;
}

/** Labels dropped from the aggregated counters, to keep the payload small. */
const DROPPED_LABELS = new Set(["instance", "job", "path"]);

/**
 * Sum samples of one family, bucketed by the labels the UI groups on.
 *
 * `path`/`instance`/`job` are dropped deliberately: they are high-cardinality
 * and the panel does not break anything down by them, so keeping them would put
 * one entry per route in the payload. `status` and `method` are kept because the
 * error-rate panel groups on them.
 *
 * Returns `[]` when the family is absent (a fresh process has no labelled
 * samples yet -- `prometheus_client` emits the `# TYPE` header immediately but
 * no data lines until the first request).
 */
export function sumByRemainingLabels(
    samples: MetricSample[],
    family: string,
): Array<{
    labels: Record<string, string>;
    value: number;
}> {
    const grouped = new Map<string, { labels: Record<string, string>; value: number }>();

    for (const sample of samples) {
        if (sample.name !== family) continue;

        const labels: Record<string, string> = {};
        for (const [key, value] of Object.entries(sample.labels)) {
            if (DROPPED_LABELS.has(key)) continue;
            labels[key] = value;
        }

        // A stable key for the label combination, order-independent.
        const key = Object.keys(labels)
            .sort()
            .map((k) => `${k}=${labels[k]}`)
            .join("\u0000");

        const existing = grouped.get(key);
        if (existing) {
            existing.value += sample.value;
        } else {
            grouped.set(key, { labels, value: sample.value });
        }
    }

    // Sort by label key then value so the JSON is byte-stable across polls,
    // which lets the edge cache and any client-side diffing work predictably.
    return [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
}

/**
 * Build the reduced payload the website consumes.
 *
 * Shape is intentionally flat and boring: a `gauges` map for single-valued
 * numbers and three small arrays for the families the panels group on.
 */
export interface MetricsPayload {
    /** Wall-clock time the Worker built this payload (ISO 8601, UTC). */
    generatedAt: string;
    /** Unlabelled gauges, e.g. `{ instances_total: 3 }`. */
    gauges: Record<string, number>;
    /** Requests by the labels the UI keeps (`method`, `status`). */
    httpRequests: Array<{ labels: Record<string, string>; value: number }>;
    /** DB statements by verb. */
    dbQueries: Array<{ labels: Record<string, string>; value: number }>;
    /** Request-latency histogram, reduced to its running mean and count. */
    latency: { meanSeconds: number | null; count: number };
    /** Whether the upstream looked healthy. False means the payload is stale. */
    ok: boolean;
}

/**
 * Reduce a full exposition payload to the website's `MetricsPayload`.
 *
 * `now` is injected rather than read from the clock so the output is
 * deterministic in tests.
 */
export function buildMetricsPayload(body: string, now: Date): MetricsPayload {
    const samples = pickMetrics(body);

    const latencySum = samples.find((s) => s.name === "http_request_duration_seconds_sum");
    const latencyCount = samples.find((s) => s.name === "http_request_duration_seconds_count");

    const count = latencyCount?.value ?? 0;
    // Guard the division: a fresh process has a count of 0, and 0/0 would be
    // NaN, which JSON.stringify turns into `null` anyway but only by accident.
    const meanSeconds = count > 0 && latencySum ? latencySum.value / count : null;

    return {
        generatedAt: now.toISOString(),
        gauges: collapseUnlabelled(samples),
        httpRequests: sumByRemainingLabels(samples, "http_requests_total"),
        dbQueries: sumByRemainingLabels(samples, "db_queries_total"),
        latency: { meanSeconds, count },
        ok: true,
    };
}

/**
 * The payload returned when the upstream is unreachable.
 *
 * Every field that carries a number is empty rather than zero: a dashboard
 * showing "0 requests" would read as a real measurement, while an empty panel
 * reads as "no data", which is the truth.
 */
export function unavailablePayload(now: Date): MetricsPayload {
    return {
        generatedAt: now.toISOString(),
        gauges: {},
        httpRequests: [],
        dbQueries: [],
        latency: { meanSeconds: null, count: 0 },
        ok: false,
    };
}
