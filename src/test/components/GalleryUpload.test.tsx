import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GalleryUpload from "../../components/GalleryUpload";

/**
 * Tests for the gallery's officer panel.
 *
 * SCOPE. The panel does two things now: upload a photo, and restore a removed
 * one. Reordering moved out of the panel and onto the grid (drag a photo), so
 * there are no reorder tests here -- see `src/test/pages/Gallery.test.tsx` and
 * `src/test/lib/galleryView.test.ts`.
 *
 * NOTE: the session token is a literal, not a real signed one. jsdom has no
 * `crypto.subtle`, so `createSession` cannot run here at all, and the panel only
 * stores the token and echoes it in an `Authorization` header -- the signature is
 * irrelevant to what these assert. Verification is covered in
 * `src/test/worker/session.test.ts`.
 */

const SESSION_KEY = "autoboat.calendar.session";

function signIn() {
    globalThis.localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ token: "test-token", name: "Officer", expiresAt: Date.now() + 600_000 }),
    );
}

/** Route fetch by URL so one stub can serve both officer lists. */
function mockApi(options: { hidden?: { id: string; name: string }[]; onRestore?: (id: string) => void } = {}) {
    const fn = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/manage/gallery/hidden")) {
            return { ok: true, status: 200, json: async () => ({ images: options.hidden ?? [] }) };
        }
        if (url.includes("/manage/gallery/") && (init?.method ?? "GET") === "PATCH") {
            const id = url.split("/").pop() ?? "";
            options.onRestore?.(id);
            return { ok: true, status: 200, json: async () => ({ id, hidden: false }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
}

/** Open the panel. */
function openPanel() {
    render(<GalleryUpload />);
    fireEvent.click(screen.getByRole("button", { name: /add photos|officer sign-in/i }));
}

describe("GalleryUpload", () => {
    beforeEach(() => {
        globalThis.localStorage.clear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("offers sign-in when signed out", () => {
        mockApi();
        openPanel();

        // Rendered for everyone -- the Worker is the gate, and hiding it would
        // leave an officer unable to discover the feature.
        expect(screen.getByRole("button", { name: /sign in with discord/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /choose a photo/i })).not.toBeInTheDocument();
    });

    it("offers upload controls once signed in", () => {
        signIn();
        mockApi();
        openPanel();

        expect(screen.getByRole("button", { name: /choose a photo/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    });

    it("does not offer reordering in the panel any more", () => {
        // Reordering moved onto the grid. Leaving a second control here would be
        // two places to do one thing.
        signIn();
        mockApi();
        openPanel();

        expect(screen.queryByRole("heading", { name: /photo order/i })).not.toBeInTheDocument();
    });

    it("rejects an oversized file before uploading it", async () => {
        // Checked locally so a phone does not spend a minute uploading something
        // the Worker will refuse.
        signIn();
        mockApi();
        openPanel();

        const input = document.querySelector("input[type=file]") as HTMLInputElement;
        const big = new File(["x"], "big.jpg", { type: "image/jpeg" });
        // `size` is read-only on a File, so it is stubbed for this assertion.
        Object.defineProperty(big, "size", { value: 99_000_000 });
        fireEvent.change(input, { target: { files: [big] } });

        await waitFor(() => {
            expect(screen.getByRole("alert")).toHaveTextContent(/too large/i);
        });
        // No UPLOAD was attempted. The panel may still have fetched the removed
        // list, so the assertion is about the POST specifically.
        const posted = (globalThis.fetch as jest.Mock).mock.calls.some(
            ([url, init]) =>
                String(url).endsWith("/manage/gallery") && (init as RequestInit | undefined)?.method === "POST",
        );
        expect(posted).toBe(false);
    });

    it("lists removed photos and restores one", async () => {
        // The removal is reversible only if this list exists.
        signIn();
        const restored: string[] = [];
        mockApi({ hidden: [{ id: "photo-one", name: "one.jpg" }], onRestore: (id) => restored.push(id) });
        openPanel();

        await waitFor(() => {
            expect(screen.getByRole("heading", { name: /removed from the gallery/i })).toBeInTheDocument();
        });
        fireEvent.click(screen.getByRole("button", { name: /restore/i }));

        await waitFor(() => {
            expect(restored).toEqual(["photo-one"]);
        });
    });

    it("does not show an empty removed list", async () => {
        // An always-present empty section would be noise.
        signIn();
        mockApi({ hidden: [] });
        openPanel();

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /choose a photo/i })).toBeInTheDocument();
        });
        expect(screen.queryByRole("heading", { name: /removed from the gallery/i })).not.toBeInTheDocument();
    });

    it("explains that removed photos are not deleted", async () => {
        // The single most important piece of copy in this panel.
        signIn();
        mockApi({ hidden: [{ id: "photo-one", name: "one.jpg" }] });
        openPanel();

        await waitFor(() => {
            expect(screen.getByText(/not deleted from drive/i)).toBeInTheDocument();
        });
    });
    it("clears the session on sign out", async () => {
        signIn();
        mockApi();
        openPanel();

        fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

        await waitFor(() => {
            expect(globalThis.localStorage.getItem(SESSION_KEY)).toBeNull();
        });
    });
});
