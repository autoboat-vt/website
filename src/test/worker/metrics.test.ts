/**
 * @jest-environment node
 *
 * Unit tests for the Prometheus exposition parser (worker/src/metrics.ts).
 *
 * The module is pure -- no bindings, no `fetch` -- so it is imported by relative
 * path the same way the other Worker suites import theirs.
 *
 * The fixture below is TRIMMED from a real `/metrics` capture rather than
 * hand-written, because the format's sharp edges are exactly the parts a
 * hand-written sample would omit: derived histogram names, `_created`
 * timestamp gauges, and multi-label samples with escaped values. The values are
 * the ones the live server actually produced.
 */

import {
    buildMetricsPayload,
    collapseUnlabelled,
    parseSampleLine,
    pickMetrics,
    sumByRemainingLabels,
    unavailablePayload,
    WANTED_FAMILIES,
} from "../../../worker/src/metrics";

/** Trimmed real capture: gauges, counters, a histogram, and noise to drop. */
const REAL_EXPOSITION = `# HELP python_gc_objects_collected_total Objects collected during gc
# TYPE python_gc_objects_collected_total counter
python_gc_objects_collected_total{generation="0"} 15132.0
# HELP instances_total Number of telemetry instances currently stored.
# TYPE instances_total gauge
instances_total 1.0
# HELP config_hashes_total Number of stored autopilot-parameter config hashes.
# TYPE config_hashes_total gauge
config_hashes_total 0.0
# HELP images_stored_total Number of distinct images stored.
# TYPE images_stored_total gauge
images_stored_total 3.0
# HELP image_storage_bytes Total bytes of stored image payloads.
# TYPE image_storage_bytes gauge
image_storage_bytes 262144.0
# HELP telemetry_server_info Static build/version information.
# TYPE telemetry_server_info gauge
telemetry_server_info{version="0.0.0"} 1.0
# HELP http_requests_total Total HTTP requests by method, path rule, and status code.
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/metrics",status="200"} 25.0
http_requests_total{method="GET",path="/",status="200"} 4.0
http_requests_total{method="POST",path="/boat_status/set/<int:instance_id>",status="200"} 120.0
http_requests_total{method="GET",path="/instance_manager/get_ids",status="404"} 2.0
http_requests_total_created{method="GET",path="/",status="200"} 1.6975e+09
# HELP http_request_duration_seconds HTTP request latency in seconds.
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.005",method="GET",path="/"} 10.0
http_request_duration_seconds_bucket{le="+Inf",method="GET",path="/"} 25.0
http_request_duration_seconds_sum{method="GET",path="/"} 0.5
http_request_duration_seconds_count{method="GET",path="/"} 25.0
http_request_duration_seconds_created{method="GET",path="/"} 1.6975e+09
# HELP db_queries_total Total SQL statements executed.
# TYPE db_queries_total counter
db_queries_total{operation="SELECT"} 40122.0
db_queries_total{operation="INSERT"} 1.0
db_queries_total{operation="UPDATE"} 12152.0
db_queries_total{operation="DELETE"} 5.0
# HELP db_query_duration_seconds SQL statement latency in seconds.
# TYPE db_query_duration_seconds histogram
db_query_duration_seconds_bucket{le="0.001",operation="SELECT"} 39000.0
db_query_duration_seconds_sum{operation="SELECT"} 12.5
db_query_duration_seconds_count{operation="SELECT"} 40122.0
# HELP http_429_total HTTP 429 responses from write-lock contention.
# TYPE http_429_total counter
http_429_total 0.0
# HELP clean_instances_deleted_total Telemetry instances deleted.
# TYPE clean_instances_deleted_total counter
clean_instances_deleted_total 7.0
# HELP process_resident_memory_bytes Resident memory size in bytes.
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 8.9124864e+07
`;

const NOW = new Date("2026-11-08T12:00:00.000Z");

describe("parseSampleLine", () => {
    it("parses a sample with no labels", () => {
        expect(parseSampleLine("instances_total 1.0")).toEqual({
            name: "instances_total",
            labels: {},
            value: 1,
        });
    });

    it("parses multiple labels", () => {
        expect(parseSampleLine('http_requests_total{method="GET",path="/",status="200"} 4.0')).toEqual({
            name: "http_requests_total",
            labels: { method: "GET", path: "/", status: "200" },
            value: 4,
        });
    });

    it("parses floats in exponent notation", () => {
        // Real payloads use these for byte counts and timestamps.
        expect(parseSampleLine("process_resident_memory_bytes 8.9124864e+07")?.value).toBe(89124864);
    });

    it("unescapes an escaped quote inside a label value", () => {
        const sample = parseSampleLine('some_metric{path="/a\\"b"} 1.0');
        expect(sample?.labels.path).toBe('/a"b');
    });

    it("preserves an empty label value", () => {
        // An empty value is legal and must not be dropped as if it were absent.
        expect(parseSampleLine('some_metric{path=""} 1.0')?.labels.path).toBe("");
    });

    it("returns null for comment lines", () => {
        expect(parseSampleLine("# HELP http_requests_total Total requests")).toBeNull();
        expect(parseSampleLine("# TYPE http_requests_total counter")).toBeNull();
    });

    it("returns null for blank lines", () => {
        expect(parseSampleLine("")).toBeNull();
        expect(parseSampleLine("   \t ")).toBeNull();
    });

    it("returns null for a non-finite value", () => {
        // Prometheus emits these for some families; they must not become NaN or
        // Infinity in the JSON payload.
        expect(parseSampleLine("some_metric +Inf")).toBeNull();
        expect(parseSampleLine("some_metric -Inf")).toBeNull();
        expect(parseSampleLine("some_metric NaN")).toBeNull();
    });
});

describe("pickMetrics", () => {
    it("keeps only wanted families", () => {
        const names = new Set(pickMetrics(REAL_EXPOSITION).map((s) => s.name));
        // Unwanted family from the fixture.
        expect(names.has("python_gc_objects_collected_total")).toBe(false);
        expect(names.has("process_resident_memory_bytes")).toBe(false);
        // Wanted families.
        expect(names.has("instances_total")).toBe(true);
        expect(names.has("http_requests_total")).toBe(true);
        expect(names.has("db_queries_total")).toBe(true);
    });

    it("keeps derived histogram exports for a listed base name", () => {
        const names = new Set(pickMetrics(REAL_EXPOSITION).map((s) => s.name));
        // The base name never appears as a sample; the exports do.
        expect(names.has("http_request_duration_seconds_bucket")).toBe(true);
        expect(names.has("http_request_duration_seconds_sum")).toBe(true);
        expect(names.has("http_request_duration_seconds_count")).toBe(true);
        expect(names.has("db_query_duration_seconds_sum")).toBe(true);
    });

    it("drops the _created timestamp gauges", () => {
        // These hold UNIX timestamps and would graph as a meaningless ramp.
        const names = pickMetrics(REAL_EXPOSITION).map((s) => s.name);
        expect(names.some((n) => n.endsWith("_created"))).toBe(false);
    });

    it("drops the +Inf bucket", () => {
        // A +Inf bucket value is always equal to _count, so keeping it would
        // double-count in any average computed by summing buckets.
        const inf = pickMetrics(REAL_EXPOSITION).filter(
            (s) => s.name === "http_request_duration_seconds_bucket" && s.labels.le === "+Inf",
        );
        expect(inf).toHaveLength(0);
    });

    it("returns an empty array for an empty body", () => {
        expect(pickMetrics("")).toEqual([]);
    });

    it("lists histogram families by base name, not by export suffix", () => {
        // Pins the contract other code relies on: the list is human-readable.
        expect(WANTED_FAMILIES).toContain("http_request_duration_seconds");
        expect(WANTED_FAMILIES).not.toContain("http_request_duration_seconds_bucket");
    });
});

describe("collapseUnlabelled", () => {
    it("maps unlabelled samples to a name -> value record", () => {
        const gauges = collapseUnlabelled(pickMetrics(REAL_EXPOSITION));
        expect(gauges.instances_total).toBe(1);
        expect(gauges.config_hashes_total).toBe(0);
        expect(gauges.images_stored_total).toBe(3);
        expect(gauges.image_storage_bytes).toBe(262144);
        expect(gauges.http_429_total).toBe(0);
        expect(gauges.clean_instances_deleted_total).toBe(7);
    });

    it("excludes labelled samples", () => {
        const gauges = collapseUnlabelled(pickMetrics(REAL_EXPOSITION));
        // telemetry_server_info is labelled, so it must not leak in as a bare name.
        expect(gauges.telemetry_server_info).toBeUndefined();
        expect(gauges.http_requests_total).toBeUndefined();
    });
});

describe("sumByRemainingLabels", () => {
    it("sums across the dropped high-cardinality labels", () => {
        const summed = sumByRemainingLabels(pickMetrics(REAL_EXPOSITION), "http_requests_total");
        // `path` is dropped, so the GET/200 rows for "/" and "/metrics" collapse
        // into one entry. Status and method survive, so the three distinct
        // combinations stay separate.
        expect(summed).toEqual([
            { labels: { method: "GET", status: "200" }, value: 29 },
            { labels: { method: "GET", status: "404" }, value: 2 },
            { labels: { method: "POST", status: "200" }, value: 120 },
        ]);
    });

    it("keeps status separate so an error rate is computable", () => {
        const summed = sumByRemainingLabels(pickMetrics(REAL_EXPOSITION), "http_requests_total");
        const statuses = summed.map((row) => row.labels.status);
        expect(statuses).toContain("200");
        expect(statuses).toContain("404");
    });

    it("sums db queries by verb", () => {
        const summed = sumByRemainingLabels(pickMetrics(REAL_EXPOSITION), "db_queries_total");
        expect(summed).toEqual([
            { labels: { operation: "DELETE" }, value: 5 },
            { labels: { operation: "INSERT" }, value: 1 },
            { labels: { operation: "SELECT" }, value: 40122 },
            { labels: { operation: "UPDATE" }, value: 12152 },
        ]);
    });

    it("returns an empty array for an absent family", () => {
        // A freshly restarted process has no labelled samples at all.
        expect(sumByRemainingLabels(pickMetrics(REAL_EXPOSITION), "no_such_metric")).toEqual([]);
    });

    it("produces byte-stable ordering", () => {
        // Stability is what lets the edge cache and client diffing behave.
        const first = JSON.stringify(sumByRemainingLabels(pickMetrics(REAL_EXPOSITION), "db_queries_total"));
        const second = JSON.stringify(sumByRemainingLabels(pickMetrics(REAL_EXPOSITION), "db_queries_total"));
        expect(first).toBe(second);
    });
});

describe("buildMetricsPayload", () => {
    it("computes the mean latency from the histogram sum and count", () => {
        const payload = buildMetricsPayload(REAL_EXPOSITION, NOW);
        // 0.5s over 25 requests.
        expect(payload.latency.count).toBe(25);
        expect(payload.latency.meanSeconds).toBeCloseTo(0.02, 10);
    });

    it("reports a null mean when the histogram is absent", () => {
        // Guards the 0/0 -> NaN case rather than letting JSON.stringify decide.
        const payload = buildMetricsPayload("# TYPE instances_total gauge\ninstances_total 0.0\n", NOW);
        expect(payload.latency.meanSeconds).toBeNull();
        expect(payload.latency.count).toBe(0);
    });

    it("sets ok true and stamps the injected clock", () => {
        const payload = buildMetricsPayload(REAL_EXPOSITION, NOW);
        expect(payload.ok).toBe(true);
        expect(payload.generatedAt).toBe("2026-11-08T12:00:00.000Z");
    });

    it("is drastically smaller than the input", () => {
        // The whole reason this route exists is the size reduction.
        const payload = buildMetricsPayload(REAL_EXPOSITION, NOW);
        expect(JSON.stringify(payload).length).toBeLessThan(REAL_EXPOSITION.length / 2);
    });
});

describe("unavailablePayload", () => {
    it("carries no numbers, so an empty panel reads as 'no data'", () => {
        // A zero would render as a real measurement of "0 requests".
        const payload = unavailablePayload(NOW);
        expect(payload.ok).toBe(false);
        expect(payload.gauges).toEqual({});
        expect(payload.httpRequests).toEqual([]);
        expect(payload.dbQueries).toEqual([]);
        expect(payload.latency).toEqual({ meanSeconds: null, count: 0 });
    });
});
