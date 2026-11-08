/**
 * Tests for `MetricsPanel` (the whole body of the `/metrics` page).
 *
 * The page test (`src/test/pages/Metrics.test.tsx`) only covers the outline, so
 * the panel's own rendering rules are pinned here. Two of them exist because the
 * panel shipped with bugs:
 *
 *  1. `Requests` and `DB queries` each rendered TWICE -- once as a headline
 *     number and once as a sparkline tile -- because the two rows had been
 *     written for different metrics and then both given the same four.
 *  2. The error rate is deliberately rendered with a comical number of decimal
 *     places. That is a joke the maintainer asked for, so a "cleanup" to one
 *     decimal place is a regression, not a tidy-up.
 */

import { render, screen, within } from "@testing-library/react";
import MetricsPanel from "../../components/MetricsPanel";
import type { MetricsPayload } from "../../lib/metricsClient";

/** A healthy payload with overridable fields. */
function payload(overrides: Partial<MetricsPayload> = {}): MetricsPayload {
    return {
        generatedAt: "2026-11-08T12:00:00.000Z",
        gauges: { instances_total: 2, image_storage_bytes: 4096 },
        httpRequests: [
            { labels: { method: "GET", status: "200" }, value: 900 },
            { labels: { method: "GET", status: "404" }, value: 90 },
            { labels: { method: "POST", status: "500" }, value: 10 },
        ],
        dbQueries: [
            { labels: { operation: "SELECT" }, value: 400 },
            { labels: { operation: "UPDATE" }, value: 100 },
        ],
        latency: { meanSeconds: 0.012, count: 1000 },
        ok: true,
        ...overrides,
    };
}

function mockMetrics(body: MetricsPayload) {
    global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
    }) as unknown as typeof fetch;
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe("MetricsPanel", () => {
    describe("no duplicated metrics", () => {
        it("renders each metric label exactly once", async () => {
            // The regression: "Requests" and "DB queries" appeared in both the
            // headline row and the sparkline grid, so the same number was on
            // screen twice with different formatting.
            mockMetrics(payload());
            render(<MetricsPanel />);

            await screen.findByText("Error rate");

            for (const label of [
                "Instances",
                "Image storage",
                "HTTP requests",
                "DB queries",
                "Error rate",
                "Mean latency",
            ]) {
                expect(screen.getAllByText(label)).toHaveLength(1);
            }
        });

        it("drops the old 'Requests' headline tile in favour of 'HTTP requests'", async () => {
            // The two labels named the same number. The sparkline tile is the
            // survivor because it carries the trend as well as the value.
            mockMetrics(payload());
            render(<MetricsPanel />);

            await screen.findByText("HTTP requests");
            expect(screen.queryByText("Requests")).not.toBeInTheDocument();
        });
    });

    describe("error rate precision", () => {
        it("renders a comical number of decimal places", async () => {
            // 100 failures out of 1000 requests = exactly 10%. Written out to
            // twelve decimal places, which is the joke.
            mockMetrics(payload());
            render(<MetricsPanel />);

            expect(await screen.findByText("10.000000000000%")).toBeInTheDocument();
        });

        it("still produces a percentage, not a fraction", async () => {
            // Guards the `* 100`. A one-decimal cleanup would also pass a
            // "contains a %" check, so this asserts the exact magnitude too.
            mockMetrics(
                payload({
                    httpRequests: [{ labels: { method: "GET", status: "200" }, value: 8 }],
                    dbQueries: [],
                }),
            );
            render(<MetricsPanel />);

            // Zero failures out of 8 requests.
            expect(await screen.findByText("0.000000000000%")).toBeInTheDocument();
        });

        it("shows an em dash rather than a percentage when there is no traffic", async () => {
            // errorRate() returns null for an empty request set, which must not
            // render as "0.000000000000%" -- that would read as a perfect score.
            mockMetrics(payload({ httpRequests: [] }));
            render(<MetricsPanel />);

            const tile = (await screen.findByText("Error rate")).closest("div")?.parentElement;
            expect(tile).not.toBeNull();
            if (tile) expect(within(tile).getByText("—")).toBeInTheDocument();
        });
    });
});
