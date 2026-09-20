import { afterEach } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { type CalendarEvent, EVENTS_ICS_URL } from "../../lib/discord";

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

    it("exposes a subscribe control that links to the .ics feed", async () => {
        mockFetchOnce([]);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        // The Subscribe toggle sits in the calendar header; expanding it
        // reveals the provider links and the raw feed URL.
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));
        expect(screen.getByTestId("subscribe-webcal")).toHaveAttribute("href", expect.stringContaining("webcals://"));
        expect(screen.getByText(EVENTS_ICS_URL)).toBeInTheDocument();
    });

    it("keeps the subscribe control inside the header so its panel can anchor there", async () => {
        // Regression guard for the panel's layout. The panel is an absolutely
        // positioned dropdown anchored to `.calendar-header` (the nearest
        // positioned ancestor, via `position: relative`), NOT to the toggle:
        // on mobile the toggle sits mid-row, so a panel hanging off it ran off
        // the side of the viewport. If the subscribe control ever moves out of
        // the header, the panel loses its anchor and the `min(25rem, 100%)`
        // width clamp no longer resolves against the header either.
        mockFetchOnce([]);
        const { container } = renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        const header = container.querySelector(".calendar-header");
        expect(header).not.toBeNull();
        expect(header?.querySelector(".calendar-subscribe")).not.toBeNull();

        // The toggle and its panel live in the same wrapper, and aria-controls
        // points at the panel it toggles.
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));
        const toggle = container.querySelector(".calendar-subscribe__toggle");
        const panel = container.querySelector(".calendar-subscribe__panel");
        expect(panel).not.toBeNull();
        expect(toggle?.getAttribute("aria-controls")).toBe(panel?.id);
    });

    it("aligns day numbers with the correct weekday column", async () => {
        // Regression test: the grid starts on Sunday. The number of leading
        // other-month pad cells before the 1st must equal the 1st's getDay()
        // (Sun=0). A previous version used an inverted lookup that treated the
        // grid as Mon-start, shifting every date 5-6 columns off its weekday.
        mockFetchOnce([]);
        const { container } = renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        const now = new Date();
        const expectedLeadingPads = new Date(now.getFullYear(), now.getMonth(), 1).getDay();

        const dayCells = Array.from(container.querySelectorAll<HTMLElement>(".calendar-day"));
        let leadingPads = 0;
        for (const cell of dayCells) {
            if (cell.classList.contains("calendar-day--other-month")) leadingPads++;
            else break;
        }
        expect(leadingPads).toBe(expectedLeadingPads);

        // The first in-month cell must be the 1st and be a day whose weekday
        // matches its column index (column 0 = Sunday).
        const firstInMonthIndex = dayCells.findIndex((c) => !c.classList.contains("calendar-day--other-month"));
        const firstDayNumber = dayCells[firstInMonthIndex]?.querySelector(".calendar-day-number")?.textContent;
        expect(firstDayNumber).toBe("1");
        expect(firstInMonthIndex % 7).toBe(expectedLeadingPads % 7);
    });

    it("renders current-month events as clickable chips", async () => {
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

        // Chips are buttons that open the detail modal.
        const chip = screen.getByRole("button", { name: /Team meeting/i });
        expect(chip).toBeInTheDocument();
    });

    it("opens a detail modal when an event chip is clicked, and shows a map for its location", async () => {
        const events = [
            sampleEvent({
                id: "evt-1",
                name: "General Body Meeting",
                description: "Team meeting open to all.\nLocation: **Holden Auditorium**",
                start: currentMonth(10),
                // No API location: the extractor should read it from the
                // labeled line in the description.
                location: null,
            }),
        ];
        // First fetch: the calendar's events. Second fetch: EventMap's
        // Nominatim geocode for the location.
        const fetchMock = jest
            .fn()
            .mockImplementationOnce(() => Promise.resolve(jsonResponse(events)))
            .mockImplementationOnce(() =>
                Promise.resolve(jsonResponse([{ lat: "37.2284", lon: "-80.4232" }])),
            ) as unknown as FetchMock;
        global.fetch = fetchMock as unknown as typeof fetch;

        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        fireEvent.click(screen.getByRole("button", { name: /General Body Meeting/i }));

        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        const dlg = within(dialog);
        expect(dlg.getByText("General Body Meeting")).toBeInTheDocument();

        // Date (long form) and start time sit in the same meta row.
        expect(dlg.getByText(/^\w+, \w+ \d{1,2}, \d{4} at /)).toBeInTheDocument();

        // Location sits in its own meta row (icon + text).
        expect(dlg.getByText("Holden Auditorium", { selector: ".event-modal__meta-row" })).toBeInTheDocument();

        // The extracted location is stripped from the description body, so it
        // appears only in the meta row -- no leftover <strong> duplicate.
        expect(dlg.getByText(/Team meeting open to all/)).toBeInTheDocument();
        expect(dlg.queryByText("Holden Auditorium", { selector: "strong" })).not.toBeInTheDocument();

        // Physical locations render an embedded map with a marker.
        await waitFor(() => expect(dlg.getByTestId("map-container")).toBeInTheDocument());
        expect(dlg.getByTestId("circle-marker")).toHaveAttribute("data-center", "[37.2284,-80.4232]");
        expect(dlg.getByRole("link", { name: /Open directions/i })).toHaveAttribute(
            "href",
            expect.stringContaining("https://www.google.com/maps/dir/"),
        );
    });

    it("does not render a map for events without a physical location", async () => {
        const events = [
            sampleEvent({
                id: "evt-2",
                name: "Online Sync",
                description: "Zoom link in Discord.",
                start: currentMonth(10),
                location: null,
            }),
        ];
        mockFetchOnce(events);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        fireEvent.click(screen.getByRole("button", { name: /Online Sync/i }));

        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        const dlg = within(dialog);
        expect(dlg.getByText("No location specified")).toBeInTheDocument();
        expect(dlg.queryByTestId("map-container")).not.toBeInTheDocument();

        // No Nominatim geocode request should fire when there's no location.
        const fetchMock = global.fetch as FetchMock;
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("closes the modal on the close button, then reopens on the next click", async () => {
        const events = [
            sampleEvent({
                id: "evt-1",
                name: "General Body Meeting",
                start: currentMonth(10),
            }),
        ];
        mockFetchOnce(events);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        fireEvent.click(screen.getByRole("button", { name: /General Body Meeting/i }));
        await waitFor(() => expect(screen.getByRole("dialog")).toHaveClass("is-open"));

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        // Exit transition: the dialog hides immediately but unmounts after 200ms.
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        fireEvent.click(screen.getByRole("button", { name: /General Body Meeting/i }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("closes the modal on Escape", async () => {
        const events = [
            sampleEvent({
                id: "evt-1",
                name: "General Body Meeting",
                start: currentMonth(10),
            }),
        ];
        mockFetchOnce(events);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        fireEvent.click(screen.getByRole("button", { name: /General Body Meeting/i }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();

        fireEvent.keyDown(document, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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

describe("Calendar page (mobile branch)", () => {
    const realMatchMedia = window.matchMedia;

    beforeEach(() => {
        // Force the mobile branch: Calendar.tsx reads
        // matchMedia("(max-width: 700px)") once on mount.
        window.matchMedia = (query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
        });
    });

    afterEach(() => {
        window.matchMedia = realMatchMedia;
    });

    it("renders day cells as buttons with event-count aria-labels", async () => {
        const now = new Date();
        const today = now.getDate();
        const events = [sampleEvent({ id: "m1", name: "General Body Meeting", start: currentMonth(today) })];
        mockFetchOnce(events);
        const { container } = renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        const dayButtons = container.querySelectorAll("button.calendar-day");
        expect(dayButtons.length).toBeGreaterThanOrEqual(28);
        expect(dayButtons.length).toBeLessThanOrEqual(42);

        // Single-letter weekday headings shown visually ("S"), full name
        // stays available to screen readers via the sr-only span.
        const firstDow = container.querySelector(".calendar-dow");
        expect(firstDow?.querySelector('[aria-hidden="true"]')?.textContent).toBe("S");
        expect(firstDow?.querySelector(".sr-only")?.textContent).toBe("Sun");

        // Today has 1 event -> singular "1 event" in the aria-label.
        const todayDate = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
        const todayCell = screen.getByRole("button", { name: `${todayDate}, 1 event` });
        expect(todayCell).toBeInTheDocument();
        // No name-text chips inside mobile day cells -- just dots.
        expect(todayCell.textContent).not.toContain("General Body Meeting");
        expect(todayCell.querySelectorAll(".calendar-day-dot")).toHaveLength(1);
    });

    it("defaults the agenda to today and swaps content when another day is tapped", async () => {
        const now = new Date();
        const today = now.getDate();
        const otherDay = today <= 14 ? 20 : 5;
        const events = [
            sampleEvent({ id: "m1", name: "Today Meeting", start: currentMonth(today) }),
            sampleEvent({ id: "m2", name: "Other Day Meeting", start: currentMonth(otherDay) }),
        ];
        mockFetchOnce(events);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        // Agenda defaults to today, and its day cell is the pressed one.
        expect(screen.getByText("Today Meeting")).toBeInTheDocument();
        expect(screen.queryByText("Other Day Meeting")).not.toBeInTheDocument();
        const todayDate = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
        expect(screen.getByRole("button", { name: `${todayDate}, 1 event` })).toHaveAttribute("aria-pressed", "true");

        // Tap the other day -> agenda swaps to that day's events.
        const otherDate = new Date(now.getFullYear(), now.getMonth(), otherDay).toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: `${otherDate}, 1 event` }));
        });
        expect(screen.getByText("Other Day Meeting")).toBeInTheDocument();
        expect(screen.queryByText("Today Meeting")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: `${otherDate}, 1 event` })).toHaveAttribute("aria-pressed", "true");
    });

    it("opens the detail modal from an agenda row", async () => {
        const now = new Date();
        const events = [sampleEvent({ id: "m1", name: "Agenda Modal Test", start: currentMonth(now.getDate()) })];
        mockFetchOnce(events);
        renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        fireEvent.click(screen.getByRole("button", { name: /Agenda Modal Test/i }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(within(screen.getByRole("dialog")).getByText("Agenda Modal Test")).toBeInTheDocument();
    });

    it("shows a muted dot for canceled events and moves selection when navigating months", async () => {
        const now = new Date();
        const today = now.getDate();
        const events = [
            sampleEvent({ id: "m1", name: "Dead Meeting", start: currentMonth(today), status: "canceled" }),
        ];
        mockFetchOnce(events);
        const { container } = renderCalendar();
        await act(async () => {
            await flushMicrotasks();
        });

        expect(container.querySelector(".calendar-day-dot--muted")).not.toBeNull();

        // Month navigation follows the agenda to the 1st of the new month so
        // it never shows a day the grid no longer displays.
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const heading = nextMonth.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /Next month/i }));
        });
        expect(container.querySelector(".calendar-agenda__heading")?.textContent).toBe(heading);
    });
});
