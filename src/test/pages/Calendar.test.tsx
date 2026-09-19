import { afterEach } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { type CalendarEvent, DISCORD_GUILD_ID } from "../../lib/discord";

/**
 * Tests for the Calendar page. Mirrors the LiveMap pattern: mock global
 * fetch with minimal duck-typed responses and wrap in MemoryRouter.
 */

import Calendar from "../../pages/Calendar";

// --- Mock-response helpers -------------------------------------------------

type FetchMock = jest.Mock;

interface MockResponse {
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, init?: { status?: number }): MockResponse {
    const status = init?.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
    };
}

function mockFetchOnce(body: unknown, init?: { status?: number }): FetchMock {
    const fn = jest.fn(() => Promise.resolve(jsonResponse(body, init))) as unknown as FetchMock;
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

function mockFetchReject(error: Error): FetchMock {
    const fn = jest.fn(() => Promise.reject(error)) as unknown as FetchMock;
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

function mockFetchNeverResolves(): FetchMock {
    const fn = jest.fn(() => new Promise<MockResponse>(() => {})) as unknown as FetchMock;
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

// --- Helpers ---------------------------------------------------------------

const realFetch = global.fetch;

afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
});

function renderCalendar() {
    return render(
        <MemoryRouter>
            <Calendar />
        </MemoryRouter>,
    );
}

/** Flush microtasks so the fetchEvents().then() chain settles. */
async function flushMicrotasks() {
    for (let i = 0; i < 6; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
}

function sampleEvent(partial: Partial<CalendarEvent> & Pick<CalendarEvent, "id" | "name" | "start">): CalendarEvent {
    return {
        description: null,
        end: null,
        status: "scheduled",
        location: null,
        userCount: null,
        isRecurring: false,
        image: null,
        recurrenceRule: null,
        ...partial,
    };
}

/**
 * Build a date inside the same month the browser is currently showing. The
 * page's initial state uses `new Date()`, so tests have to do the same to
 * stay in sync regardless of when the suite runs.
 */
function currentMonth(day: number, isoTime = "T19:00:00.000Z"): string {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), day);
    return d.toISOString().slice(0, 10) + isoTime;
}

// --- Tests -----------------------------------------------------------------

describe("Calendar page", () => {
    it("shows a loading spinner before the fetch resolves", () => {
        mockFetchNeverResolves();
        renderCalendar();
        expect(screen.getByText(/Loading events/i)).toBeInTheDocument();
    });

    it("renders a complete month grid once events load", async () => {
        mockFetchOnce([]);
        const { container } = renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        // The grid covers the full visible month plus the surrounding
        // other-month weekend padding. We assert a plausible range rather
        // than an exact multiple-of-7 because grid generation does not
        // guarantee week-aligned output across all month shapes.
        const cells = container.querySelectorAll(".calendar-day");
        expect(cells.length).toBeGreaterThanOrEqual(28);
        expect(cells.length).toBeLessThanOrEqual(42);
        expect(container.querySelectorAll(".calendar-dow")).toHaveLength(7);

        // No events -> empty-state message visible.
        expect(screen.getByText(/No events are scheduled yet/i)).toBeInTheDocument();
    });

    it("renders current-month events as chips linking to Discord", async () => {
        const events = [
            sampleEvent({
                id: "111",
                name: "Team meeting",
                start: currentMonth(10),
            }),
        ];
        mockFetchOnce(events);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        // The visible chip text includes the event name.
        expect(screen.getByText("Team meeting")).toBeInTheDocument();

        // The chip links to Discord's canonical event URL.
        const link = screen.getByRole("link", { name: /Team meeting/i });
        expect(link).toHaveAttribute("href", `https://discord.com/channels/${DISCORD_GUILD_ID}/111`);
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    });

    it("expands recurring events into one chip per occurrence", async () => {
        // Daily event starting on the 1st of the current month (UTC).
        const now = new Date();
        const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const events = [
            sampleEvent({
                id: "rec",
                name: "Daily standup",
                start: firstOfMonth.toISOString(),
                isRecurring: true,
                recurrenceRule: "FREQ=DAILY;INTERVAL=1;COUNT=3",
            }),
        ];
        mockFetchOnce(events);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        // 3 occurrences -> 3 visible chips with the same name, regardless of
        // where in the calendar grid they land.
        const chips = screen.getAllByText("Daily standup");
        expect(chips.length).toBe(3);
    });

    it("does not render events that fall in a different month", async () => {
        const now = new Date();
        // Next month, e.g. if now is March 2026, this is April 10 2026.
        const future = new Date(now.getFullYear(), now.getMonth() + 1, 10);
        const events = [
            sampleEvent({
                id: "111",
                name: "Future event",
                start: future.toISOString(),
            }),
        ];
        mockFetchOnce(events);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        expect(screen.queryByText("Future event")).not.toBeInTheDocument();
    });

    it("navigates to next/prev month with the chevron buttons", async () => {
        const now = new Date();
        // Two months ahead so the event is definitely not on the current grid
        // even on months that spill over into adjacent weeks.
        const future = new Date(now.getFullYear(), now.getMonth() + 2, 15);
        const events = [
            sampleEvent({
                id: "111",
                name: "Future event",
                start: future.toISOString(),
            }),
        ];
        mockFetchOnce(events);
        const { container } = renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        // Not visible yet -- event is two months out.
        expect(screen.queryByText("Future event")).not.toBeInTheDocument();

        // Click "Next month" twice -> future month visible.
        const nextBtn = screen.getByRole("button", { name: /Next month/i });
        await act(async () => {
            fireEvent.click(nextBtn);
        });
        await act(async () => {
            fireEvent.click(nextBtn);
        });
        expect(screen.getByText("Future event")).toBeInTheDocument();

        // Click "Prev month" twice -> back to current month, event hidden.
        const prevBtn = screen.getByRole("button", { name: /Previous month/i });
        await act(async () => {
            fireEvent.click(prevBtn);
        });
        await act(async () => {
            fireEvent.click(prevBtn);
        });
        expect(screen.queryByText("Future event")).not.toBeInTheDocument();

        // Sanity: the current month label rendered.
        expect(container.querySelector(".calendar-month-label")?.textContent).toContain(
            now.toLocaleDateString(undefined, { month: "long", year: "numeric" }).split(" ")[0],
        );
    });

    it("shows the error card when the fetch rejects", async () => {
        mockFetchReject(new Error("network down"));
        const { container } = renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        expect(screen.getByText(/Couldn't load events/i)).toBeInTheDocument();
        expect(screen.getByText(/network down/i)).toBeInTheDocument();
        // No month grid in the error state.
        expect(container.querySelector(".calendar-day")).toBeNull();
    });

    it("shows the error card when the server returns a non-2xx status", async () => {
        mockFetchOnce({ error: "discord upstream unavailable" }, { status: 502 });
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        expect(screen.getByText(/Couldn't load events/i)).toBeInTheDocument();
        expect(screen.getByText(/status 502/i)).toBeInTheDocument();
    });
});
