import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";

/**
 * Tests for the calendar event map.
 *
 * The behaviour here is all driven by an external geocoder, so every case
 * mocks `fetch` and asserts what the modal ends up showing: a map with a
 * marker, or nothing at all.
 *
 * WARNING: The last describe block is a source-level guard, not a render test.
 * `leaflet/dist/leaflet.css` is a stylesheet, and Jest's moduleNameMapper
 * stubs stylesheets out, so no render test can notice it going missing -- but
 * it going missing is exactly what broke this component (Leaflet's panes
 * rendered `position: static` and the tiles scattered outside the container
 * box). Reading the imports is the only way to catch a regression here.
 */

import EventMap from "../../components/EventMap";

type FetchMock = jest.Mock;

interface MockResponse {
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<unknown>;
}

function jsonResponse(body: unknown): MockResponse {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
    };
}

function fetchMockOnce(body: unknown): FetchMock {
    const fn = jest.fn(() => Promise.resolve(jsonResponse(body))) as unknown as FetchMock;
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

const realFetch = global.fetch;

afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
});

describe("EventMap", () => {
    it("geocodes the location and drops a marker on the result", async () => {
        const fetchMock = fetchMockOnce([{ lat: "37.2284", lon: "-80.4232" }]);
        render(<EventMap location="Holden Auditorium" />);

        await waitFor(() => expect(screen.getByTestId("map-container")).toBeInTheDocument());
        expect(screen.getByTestId("circle-marker")).toHaveAttribute("data-center", "[37.2284,-80.4232]");

        // The query is URL-encoded and carries a descriptive User-Agent, which
        // Nominatim's usage policy requires.
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain("q=Holden%20Auditorium");
        expect((init.headers as Record<string, string>)["User-Agent"]).toContain("autoboat-website");
    });

    it("links out to Google Maps directions for the geocoded point", async () => {
        fetchMockOnce([{ lat: "37.2284", lon: "-80.4232" }]);
        render(<EventMap location="Holden Auditorium" />);

        const link = await screen.findByRole("link", { name: /Open directions/i });
        expect(link.getAttribute("href")).toContain("destination=37.2284,-80.4232");
    });

    it("renders nothing when the location cannot be geocoded", async () => {
        fetchMockOnce([]);
        render(<EventMap location="Somewhere invented" />);

        // Wait for the request to settle, then confirm the map never appeared.
        await waitFor(() => expect(screen.queryByTestId("tile-layer")).not.toBeInTheDocument());
        expect(screen.queryByTestId("map-container")).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /Open directions/i })).not.toBeInTheDocument();
    });

    it("renders nothing when the geocoder request fails", async () => {
        const fn = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as FetchMock;
        global.fetch = fn as unknown as typeof fetch;
        render(<EventMap location="Holden Auditorium" />);

        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByTestId("map-container")).not.toBeInTheDocument();
    });

    it("keeps the last geocode from rendering after the prop changes", async () => {
        // Two requests: the first resolves late and must be ignored. Without
        // the abort check the stale result wins and the modal shows a marker
        // in the wrong place.
        let resolveFirst: (value: MockResponse) => void = () => {};
        const fn = jest
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<MockResponse>((res) => {
                        resolveFirst = res;
                    }),
            )
            .mockImplementationOnce(() =>
                Promise.resolve(jsonResponse([{ lat: "1", lon: "2" }])),
            ) as unknown as FetchMock;
        global.fetch = fn as unknown as typeof fetch;

        const { rerender } = render(<EventMap location="First place" />);
        rerender(<EventMap location="Second place" />);

        await waitFor(() => expect(screen.getByTestId("circle-marker")).toHaveAttribute("data-center", "[1,2]"));

        await act(async () => {
            resolveFirst(jsonResponse([{ lat: "50", lon: "60" }]));
            await Promise.resolve();
        });
        expect(screen.getByTestId("circle-marker")).toHaveAttribute("data-center", "[1,2]");
    });
});

describe("EventMap stylesheet", () => {
    const source = readFileSync(resolve(__dirname, "../../components/EventMap.tsx"), "utf8");

    it("imports Leaflet's base CSS itself", () => {
        // LiveMap is a lazy route, so its stylesheet lives in that route's CSS
        // chunk. The calendar never loads that chunk; without this import the
        // map renders with Leaflet's DOM but none of its positioning rules.
        //
        // Anchored to the start of the line on purpose: a regex that allows any
        // leading text also matches a commented-out import, which is exactly the
        // state this test exists to catch.
        const imports = source.split("\n").map((line) => line.trim());
        expect(imports).toContain('import "leaflet/dist/leaflet.css";');
    });
});
