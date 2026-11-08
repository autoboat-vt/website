/**
 * Tests for the Server Metrics page (`/metrics`).
 *
 * The page is a thin shell around `MetricsPanel`, so these only pin what the
 * page itself decides: that the panel is mounted and that there is exactly one
 * h1 for the document outline. The panel's own data handling is covered by
 * `src/test/lib/metricsClient.test.ts` and the Worker's parser tests.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Metrics from "../../pages/Metrics";

/**
 * A Worker response for "telemetry server unreachable".
 *
 * The panel polls on mount, so every test needs `fetch` stubbed or the request
 * rejects with an unhandled promise. `ok: false` is the quiet state the panel
 * is built to render, so it keeps the assertions free of loading spinners.
 */
function mockUpstreamDown() {
    global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
            generatedAt: new Date(0).toISOString(),
            gauges: {},
            httpRequests: [],
            dbQueries: [],
            latency: { meanSeconds: null, count: 0 },
            ok: false,
        }),
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    mockUpstreamDown();
});

afterEach(() => {
    jest.restoreAllMocks();
});

function renderMetrics() {
    return render(
        <MemoryRouter>
            <Metrics />
        </MemoryRouter>,
    );
}

describe("Metrics page", () => {
    it("renders the server metrics panel", async () => {
        renderMetrics();

        // The panel's own heading, which is an h2 -- the page's h1 is
        // outline-only (see the note in Metrics.tsx), so filtering by level
        // keeps the two apart.
        expect(await screen.findByRole("heading", { level: 2, name: /Server metrics/i })).toBeInTheDocument();
    });

    it("provides exactly one h1 for the document outline", async () => {
        renderMetrics();

        // Awaited so the panel's first poll settles inside act().
        await screen.findByRole("heading", { level: 2, name: /Server metrics/i });
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    });

    it("describes an upstream outage instead of showing zeroes", async () => {
        // Rendering a row of zeros would read as a real measurement of nothing.
        renderMetrics();

        expect(await screen.findByText(/not reporting metrics right now/i)).toBeInTheDocument();
    });
});
