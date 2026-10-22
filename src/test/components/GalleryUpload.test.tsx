import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import GalleryUpload from "../../components/GalleryUpload";

/**
 * Tests for the gallery's officer panel, focused on the two list features:
 * drag-to-reorder and hide/restore.
 *
 * WHY THE DRAG TESTS DRIVE EVENTS BY HAND, AND WHAT THEY CANNOT CATCH.
 * jsdom has no drag implementation, so `fireEvent.dragStart` / `dragOver` /
 * `drop` is the only option. It still dispatches the handlers, so these tests
 * DO catch a broken drop handler (removing the `moveTo` call fails three of
 * them). But they do NOT catch a missing `draggable` attribute: `fireEvent`
 * synthesizes the event regardless, so the row would be un-draggable in a real
 * browser while every test here stayed green. Verified by probe -- do not trust
 * this file for that. The interactive behaviour needs a real browser check.
 */

const SESSION_KEY = "autoboat.calendar.session";

/** The Drive ids the panel will show, in the order the Worker returns them. */
const PHOTOS = [
    { id: "alpha", name: "alpha.jpg", width: null, height: null, modifiedTime: null },
    { id: "bravo", name: "bravo.jpg", width: null, height: null, modifiedTime: null },
    { id: "charlie", name: "charlie.jpg", width: null, height: null, modifiedTime: null },
];

/**
 * Sign a session into localStorage so the panel opens straight into officer mode.
 *
 * NOTE: The token is a literal, not a real signed one. jsdom does not implement
 * `crypto.subtle`, so `createSession` cannot run here at all -- and the panel
 * only ever stores the token and echoes it in an `Authorization` header, so the
 * signature is irrelevant to what these tests assert. Signature verification is
 * covered where it belongs: `src/test/worker/session.test.ts` and the route
 * tests, which run in the node environment.
 */
function seedSession() {
    globalThis.localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
            token: "test-token",
            name: "Officer",
            expiresAt: Date.now() + 600_000,
        }),
    );
}

/** Route fetch by URL so one stub can serve the order list and the save. */
function mockApi(options: { saveOk?: boolean; onSave?: (body: unknown) => void } = {}) {
    const fn = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/manage/gallery/order") && method === "GET") {
            return { ok: true, status: 200, json: async () => ({ images: PHOTOS }) };
        }
        if (url.endsWith("/manage/gallery/order") && method === "PUT") {
            options.onSave?.(JSON.parse(String(init?.body)));
            if (options.saveOk === false) {
                return { ok: false, status: 500, json: async () => ({ error: "Nope." }) };
            }
            return { ok: true, status: 200, json: async () => ({ ids: [], count: 0 }) };
        }
        if (url.endsWith("/manage/gallery/hidden")) {
            return { ok: true, status: 200, json: async () => ({ images: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
}

/**
 * Open the panel and wait for the order list to have loaded.
 *
 * WARNING: Waiting on the "Photo order" heading is NOT enough -- the section renders as
 * soon as the panel opens (`photos.length < 2` only hides it once the fetch has
 * resolved with a short list), so a heading-based wait races the fetch and the
 * assertions read an empty list. Wait for the ROWS.
 */
async function openPanel() {
    render(<GalleryUpload />);
    fireEvent.click(screen.getByRole("button", { name: /add photos|officer sign-in/i }));
    await waitFor(() => {
        expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
    });
    return screen.getAllByRole("listitem");
}

/** The row's filename, for asserting order. */
function nameOf(row: HTMLElement): string {
    return within(row).getByText(/\.jpg/).textContent ?? "";
}

/** Drag `from` onto `to`, the way the handlers expect. */
function drag(from: HTMLElement, to: HTMLElement) {
    // A DataTransfer stub: jsdom does not provide one, and the handlers read
    // `effectAllowed`/`dropEffect` from it.
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: jest.fn(), getData: jest.fn() };

    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
    fireEvent.dragEnd(from, { dataTransfer });
}

describe("GalleryUpload reorder", () => {
    beforeEach(() => {
        globalThis.localStorage.clear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("shows the photos in the Worker's order", async () => {
        seedSession();
        mockApi();
        const rows = await openPanel();

        expect(rows.map(nameOf)).toEqual(["1. alpha.jpg", "2. bravo.jpg", "3. charlie.jpg"]);
    });

    it("saves the WHOLE order after a drag", async () => {
        // The server is sent an assertion, not a move -- so the payload must be
        // the complete sequence, not a (from, to) pair.
        seedSession();
        const onSave = jest.fn();
        mockApi({ onSave });
        const rows = await openPanel();

        drag(rows[0] as HTMLElement, rows[2] as HTMLElement);

        await waitFor(() => {
            expect(onSave).toHaveBeenCalledWith({ ids: ["bravo", "charlie", "alpha"] });
        });
    });

    it("reorders the list after a drag", async () => {
        seedSession();
        mockApi();
        await openPanel();

        const before = screen.getAllByRole("listitem");
        drag(before[0] as HTMLElement, before[2] as HTMLElement);

        await waitFor(() => {
            const after = screen.getAllByRole("listitem");
            expect(after.map(nameOf)).toEqual(["1. bravo.jpg", "2. charlie.jpg", "3. alpha.jpg"]);
        });
    });

    it("does not save when a row is dropped on itself", async () => {
        seedSession();
        const onSave = jest.fn();
        mockApi({ onSave });
        const rows = await openPanel();

        drag(rows[1] as HTMLElement, rows[1] as HTMLElement);

        // Give the microtask queue a turn before asserting a negative.
        await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
        expect(onSave).not.toHaveBeenCalled();
    });

    it("rolls back when the save fails", async () => {
        // The move must not appear to have worked if it was not stored, or the
        // page and the panel disagree until the next refresh.
        seedSession();
        mockApi({ saveOk: false });
        const rows = await openPanel();

        drag(rows[0] as HTMLElement, rows[2] as HTMLElement);

        await waitFor(() => {
            expect(screen.getByRole("alert")).toHaveTextContent(/nope/i);
        });
        expect(screen.getAllByRole("listitem").map(nameOf)).toEqual(["1. alpha.jpg", "2. bravo.jpg", "3. charlie.jpg"]);
    });

    it("marks the hovered row as a drop target", async () => {
        // Without a visible indicator, drag-to-reorder is guesswork.
        seedSession();
        mockApi();
        const rows = await openPanel();

        fireEvent.dragStart(rows[0] as HTMLElement, {
            dataTransfer: { effectAllowed: "", dropEffect: "", setData: jest.fn(), getData: jest.fn() },
        });
        fireEvent.dragOver(rows[2] as HTMLElement, {
            dataTransfer: { effectAllowed: "", dropEffect: "", setData: jest.fn(), getData: jest.fn() },
        });

        expect(rows[2]?.className).toContain("is-drop-target");
        // The dragged row is marked too, so the list does not look frozen.
        expect(rows[0]?.className).toContain("is-dragging");
    });

    it("clears the drag state when the drag ends without a drop", async () => {
        // Escape, or dropping outside the list. A stuck highlight would make the
        // list look broken.
        seedSession();
        mockApi();
        const rows = await openPanel();

        fireEvent.dragStart(rows[0] as HTMLElement, {
            dataTransfer: { effectAllowed: "", dropEffect: "", setData: jest.fn(), getData: jest.fn() },
        });
        fireEvent.dragEnd(rows[0] as HTMLElement, {
            dataTransfer: { effectAllowed: "", dropEffect: "", setData: jest.fn(), getData: jest.fn() },
        });

        expect(rows[0]?.className).not.toContain("is-dragging");
    });

    it("keeps the arrow buttons as the keyboard and touch path", async () => {
        // HTML5 drag does not fire on touch devices, and a draggable <li> is not
        // focusable, so removing these would make the feature unusable on a
        // phone and by keyboard.
        seedSession();
        const onSave = jest.fn();
        mockApi({ onSave });
        await openPanel();

        fireEvent.click(screen.getByRole("button", { name: /move charlie\.jpg earlier/i }));

        await waitFor(() => {
            expect(onSave).toHaveBeenCalledWith({ ids: ["alpha", "charlie", "bravo"] });
        });
    });

    it("hides the reorder list when there is nothing to reorder", async () => {
        seedSession();
        globalThis.fetch = jest.fn().mockImplementation(async (url: string) => {
            if (url.endsWith("/manage/gallery/order")) {
                return { ok: true, status: 200, json: async () => ({ images: [PHOTOS[0]] }) };
            }
            return { ok: true, status: 200, json: async () => ({ images: [] }) };
        }) as unknown as typeof fetch;

        render(<GalleryUpload />);
        fireEvent.click(screen.getByRole("button", { name: /add photos/i }));

        await waitFor(() => {
            expect(screen.queryByRole("heading", { name: /photo order/i })).not.toBeInTheDocument();
        });
    });
});
