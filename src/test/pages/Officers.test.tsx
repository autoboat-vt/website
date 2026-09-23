import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EVENTS_ICS_URL, OFFICERS_ICS_URL, OFFICERS_URL } from "../../lib/discord";

/**
 * Tests for the officers calendar page.
 *
 * The thing that matters here is not visible from the component alone: it
 * reads the OFFICER feed, not the public one. A copy-paste of the public page
 * would look identical but silently show the wrong (smaller) event set -- the
 * bug would be invisible, since both render a calendar.
 */

import Officers from "../../pages/Officers";

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

function renderOfficers() {
    return render(
        <MemoryRouter>
            <Officers />
        </MemoryRouter>,
    );
}

describe("Officers page", () => {
    it("requests the officer feed, not the public one", async () => {
        const fetchMock = fetchMockOnce([]);
        renderOfficers();
        await act(async () => {
            await Promise.resolve();
        });

        // Must be the officer route specifically -- the public route is a
        // substring-compatible neighbour (both end in /events), so compare
        // the full URL rather than pattern-matching the tail.
        expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toBe(`${OFFICERS_URL}/events`);
    });

    it("points the subscribe control at the officer .ics feed", async () => {
        fetchMockOnce([]);
        renderOfficers();
        await act(async () => {
            await Promise.resolve();
        });

        // Open the subscribe panel.
        (screen.getByRole("button", { name: /Subscribe/i }) as HTMLButtonElement).click();
        await act(async () => {
            await Promise.resolve();
        });

        expect(screen.getByText(OFFICERS_ICS_URL)).toBeInTheDocument();
        expect(screen.queryByText(EVENTS_ICS_URL)).not.toBeInTheDocument();
    });

    it("offers the officer feed as a webcal subscription", async () => {
        fetchMockOnce([]);
        renderOfficers();
        await act(async () => {
            await Promise.resolve();
        });

        (screen.getByRole("button", { name: /Subscribe/i }) as HTMLButtonElement).click();
        await act(async () => {
            await Promise.resolve();
        });

        expect(screen.getByTestId("subscribe-webcal")).toHaveAttribute("href", expect.stringContaining("webcals://"));
        expect(screen.getByTestId("subscribe-webcal")).toHaveAttribute(
            "href",
            OFFICERS_ICS_URL.replace(/^https?:\/\//, "webcals://"),
        );
    });

    it("exposes an accessible page heading", () => {
        fetchMockOnce([]);
        renderOfficers();
        expect(screen.getByRole("heading", { level: 1, name: /Officers Calendar/i })).toBeInTheDocument();
    });

    it("builds the officer feed URL from the worker base URL", () => {
        // Guards the derivation: OFFICERS_ICS_URL must hang off the same
        // Worker origin as the public feed, or the officer page would fetch
        // one host and subscribe to another.
        expect(OFFICERS_URL).toContain("/officers");
        expect(OFFICERS_ICS_URL).toBe(`${OFFICERS_URL}/calendar.ics`);
        expect(EVENTS_ICS_URL).not.toBe(OFFICERS_ICS_URL);
    });
});

describe("route registration", () => {
    // The page path is /calendar/officers while the Worker API path is
    // /officers/events. Asserting the route table proves the site path did not
    // get "harmonized" to match the API, and that the nested route does not
    // shadow its parent.
    it("registers /calendar/officers and not a bare /officers page", async () => {
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const app = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");

        expect(app).toContain('path="/calendar/officers"');
        // A bare /officers route would be a second, unlisted address for the
        // same page -- confusing and easy to forget when rotated.
        expect(app).not.toMatch(/path="\/officers"/);
    });

    it("writes an SPA fallback for the nested path", async () => {
        // Without this entry S3 404s on a hard navigation to /calendar/officers,
        // even though client-side navigation to it works.
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const spa = readFileSync(resolve(__dirname, "../../../scripts/spa-fallback.mjs"), "utf8");
        expect(spa).toContain('"/calendar/officers"');
    });

    it("stays unlisted on every public surface", async () => {
        // The visible warning banner was removed at the team's request, so the
        // page no longer tells a reader it is unguessable-rather-than-protected.
        // That makes this the only guard of the real invariant: the path must
        // not be advertised on any public surface. Add it to one of these and
        // the route stops being unlisted while every other test still passes.
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");

        const navLinks = readFileSync(resolve(__dirname, "../../components/Header.tsx"), "utf8");
        expect(navLinks).not.toContain("/calendar/officers");

        const otherPages = readFileSync(resolve(__dirname, "../../pages/OtherPages.tsx"), "utf8");
        expect(otherPages).not.toContain("/calendar/officers");

        const readme = readFileSync(resolve(__dirname, "../../../README.md"), "utf8");
        expect(readme).not.toContain("/calendar/officers");
    });
});
