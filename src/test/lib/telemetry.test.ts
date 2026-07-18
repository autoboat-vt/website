import {
    fetchAllInstances,
    fetchBoatStatus,
    fetchBoatStatusIfNew,
    fetchFleetState,
    formatKnots,
    formatLastSeen,
    headingToCompass,
    positionFromStatus,
    TELEMETRY_URL,
    TelemetryError,
} from "../../lib/telemetry";

/**
 * Tests for the telemetry client. We mock global `fetch` rather than the
 * network, so these run entirely in jsdom without hitting the server.
 *
 * `fetchJson` only consumes `.ok`, `.status`, and `.json()` from the response,
 * so we use a minimal duck-typed stand-in instead of `new Response(...)` —
 * jsdom does not expose the Fetch API constructors, and this keeps the tests
 * free of any environment polyfill.
 */

type FetchMock = jest.Mock;

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

function mockFetchOnce(body: unknown, init?: { status?: number }): FetchMock {
    const fn = jest.fn(() => Promise.resolve(jsonResponse(body, init))) as unknown as FetchMock;
    global.fetch = fn;
    return fn;
}

describe("telemetry client", () => {
    const realFetch = global.fetch;

    afterEach(() => {
        global.fetch = realFetch;
        jest.restoreAllMocks();
    });

    describe("TELEMETRY_URL", () => {
        it("defaults to the production URL", () => {
            expect(TELEMETRY_URL).toBe("https://vt-autoboat-telemetry.uk");
        });
    });

    describe("fetchAllInstances", () => {
        it("GETs /instance_manager/get_all_instance_info and returns the parsed list", async () => {
            const instances = [
                {
                    instance_id: 1,
                    instance_identifier: "theseus",
                    user: "alice",
                    current_config_hash: "abc",
                    created_at: "2024-01-01T00:00:00Z",
                    updated_at: "2024-01-02T00:00:00Z",
                },
            ];
            const fn = mockFetchOnce(instances);

            const result = await fetchAllInstances();

            expect(fn).toHaveBeenCalledTimes(1);
            const firstCall = fn.mock.calls[0];
            expect(firstCall).toBeDefined();
            if (!firstCall) return; // narrow for TS; jest would have thrown above
            const [url, init] = firstCall;
            expect(url).toBe(`${TELEMETRY_URL}/instance_manager/get_all_instance_info`);
            expect(init?.headers).toMatchObject({ Accept: "application/json" });
            expect(init?.mode).toBe("cors");
            expect(result).toEqual(instances);
        });

        it("throws TelemetryError if the response is not an array", async () => {
            mockFetchOnce({ not: "an array" });
            await expect(fetchAllInstances()).rejects.toThrow(TelemetryError);
        });

        it("throws TelemetryError on HTTP 500", async () => {
            global.fetch = jest.fn(() =>
                Promise.resolve(jsonResponse({ error: "server error" }, { status: 500 })),
            ) as unknown as FetchMock;
            await expect(fetchAllInstances()).rejects.toThrow(/HTTP 500/);
        });

        it("throws TelemetryError on network failure", async () => {
            global.fetch = jest.fn(() => Promise.reject(new Error("Failed to fetch"))) as unknown as FetchMock;
            await expect(fetchAllInstances()).rejects.toThrow(/Network error/);
        });
    });

    describe("fetchBoatStatus", () => {
        it("returns null when the server returns an empty object (no data yet)", async () => {
            mockFetchOnce({});
            const result = await fetchBoatStatus(1);
            expect(result).toBeNull();
        });

        it("returns the parsed status dict when non-empty", async () => {
            const status = { latitude: 37.22, longitude: -80.41, speed: 2.5, heading: 90 };
            const fn = mockFetchOnce(status);
            const result = await fetchBoatStatus(42);
            const firstCall = fn.mock.calls[0];
            expect(firstCall?.[0]).toBe(`${TELEMETRY_URL}/boat_status/get/42`);
            expect(result).toEqual(status);
        });
    });

    describe("fetchBoatStatusIfNew", () => {
        it("returns null when the server returns {} (no new data since last poll)", async () => {
            mockFetchOnce({});
            const result = await fetchBoatStatusIfNew(1);
            expect(result).toBeNull();
        });

        it("returns the new status when present", async () => {
            const status = { latitude: 37.23, longitude: -80.42, heading: 180 };
            mockFetchOnce(status);
            const result = await fetchBoatStatusIfNew(1);
            expect(result).toEqual(status);
        });
    });

    describe("fetchFleetState", () => {
        it("fetches all instances and each boat_status in parallel, merging into BoatWithPosition[]", async () => {
            // First call: get_all_instance_info. Then one call per instance.
            const instances = [
                {
                    instance_id: 1,
                    instance_identifier: "theseus",
                    user: "a",
                    current_config_hash: "",
                    created_at: "",
                    updated_at: "",
                },
                {
                    instance_id: 2,
                    instance_identifier: "sailboat1",
                    user: "b",
                    current_config_hash: "",
                    created_at: "",
                    updated_at: "",
                },
            ];
            const status1 = { latitude: 37.22, longitude: -80.41, speed: 1, heading: 0 };
            const status2 = { latitude: 0, longitude: 0 }; // GPS sentinel — should yield null position

            global.fetch = jest
                .fn()
                .mockResolvedValueOnce(jsonResponse(instances))
                .mockResolvedValueOnce(jsonResponse(status1))
                .mockResolvedValueOnce(jsonResponse(status2)) as unknown as FetchMock;

            const fleet = await fetchFleetState();

            expect(fleet).toHaveLength(2);
            const boat1 = fleet[0];
            const boat2 = fleet[1];
            expect(boat1?.instance.instance_id).toBe(1);
            expect(boat1?.status).toEqual(status1);
            expect(boat1?.position).toEqual({ lat: 37.22, lng: -80.41 });
            expect(boat1?.lastUpdated).not.toBeNull();
            // Boat 2 sent (0,0) — position should be null (treated as no GPS fix).
            expect(boat2?.position).toBeNull();
        });

        it("includes instances whose status fetch fails, with status/position null", async () => {
            const instances = [
                {
                    instance_id: 9,
                    instance_identifier: "ghost",
                    user: "x",
                    current_config_hash: "",
                    created_at: "",
                    updated_at: "",
                },
            ];
            global.fetch = jest
                .fn()
                .mockResolvedValueOnce(jsonResponse(instances))
                .mockRejectedValueOnce(new Error("boom")) as unknown as FetchMock;

            const fleet = await fetchFleetState();
            expect(fleet).toHaveLength(1);
            const boat = fleet[0];
            expect(boat?.instance.instance_id).toBe(9);
            expect(boat?.status).toBeNull();
            expect(boat?.position).toBeNull();
            expect(boat?.lastUpdated).toBeNull();
        });

        it("returns [] when there are no instances", async () => {
            mockFetchOnce([]);
            const fleet = await fetchFleetState();
            expect(fleet).toEqual([]);
        });
    });

    describe("positionFromStatus", () => {
        it("returns null for null status", () => {
            expect(positionFromStatus(null)).toBeNull();
        });
        it("returns null when lat/lng are missing", () => {
            expect(positionFromStatus({} as never)).toBeNull();
        });
        it("returns null for the (0,0) sentinel", () => {
            expect(positionFromStatus({ latitude: 0, longitude: 0 })).toBeNull();
        });
        it("returns null for non-numeric coords", () => {
            expect(positionFromStatus({ latitude: "x", longitude: -80 } as never)).toBeNull();
            expect(positionFromStatus({ latitude: NaN, longitude: -80 } as never)).toBeNull();
        });
        it("returns {lat,lng} for valid coords", () => {
            expect(positionFromStatus({ latitude: 37.22, longitude: -80.41 })).toEqual({ lat: 37.22, lng: -80.41 });
        });
    });

    describe("headingToCompass", () => {
        it("returns — for missing/invalid heading", () => {
            expect(headingToCompass(undefined)).toBe("—");
            expect(headingToCompass(NaN)).toBe("—");
        });
        it("maps cardinal directions", () => {
            expect(headingToCompass(0)).toMatch(/^N /);
            expect(headingToCompass(90)).toMatch(/^E /);
            expect(headingToCompass(180)).toMatch(/^S /);
            expect(headingToCompass(270)).toMatch(/^W /);
            expect(headingToCompass(225)).toMatch(/^SW /);
        });
        it("wraps negative headings", () => {
            expect(headingToCompass(-90)).toMatch(/^W /);
        });
    });

    describe("formatKnots", () => {
        it("returns — for missing/invalid speed", () => {
            expect(formatKnots(undefined)).toBe("—");
            expect(formatKnots(NaN)).toBe("—");
        });
        it("converts m/s to knots (1 m/s ≈ 1.944 kn)", () => {
            expect(formatKnots(1)).toBe("1.9 kn");
            expect(formatKnots(0)).toBe("0.0 kn");
        });
    });

    describe("formatLastSeen", () => {
        it("returns 'never' for null", () => {
            expect(formatLastSeen(null)).toBe("never");
        });
        it("returns 'just now' for <5s ago", () => {
            expect(formatLastSeen(Date.now() - 1000)).toBe("just now");
        });
        it("returns seconds for <60s", () => {
            const s = Math.round((Date.now() - (Date.now() - 30000)) / 1000);
            expect(formatLastSeen(Date.now() - 30000)).toMatch(new RegExp(`^${s}s ago$`));
        });
        it("returns minutes for >=60s", () => {
            expect(formatLastSeen(Date.now() - 120000)).toMatch(/^2m ago$/);
        });
    });
});
