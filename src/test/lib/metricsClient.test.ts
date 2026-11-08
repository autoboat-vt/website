/**
 * @jest-environment jsdom
 *
 * Unit tests for the reduced-metrics client (src/lib/metricsClient.ts).
 *
 * The module only transforms JSON and does arithmetic, so the tests mock
 * `fetch` rather than standing up a Worker. What they pin is the failure
 * taxonomy the panel depends on: a thrown error (network/HTTP/shape) versus a
 * 200 carrying `ok: false` (the upstream reported itself down). Those render
 * differently, so conflating them would show the wrong message.
 */

import {
    errorRate,
    fetchMetrics,
    isMetricsPayload,
    type MetricsPayload,
    totalDbQueries,
    totalRequests,
} from "../../lib/metricsClient";

/** A valid payload with overridable fields. */
function payload(overrides: Partial<MetricsPayload> = {}): MetricsPayload {
    return {
        generatedAt: "2026-11-08T12:00:00.000Z",
        gauges: { instances_total: 2, image_storage_bytes: 4096 },
        httpRequests: [
            { labels: { method: "GET", status: "200" }, value: 90 },
            { labels: { method: "GET", status: "404" }, value: 8 },
            { labels: { method: "POST", status: "500" }, value: 2 },
        ],
        dbQueries: [
            { labels: { operation: "SELECT" }, value: 400 },
            { labels: { operation: "UPDATE" }, value: 100 },
        ],
        latency: { meanSeconds: 0.012, count: 100 },
        ok: true,
        ...overrides,
    };
}

/** Install a `fetch` that resolves to one JSON response. */
function mockFetchJson(body: unknown, init: ResponseInit = { status: 200 }) {
    global.fetch = jest.fn().mockResolvedValue({
        ok: init.status === undefined || init.status < 400,
        status: init.status ?? 200,
        json: async () => body,
    }) as unknown as typeof fetch;
}

describe("fetchMetrics", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("returns the payload on a 200", async () => {
        mockFetchJson(payload());
        await expect(fetchMetrics()).resolves.toMatchObject({ ok: true });
    });

    it("requests the reduced route on the Worker", async () => {
        mockFetchJson(payload());
        await fetchMetrics();
        const [url] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toContain("/telemetry/metrics");
    });

    it("throws on a non-2xx status", async () => {
        mockFetchJson({ error: "nope" }, { status: 502 });
        await expect(fetchMetrics()).rejects.toThrow(/status 502/);
    });

    it("throws when the body is not JSON", async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new SyntaxError("Unexpected token <");
            },
        }) as unknown as typeof fetch;
        await expect(fetchMetrics()).rejects.toThrow(/not valid JSON/);
    });

    it("throws when the body is the wrong shape", async () => {
        // A 200 carrying an HTML error page or an older Worker response.
        mockFetchJson({ message: "hello" });
        await expect(fetchMetrics()).rejects.toThrow(/did not match/);
    });

    it("does NOT throw for a 200 with ok:false", async () => {
        // This is the Worker reporting an upstream outage, which is data, not a
        // transport failure -- it must reach the panel so it can say "no data".
        mockFetchJson(payload({ ok: false, gauges: {}, httpRequests: [], dbQueries: [] }));
        await expect(fetchMetrics()).resolves.toMatchObject({ ok: false });
    });

    it("propagates an abort", async () => {
        const controller = new AbortController();
        global.fetch = jest.fn().mockImplementation((_url, init: RequestInit) => {
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
            });
        }) as unknown as typeof fetch;

        const pending = fetchMetrics(controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow(/Abort/);
    });
});

describe("isMetricsPayload", () => {
    it("accepts a valid payload", () => {
        expect(isMetricsPayload(payload())).toBe(true);
    });

    it("rejects null, primitives, and arrays", () => {
        expect(isMetricsPayload(null)).toBe(false);
        expect(isMetricsPayload("nope")).toBe(false);
        expect(isMetricsPayload([])).toBe(false);
    });

    it("rejects a payload missing required fields", () => {
        const { gauges: _gauges, ...withoutGauges } = payload();
        expect(isMetricsPayload(withoutGauges)).toBe(false);
    });

    it("rejects a payload whose latency lacks a count", () => {
        expect(isMetricsPayload({ ...payload(), latency: { meanSeconds: 1 } })).toBe(false);
    });
});

describe("totalRequests", () => {
    it("sums every label row", () => {
        expect(totalRequests(payload())).toBe(100);
    });

    it("returns 0 for an empty payload", () => {
        expect(totalRequests(payload({ httpRequests: [] }))).toBe(0);
    });
});

describe("errorRate", () => {
    it("counts 4xx and 5xx as errors", () => {
        // 8 x 404 + 2 x 500 out of 100.
        expect(errorRate(payload())).toBeCloseTo(0.1, 10);
    });

    it("returns null when there are no requests", () => {
        // Null renders as "—"; a 0 would look like a real "0% errors".
        expect(errorRate(payload({ httpRequests: [] }))).toBeNull();
    });

    it("returns 0 when every request succeeded", () => {
        expect(errorRate(payload({ httpRequests: [{ labels: { method: "GET", status: "200" }, value: 50 }] }))).toBe(0);
    });

    it("ignores rows whose status is not a number", () => {
        const withJunk = payload({
            httpRequests: [
                { labels: { method: "GET", status: "200" }, value: 10 },
                { labels: { method: "GET", status: "unknown" }, value: 90 },
            ],
        });
        expect(errorRate(withJunk)).toBe(0);
    });
});

describe("totalDbQueries", () => {
    it("sums across verbs", () => {
        expect(totalDbQueries(payload())).toBe(500);
    });
});
