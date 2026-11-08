import MetricsPanel from "../components/MetricsPanel";

/**
 * Server metrics (`/metrics`).
 *
 * Live Prometheus metrics from the telemetry server, reduced to a small JSON
 * payload by the Worker's `GET /telemetry/metrics` route (see
 * `worker/src/metrics.ts` and `src/lib/metricsClient.ts`).
 *
 * WHY THIS IS ITS OWN PAGE. The panel used to render below the map on `/live`,
 * where it competed with the boat positions for space and added a second
 * poller to a page someone opened to look at a boat. A separate route keeps
 * the live map about the boats and gives the dashboard a URL that can be
 * linked and shared on its own.
 *
 * The panel is the whole page, so it owns the visible heading -- this page adds
 * only an outline-only h1 to keep the document with exactly one top-level
 * heading (the pattern `Officers.tsx` uses).
 */
export default function Metrics() {
    return (
        <section className="section mx-auto grid max-w-275 gap-6 px-4 py-10">
            {/* sr-only: `MetricsPanel` renders its own visible "Server metrics"
                heading. Rendering this one on screen too would read the same
                words twice. */}
            <h1 className="sr-only">Server Metrics</h1>
            <MetricsPanel />
        </section>
    );
}
