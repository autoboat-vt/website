/**
 * Tests for the event modal's officer delete control.
 *
 * WARNING: The Worker is the real gate (see src/test/worker/eventCreate.routes.test.ts).
 * These tests cover the two things the UI itself is responsible for: that the
 * control only appears for a signed-in session, and that deletion takes a
 * deliberate confirmation rather than a single stray click.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import EventModal from "../../components/EventModal";
import type { CalendarEvent, ExpandedOccurrence } from "../../lib/discord";
import { MANAGE_URL } from "../../lib/eventManage";

const SESSION_KEY = "autoboat.calendar.session";
const MANAGE = MANAGE_URL;

const EVENT_ID = "1340000000000000001";

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        id: EVENT_ID,
        name: "Software Meeting",
        description: null,
        start: "2026-11-05T19:00:00.000Z",
        end: null,
        status: "scheduled",
        location: null,
        userCount: null,
        isRecurring: false,
        image: null,
        recurrenceRule: null,
        cancelledDates: [],
        channelId: null,
        ...overrides,
    };
}

function makeOccurrence(overrides: Partial<CalendarEvent> = {}): ExpandedOccurrence {
    const event = makeEvent(overrides);
    return { event, start: new Date(event.start), end: new Date(event.start), isCancelled: false };
}

function seedSession() {
    localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ token: "session-token", name: "Officer Ada", expiresAt: Date.now() + 60 * 60 * 1000 }),
    );
}

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as Response;
}

const realFetch = global.fetch;

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    global.fetch = realFetch;
    localStorage.clear();
    jest.restoreAllMocks();
});

describe("officer delete control", () => {
    it("is absent when nobody is signed in", () => {
        render(<EventModal occurrence={makeOccurrence()} onClose={() => {}} />);
        expect(screen.queryByRole("button", { name: /delete event/i })).not.toBeInTheDocument();
    });

    it("appears for a signed-in officer", () => {
        seedSession();
        render(<EventModal occurrence={makeOccurrence()} onClose={() => {}} />);
        expect(screen.getByRole("button", { name: /delete event/i })).toBeInTheDocument();
    });

    it("requires a confirmation before deleting", async () => {
        seedSession();
        const fetchMock = jest.fn(async () => jsonResponse({ deleted: EVENT_ID }));
        global.fetch = fetchMock as unknown as typeof fetch;

        render(<EventModal occurrence={makeOccurrence()} onClose={() => {}} />);
        fireEvent.click(screen.getByRole("button", { name: /delete event/i }));

        // The first click only reveals the prompt: an irreversible action must
        // not be one stray click away.
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${MANAGE}/events/${EVENT_ID}`);
        expect(init.method).toBe("DELETE");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-token");
    });

    it("can be cancelled without deleting", () => {
        seedSession();
        const fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;

        render(<EventModal occurrence={makeOccurrence()} onClose={() => {}} />);
        fireEvent.click(screen.getByRole("button", { name: /delete event/i }));
        fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: /delete event/i })).toBeInTheDocument();
    });

    it("closes the modal and refreshes after a successful delete", async () => {
        seedSession();
        global.fetch = jest.fn(async () => jsonResponse({ deleted: EVENT_ID })) as unknown as typeof fetch;
        const onClose = jest.fn();
        const onDeleted = jest.fn();

        render(<EventModal occurrence={makeOccurrence()} onClose={onClose} onDeleted={onDeleted} />);
        fireEvent.click(screen.getByRole("button", { name: /delete event/i }));
        fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));

        await waitFor(() => expect(onDeleted).toHaveBeenCalled());
        expect(onClose).toHaveBeenCalled();
    });

    it("warns that a recurring event is deleted in full", () => {
        seedSession();
        render(
            <EventModal
                occurrence={makeOccurrence({ isRecurring: true, recurrenceRule: "FREQ=WEEKLY;BYDAY=WE" })}
                onClose={() => {}}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /delete event/i }));
        // One Discord record backs every occurrence, so deleting removes the
        // series -- the prompt has to say so.
        expect(screen.getByText(/every occurrence/i)).toBeInTheDocument();
    });

    it("surfaces a refusal instead of silently failing", async () => {
        seedSession();
        global.fetch = jest.fn(async () =>
            jsonResponse(
                {
                    error: "Only officers can remove events.",
                    reason: "missing-role",
                    member: true,
                    canCreateEvents: false,
                },
                403,
            ),
        ) as unknown as typeof fetch;

        render(<EventModal occurrence={makeOccurrence()} onClose={() => {}} />);
        fireEvent.click(screen.getByRole("button", { name: /delete event/i }));
        fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/officer role/i);
    });

    it("clears a pending confirmation when a different event opens", async () => {
        seedSession();
        const { rerender } = render(<EventModal occurrence={makeOccurrence()} onClose={() => {}} />);
        fireEvent.click(screen.getByRole("button", { name: /delete event/i }));
        expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();

        // Switching events must not carry the armed confirmation across --
        // otherwise the next click would delete the newly opened event.
        rerender(<EventModal occurrence={makeOccurrence({ id: "1340000000000000002" })} onClose={() => {}} />);
        expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /delete event/i })).toBeInTheDocument();
    });
});
