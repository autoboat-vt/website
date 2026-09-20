import { afterEach } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CalendarSubscribe from "../../components/CalendarSubscribe";
import { EVENTS_ICS_URL, googleCalendarSubscribeUrl, outlookSubscribeUrl, webcalUrl } from "../../lib/discord";

/**
 * Tests for the calendar "Subscribe" control. Verifies the panel is closed
 * by default, that each calendar provider gets the right URL, and that the
 * copy button works with and without the async Clipboard API.
 */

const realClipboard = navigator.clipboard;

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
        value: realClipboard,
        configurable: true,
        writable: true,
    });
});

function setClipboard(value: unknown) {
    Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}

describe("CalendarSubscribe", () => {
    it("hides the provider links until the toggle is clicked", () => {
        render(<CalendarSubscribe />);
        expect(screen.getByRole("button", { name: /Subscribe/i })).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText(/Add the AutoBoat calendar/i)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));
        expect(screen.getByRole("button", { name: /Subscribe/i })).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText(/Add the AutoBoat calendar/i)).toBeInTheDocument();
    });

    it("collapses the panel when the toggle is clicked again", () => {
        render(<CalendarSubscribe />);
        const toggle = screen.getByRole("button", { name: /Subscribe/i });
        fireEvent.click(toggle);
        expect(screen.getByText(/Add the AutoBoat calendar/i)).toBeInTheDocument();
        fireEvent.click(toggle);
        expect(screen.queryByText(/Add the AutoBoat calendar/i)).not.toBeInTheDocument();
    });

    it("links the OS-calendar button to the webcals:// URL", () => {
        render(<CalendarSubscribe />);
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));
        expect(screen.getByTestId("subscribe-webcal")).toHaveAttribute("href", webcalUrl());
        expect(webcalUrl().startsWith("webcals://")).toBe(true);
    });

    it("links Google and Outlook to their add-by-URL endpoints", () => {
        render(<CalendarSubscribe />);
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));

        const google = screen.getByRole("link", { name: /Google Calendar/i });
        expect(google).toHaveAttribute("href", googleCalendarSubscribeUrl());
        expect(google).toHaveAttribute("target", "_blank");
        expect(google).toHaveAttribute("rel", "noopener noreferrer");

        const outlook = screen.getByRole("link", { name: /Outlook Web/i });
        expect(outlook).toHaveAttribute("href", outlookSubscribeUrl());
    });

    it("copies the feed URL when the Google link is clicked", async () => {
        // Google's Add-by-URL dialog can't be pre-filled, so the link copies
        // the feed URL on the way out and the user pastes it on the next page.
        const writeText = jest.fn(() => Promise.resolve());
        setClipboard({ writeText });
        render(<CalendarSubscribe />);
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));

        fireEvent.click(screen.getByRole("link", { name: /Google Calendar/i }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(EVENTS_ICS_URL));
    });

    it("offers the raw .ics feed as a direct download", () => {
        render(<CalendarSubscribe />);
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));
        const download = screen.getByRole("link", { name: /Download .ics/i });
        expect(download).toHaveAttribute("href", EVENTS_ICS_URL);
        expect(download).toHaveAttribute("download", "autoboat.ics");
    });

    it("shows the feed URL so it can be copied by hand", () => {
        render(<CalendarSubscribe />);
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));
        expect(screen.getByText(EVENTS_ICS_URL)).toBeInTheDocument();
    });

    it("copies the feed URL via the async Clipboard API", async () => {
        const writeText = jest.fn(() => Promise.resolve());
        setClipboard({ writeText });
        render(<CalendarSubscribe />);
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));

        fireEvent.click(screen.getByRole("button", { name: "Copy feed URL" }));
        await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
        expect(writeText).toHaveBeenCalledWith(EVENTS_ICS_URL);
    });

    it("falls back to execCommand when the Clipboard API is unavailable", async () => {
        // Insecure origins and jsdom have no navigator.clipboard.
        setClipboard(undefined);
        const execCommand = jest.fn(() => true);
        Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });

        render(<CalendarSubscribe />);
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));
        fireEvent.click(screen.getByRole("button", { name: "Copy feed URL" }));

        await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
        expect(screen.getByText("Copied")).toBeInTheDocument();
    });

    it("stays usable when the clipboard write is rejected", async () => {
        const writeText = jest.fn(() => Promise.reject(new Error("denied")));
        setClipboard({ writeText });
        render(<CalendarSubscribe />);
        fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }));
        fireEvent.click(screen.getByRole("button", { name: "Copy feed URL" }));

        await waitFor(() => expect(writeText).toHaveBeenCalled());
        // No "Copied" confirmation, and the panel is still rendered.
        expect(screen.queryByText("Copied")).not.toBeInTheDocument();
        expect(screen.getByText(EVENTS_ICS_URL)).toBeInTheDocument();
    });
});
