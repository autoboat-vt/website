/**
 * Tests for the officer "add event" control.
 *
 * The Worker is the security boundary (see src/test/worker/eventCreate.routes.test.ts);
 * these tests cover what the UI owes the user: the login affordance, the
 * officer-only message when Discord refuses, and a successful create resetting
 * the form so a second event does not inherit the first one's values.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import EventCreator from "../../components/EventCreator";
import { beginLogin, MANAGE_URL } from "../../lib/eventManage";

const SESSION_KEY = "autoboat.calendar.session";
// Derived from the module rather than hardcoded: the Worker base URL comes from
// `globalThis.__VITE_EVENTS_URL__` (a Vite `define`), so a literal here would
// silently stop matching if the placeholder default ever changes.
const MANAGE = MANAGE_URL;

/** Seed a valid stored session so the component starts signed in. */
function seedSession(overrides: { token?: string; name?: string; expiresAt?: number } = {}) {
    localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
            token: overrides.token ?? "session-token",
            name: overrides.name ?? "Officer Ada",
            expiresAt: overrides.expiresAt ?? Date.now() + 60 * 60 * 1000,
        }),
    );
}

/** A Response-like object duck-typed enough for the client. */
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

describe("signed out", () => {
    it("offers Discord sign-in and explains the officer requirement", () => {
        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /officer sign-in/i }));
        expect(screen.getByRole("button", { name: /sign in with discord/i })).toBeInTheDocument();
        expect(screen.getByText(/only officers can create events/i)).toBeInTheDocument();
    });

    it("navigates to the URL the Worker returns", async () => {
        // jsdom's `location` is non-configurable and `location.assign` is
        // read-only, so navigation is exercised through `beginLogin`'s injected
        // navigator rather than by spying on the DOM.
        global.fetch = jest.fn(async () =>
            jsonResponse({ url: "https://discord.com/oauth2/authorize?client_id=x" }),
        ) as unknown as typeof fetch;
        const navigate = jest.fn();

        await beginLogin(navigate);

        expect(navigate).toHaveBeenCalledWith("https://discord.com/oauth2/authorize?client_id=x");
    });

    it("does not navigate when the Worker reports a misconfiguration", async () => {
        global.fetch = jest.fn(async () =>
            jsonResponse({ error: "Event creation is not configured." }, 503),
        ) as unknown as typeof fetch;
        const navigate = jest.fn();

        await expect(beginLogin(navigate)).rejects.toThrow(/not configured/i);
        expect(navigate).not.toHaveBeenCalled();
    });

    it("reports a misconfigured Worker instead of navigating", async () => {
        global.fetch = jest.fn(async () =>
            jsonResponse({ error: "Event creation is not configured." }, 503),
        ) as unknown as typeof fetch;

        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /officer sign-in/i }));
        fireEvent.click(screen.getByRole("button", { name: /sign in with discord/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/not configured/i);
    });
});

describe("signed in", () => {
    it("shows the add-event form", () => {
        seedSession();
        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        expect(screen.getByRole("heading", { name: /add an event as officer ada/i })).toBeInTheDocument();
        expect(screen.getByLabelText(/event name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/^starts$/i)).toBeInTheDocument();
    });

    it("creates an event and calls onCreated", async () => {
        seedSession();
        const fetchMock = jest.fn(async () =>
            jsonResponse(
                {
                    event: { id: "e1", name: "Meeting", start: "2026-11-05T19:00:00.000Z", audience: "public" },
                    officerOnly: false,
                },
                201,
            ),
        );
        global.fetch = fetchMock as unknown as typeof fetch;
        const onCreated = jest.fn();

        render(<EventCreator onCreated={onCreated} />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.change(screen.getByLabelText(/event name/i), { target: { value: "Meeting" } });
        fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: "2026-11-05T19:00" } });
        fireEvent.click(screen.getByRole("button", { name: /create event/i }));

        expect(await screen.findByRole("status")).toHaveTextContent(/created "meeting"/i);
        expect(onCreated).toHaveBeenCalled();

        // Sent to the Worker with the bearer token and an ISO instant.
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${MANAGE}/events`);
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-token");
        const sent = JSON.parse(init.body as string);
        expect(sent.name).toBe("Meeting");
        // datetime-local is local time; the payload must be a UTC instant.
        expect(sent.start).toMatch(/Z$/);
    });

    it("resets the name after a successful create", async () => {
        seedSession();
        global.fetch = jest.fn(async () =>
            jsonResponse(
                { event: { id: "e1", name: "Meeting", start: "", audience: "public" }, officerOnly: false },
                201,
            ),
        ) as unknown as typeof fetch;

        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.change(screen.getByLabelText(/event name/i), { target: { value: "Meeting" } });
        fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: "2026-11-05T19:00" } });
        fireEvent.click(screen.getByRole("button", { name: /create event/i }));

        await screen.findByRole("status");
        expect(screen.getByLabelText(/event name/i)).toHaveValue("");
    });

    it("warns when the officer channel is selected", () => {
        seedSession();
        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.change(screen.getByLabelText(/discord channel/i), {
            target: { value: "1550594891766308997" },
        });
        expect(screen.getByText(/hidden from the public calendar/i)).toBeInTheDocument();
    });

    it("requires a location and shows the external-event hint", () => {
        seedSession();
        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.click(screen.getByLabelText(/not in a discord voice channel/i));
        expect(screen.getByLabelText(/^location$/i)).toBeInTheDocument();
        expect(screen.queryByLabelText(/discord channel/i)).not.toBeInTheDocument();
        expect(screen.getByText(/needs a location and an end time/i)).toBeInTheDocument();
    });

    it("reports an expired session as a sign-in prompt", async () => {
        seedSession();
        // 401 means the token is dead: the UI must drop it rather than retry.
        global.fetch = jest.fn(async () => jsonResponse({ error: "expired token" }, 401)) as unknown as typeof fetch;

        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.change(screen.getByLabelText(/event name/i), { target: { value: "Meeting" } });
        fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: "2026-11-05T19:00" } });
        fireEvent.click(screen.getByRole("button", { name: /create event/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/expired token/i);
        // Back to the signed-out affordance.
        expect(screen.getByRole("button", { name: /sign in with discord/i })).toBeInTheDocument();
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it("explains a missing role differently from a missing membership", async () => {
        seedSession();
        global.fetch = jest.fn(async () =>
            jsonResponse({ error: "You are not a member.", member: false }, 403),
        ) as unknown as typeof fetch;

        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.change(screen.getByLabelText(/event name/i), { target: { value: "Meeting" } });
        fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: "2026-11-05T19:00" } });
        fireEvent.click(screen.getByRole("button", { name: /create event/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/not in the team's discord server/i);
    });

    it("surfaces Discord's field error verbatim", async () => {
        seedSession();
        global.fetch = jest.fn(async () =>
            jsonResponse({ error: "Invalid Form Body" }, 400),
        ) as unknown as typeof fetch;

        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.change(screen.getByLabelText(/event name/i), { target: { value: "Meeting" } });
        fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: "2026-11-05T19:00" } });
        fireEvent.click(screen.getByRole("button", { name: /create event/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Invalid Form Body");
    });

    it("refuses to submit without a start time", async () => {
        seedSession();
        const fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;

        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.change(screen.getByLabelText(/event name/i), { target: { value: "Meeting" } });
        // Submit the form directly; the input's own `required` blocks a click.
        fireEvent.submit(screen.getByRole("button", { name: /create event/i }).closest("form") as HTMLFormElement);

        expect(await screen.findByRole("alert")).toHaveTextContent(/pick a start date and time/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("signs out locally", () => {
        seedSession();
        render(<EventCreator />);
        fireEvent.click(screen.getByRole("button", { name: /add event/i }));
        fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        expect(screen.getByRole("button", { name: /officer sign-in/i })).toBeInTheDocument();
    });
});

describe("session restoration", () => {
    it("starts signed in when a stored session is still valid", () => {
        seedSession({ name: "Officer Grace" });
        render(<EventCreator />);
        // The toggle label reflects the session.
        expect(screen.getByRole("button", { name: /add event/i })).toBeInTheDocument();
    });

    it("ignores and clears an expired stored session", () => {
        seedSession({ expiresAt: Date.now() - 1000 });
        render(<EventCreator />);
        expect(screen.getByRole("button", { name: /officer sign-in/i })).toBeInTheDocument();
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it("survives corrupt stored JSON", () => {
        localStorage.setItem(SESSION_KEY, "{not json");
        render(<EventCreator />);
        expect(screen.getByRole("button", { name: /officer sign-in/i })).toBeInTheDocument();
    });
});
