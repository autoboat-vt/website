import { afterEach, beforeEach } from "@jest/globals";
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Tests for the LiveMap page.
 *
 * Leaflet / react-leaflet need a real layout engine and don't run cleanly in
 * jsdom, so they're stubbed via jest.config.js moduleNameMapper (see
 * src/test/__mocks__/{react-leaflet,leaflet,BoatMarker}). We mock global
 * `fetch` to return canned telemetry-server responses, which exercises the
 * real `fetchFleetState` code path end-to-end.
 */

import LiveMap from "../../pages/LiveMap";

// --- Mock-response helpers (duck-typed; fetchJson only reads ok/status/json) ---

interface MockResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, init?: { status?: number }): MockResponse {
    const status = init?.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
    };
}

type FetchMock = jest.Mock;

/**
 * Drive fetch() to resolve with the matching canned response per call. Calls
 * past the end of `responses` get a 200 empty-array response so polling
 * doesn't blow up in tests that only care about the first cycle.
 */
function mockFetchSequence(responses: Array<{ body: unknown; status?: number }>): FetchMock {
    const canned = responses.map((r) => jsonResponse(r.body, { status: r.status }));
    const fn = jest.fn((): Promise<MockResponse> => {
        const i = fn.mock.calls.length - 1;
        const r = canned[i] ?? jsonResponse([]);
        return Promise.resolve(r);
    }) as unknown as FetchMock;
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

// --- Sample data --------------------------------------------------------

const instances = [
    {
        instance_id: 1,
        instance_identifier: "theseus",
        user: "alice",
        current_config_hash: "abc",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
    },
    {
        instance_id: 2,
        instance_identifier: "persephone",
        user: "bob",
        current_config_hash: "def",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
    },
];

const statusTheseus = {
    latitude: 37.23,
    longitude: -80.41,
    heading: 45,
    speed: 2.5,
    boat_control_mode: "AUTONOMOUS",
};
const statusPersephone = {
    latitude: 37.24,
    longitude: -80.42,
    heading: 180,
    speed: 0,
    boat_control_mode: "MANUAL",
};

// --- Setup / teardown ---------------------------------------------------

const realFetch = global.fetch;

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
    act(() => {
        jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
});

// --- Helpers ------------------------------------------------------------

function renderLiveMap() {
    return render(
        <MemoryRouter>
            <LiveMap />
        </MemoryRouter>,
    );
}

/** Flush the microtask queue a few times so poll()'s await chain settles. */
async function flushMicrotasks() {
    for (let i = 0; i < 6; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
}

// --- Tests --------------------------------------------------------------

describe("LiveMap page", () => {
    it("shows the loading state before the first poll resolves", () => {
        // Never-resolving promise keeps us in the initial loading state.
        global.fetch = jest.fn(() => new Promise<MockResponse>(() => {})) as unknown as typeof fetch;
        renderLiveMap();
        expect(screen.getByText(/Connecting/i)).toBeInTheDocument();
    });

    it("renders boat markers after a successful poll", async () => {
        // fetchFleetState does: GET instances, then per instance GET /boat_status/get/<id>
        // and GET /waypoints/get/<id> (fired in parallel via Promise.allSettled).
        // So the first 5 fetches are: instances, status 1, waypoints 1, status 2, waypoints 2.
        mockFetchSequence([
            { body: instances }, // GET /instance_manager/get_all_instance_info
            { body: statusTheseus }, // GET /boat_status/get/1
            { body: [] }, // GET /waypoints/get/1 (no waypoints)
            { body: statusPersephone }, // GET /boat_status/get/2
            { body: [] }, // GET /waypoints/get/2 (no waypoints)
        ]);
        renderLiveMap();

        await act(async () => {
            await flushMicrotasks();
        });

        const markers = screen.getAllByTestId("boat-marker");
        expect(markers).toHaveLength(2);
        expect(markers[0]).toHaveAttribute("data-boat-id", "1");
        expect(markers[1]).toHaveAttribute("data-boat-id", "2");
        // Status line reports how many boats are reporting.
        expect(screen.getByText(/2 of 2 boats reporting/i)).toBeInTheDocument();
    });

    it("renders a telemetry card below the map for each reporting boat", async () => {
        mockFetchSequence([
            { body: instances },
            { body: statusTheseus },
            { body: [] },
            { body: statusPersephone },
            { body: [] },
        ]);
        renderLiveMap();

        await act(async () => {
            await flushMicrotasks();
        });

        // The "Boat telemetry" heading marks the below-map section.
        const detailsHeading = screen.getByRole("heading", { name: /Boat telemetry/i });
        const detailsSection = detailsHeading.closest("section, div, article");
        expect(detailsSection).not.toBeNull();

        if (detailsSection) {
            const withinDetails = within(detailsSection as HTMLElement);
            // Both boat names appear in the details section.
            expect(withinDetails.getByText("theseus")).toBeInTheDocument();
            expect(withinDetails.getByText("persephone")).toBeInTheDocument();
            // Speed (from statusTheseus.speed = 2.5 m/s) appears.
            expect(withinDetails.getByText(/2\.500 m\/s/)).toBeInTheDocument();
        }
    });

    it("displays the waypoint stat as 1-based in the telemetry card", async () => {
        // current_waypoint_index is zero-based from the server (0 = first
        // waypoint), but BoatDetails displays it as 1-based (#1 for the
        // first waypoint) to match the Waypoints map tooltips.
        mockFetchSequence([
            { body: instances },
            { body: { ...statusTheseus, current_waypoint_index: 1 } },
            { body: [] },
            { body: statusPersephone },
            { body: [] },
        ]);
        renderLiveMap();

        await act(async () => {
            await flushMicrotasks();
        });

        const detailsHeading = screen.getByRole("heading", { name: /Boat telemetry/i });
        const detailsSection = detailsHeading.closest("section, div, article");
        expect(detailsSection).not.toBeNull();
        if (detailsSection) {
            const withinDetails = within(detailsSection as HTMLElement);
            // Index 1 (zero-based) → displayed as #2 (1-based).
            expect(withinDetails.getByText("#2")).toBeInTheDocument();
            // The zero-based value #1 must NOT appear for the waypoint stat
            // (it would be the bug we're guarding against).
            expect(withinDetails.queryByText("#1")).not.toBeInTheDocument();
        }
    });

    it("renders waypoints (polyline + numbered circle markers) when a boat has them", async () => {
        // Boat 1 has a 3-waypoint route; boat 2 has none.
        const wps = [
            [37.23, -80.41],
            [37.235, -80.415],
            [37.24, -80.42],
        ];
        mockFetchSequence([
            { body: instances },
            { body: { ...statusTheseus, current_waypoint_index: 1 } },
            { body: wps }, // GET /waypoints/get/1
            { body: statusPersephone },
            { body: [] }, // GET /waypoints/get/2
        ]);
        renderLiveMap();

        await act(async () => {
            await flushMicrotasks();
        });

        // One polyline for boat 1's route; boat 2 has no waypoints.
        const polylines = screen.getAllByTestId("polyline");
        expect(polylines).toHaveLength(1);
        expect(polylines[0]).toHaveAttribute("data-positions", JSON.stringify(wps));

        // Three circle markers (one per waypoint), each with a permanent tooltip.
        const circleMarkers = screen.getAllByTestId("circle-marker");
        expect(circleMarkers).toHaveLength(3);
        const tooltips = screen.getAllByTestId("tooltip");
        expect(tooltips).toHaveLength(3);
        // Tooltips are 1-based waypoint numbers.
        expect(tooltips[0]?.textContent).toBe("1");
        expect(tooltips[1]?.textContent).toBe("2");
        expect(tooltips[2]?.textContent).toBe("3");
    });

    it("shows the error card when fetch rejects", async () => {
        global.fetch = jest.fn(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
        renderLiveMap();

        await act(async () => {
            await flushMicrotasks();
        });

        expect(screen.getByText(/Can't reach the telemetry server/i)).toBeInTheDocument();
        expect(screen.getByText(/boom/i)).toBeInTheDocument();
        // No map card should be present in the error state.
        expect(screen.queryByTestId("map-container")).not.toBeInTheDocument();
    });

    it("shows the empty state when no boats are registered", async () => {
        mockFetchSequence([{ body: [] }]);
        renderLiveMap();

        await act(async () => {
            await flushMicrotasks();
        });

        expect(screen.getByText(/No boats registered/i)).toBeInTheDocument();
        expect(screen.queryByTestId("boat-marker")).not.toBeInTheDocument();
    });

    it("lists boats that are registered but have no GPS fix", async () => {
        // Instance 7 exists but its status comes back empty (no data yet) →
        // positionFromStatus returns null.
        mockFetchSequence([
            { body: [{ instance_id: 7, instance_identifier: "ghost" }] },
            { body: {} }, // empty status → no GPS
            { body: [] }, // GET /waypoints/get/7 (none)
        ]);
        renderLiveMap();

        await act(async () => {
            await flushMicrotasks();
        });

        expect(screen.getByText(/Registered but no GPS fix/i)).toBeInTheDocument();
        const card = screen.getByText(/Registered but no GPS fix/i).closest("section, div, article");
        expect(card).not.toBeNull();
        if (card) {
            expect(within(card as HTMLElement).getByText("ghost")).toBeInTheDocument();
        }
        // No marker for the GPS-less boat.
        expect(screen.queryByTestId("boat-marker")).not.toBeInTheDocument();
    });

    it("re-polls on the configured interval", async () => {
        const fn = mockFetchSequence([
            { body: instances },
            { body: statusTheseus },
            { body: [] }, // waypoints 1
            { body: statusPersephone },
            { body: [] }, // waypoints 2
            { body: instances }, // second poll
            { body: statusTheseus },
            { body: [] },
            { body: statusPersephone },
            { body: [] },
        ]);
        renderLiveMap();

        await act(async () => {
            await flushMicrotasks();
        });
        // Initial poll: 5 fetches (instances + 2×(status + waypoints)).
        expect(fn).toHaveBeenCalledTimes(5);

        // Advance past one polling interval (3000ms).
        await act(async () => {
            jest.advanceTimersByTime(3000);
            await flushMicrotasks();
        });
        expect(fn).toHaveBeenCalledTimes(10);
    });
});
