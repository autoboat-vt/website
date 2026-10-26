import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { EVENTS_URL } from "../../lib/discord";
import { ALL_GALLERY_IMAGES } from "../../lib/galleryImages";
import Gallery from "../../pages/Gallery";

/**
 * Tests for the Gallery page.
 *
 * The page merges two sources, so the assertions are about the MERGE and about
 * degradation: the curated photos are part of the build and must render even
 * when the Drive request fails, because a Worker problem must not blank a page
 * whose content is mostly static.
 *
 * `fetch` is stubbed because the page loads the manifest on mount; without it
 * jsdom has no server to talk to.
 */

const MANIFEST_URL = `${EVENTS_URL}/gallery`;
const curatedCount = ALL_GALLERY_IMAGES.length;

/**
 * Render the page inside a router with the SAME route shape `App.tsx` uses.
 *
 * WHY THIS SHADOWS `render`: the page reads `useParams` (the photo id in
 * `/gallery/:photoId`) and `useNavigate`, both of which need a router context.
 * `MemoryRouter` alone is not enough -- `useParams` only resolves inside a
 * matched `<Route>`, so the real route pattern is registered here. Wrapping in
 * one place keeps every existing assertion untouched, and `route` is how a test
 * exercises a shared per-photo link.
 */
function render(ui: React.ReactElement, options?: { route?: string }) {
    return rtlRender(
        <MemoryRouter initialEntries={[options?.route ?? "/gallery"]}>
            <Routes>
                <Route path="/gallery" element={ui} />
                <Route path="/gallery/:photoId" element={ui} />
            </Routes>
        </MemoryRouter>,
    );
}

/** Stub fetch to answer the manifest request with `body`. */
function mockManifest(body: unknown, ok = true) {
    const fn = jest.fn().mockResolvedValue({
        ok,
        status: ok ? 200 : 503,
        json: async () => body,
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
}

/** Fail the request the way a CORS block or an outage would. */
function mockFetchRejection(err: Error) {
    globalThis.fetch = jest.fn().mockRejectedValue(err) as unknown as typeof fetch;
}

describe("Gallery page", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("renders every curated image when Drive has none", async () => {
        // The curated set is a complete gallery on its own.
        mockManifest({ syncedAt: null, images: [], pending: 0, warning: null });
        const { container } = render(<Gallery />);

        await waitFor(() => {
            expect(container.querySelectorAll(".photo-container img")).toHaveLength(curatedCount);
        });
    });

    it("adds the Drive images to the grid", async () => {
        mockManifest({
            syncedAt: Date.now(),
            images: [
                { id: "abc", name: "regatta.jpg", width: null, height: null, modifiedTime: null },
                { id: "def", name: "build_night.jpg", width: null, height: null, modifiedTime: null },
            ],
            pending: 0,
            warning: null,
        });
        const { container } = render(<Gallery />);

        await waitFor(() => {
            expect(container.querySelectorAll(".photo-container img")).toHaveLength(curatedCount + 2);
        });
    });

    it("loads Drive images from the Worker, not from Drive", async () => {
        // Drive URLs are rate-limited and rotate; the page must never build one.
        mockManifest({
            syncedAt: Date.now(),
            images: [{ id: "abc", name: "a.jpg", width: null, height: null, modifiedTime: null }],
            pending: 0,
            warning: null,
        });
        const { container } = render(<Gallery />);

        await waitFor(() => {
            const srcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
            expect(srcs).toContain(`${MANIFEST_URL}/image/abc`);
            expect(srcs.some((src) => src?.includes("googleusercontent"))).toBe(false);
        });
    });

    it("shows the curated photos and a note when the manifest request fails", async () => {
        // A Drive outage must degrade, not blank the page.
        mockFetchRejection(new TypeError("NetworkError"));
        const { container } = render(<Gallery />);

        await waitFor(() => {
            expect(container.querySelectorAll(".photo-container img")).toHaveLength(curatedCount);
        });
        expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    });

    it("says how many photos are still being added", async () => {
        mockManifest({
            syncedAt: Date.now(),
            images: [{ id: "abc", name: "a.jpg", width: null, height: null, modifiedTime: null }],
            pending: 3,
            warning: null,
        });
        render(<Gallery />);

        await waitFor(() => {
            expect(screen.getByText(/3 more photos are/)).toBeInTheDocument();
        });
    });

    it("renders a captioned subteam photo so its caption reaches the lightbox", async () => {
        mockManifest({ syncedAt: null, images: [], pending: 0, warning: null });
        render(<Gallery />);

        expect(screen.getByAltText("Computer Vision System")).toBeInTheDocument();
    });

    it("offers the officer sign-in control", async () => {
        mockManifest({ syncedAt: null, images: [], pending: 0, warning: null });
        render(<Gallery />);

        // Rendered for everyone -- the Worker is the gate, and hiding it would
        // leave an officer unable to discover the feature.
        expect(screen.getByRole("button", { name: /officer sign-in|add photos/i })).toBeInTheDocument();
    });
});

/**
 * Drag-to-reorder, directly on the grid.
 *
 * NOTE ON WHAT THESE CAN VERIFY. jsdom has no drag implementation, so the events
 * are synthesized. Removing the `draggable` attribute does NOT fail these tests
 * (`fireEvent` dispatches regardless) -- verified by probe -- so a real browser
 * is still the only way to confirm a tile is actually draggable. What IS caught
 * here is the handler wiring and the request payload, which is where the silent
 * bugs live.
 */
describe("Gallery page drag to reorder", () => {
    const MANIFEST = {
        syncedAt: Date.now(),
        images: [
            { id: "alpha", name: "alpha.jpg", width: null, height: null, modifiedTime: null },
            { id: "bravo", name: "bravo.jpg", width: null, height: null, modifiedTime: null },
            { id: "charlie", name: "charlie.jpg", width: null, height: null, modifiedTime: null },
        ],
        pending: 0,
        warning: null,
    };

    /** Grid tiles, in render order. The curated photos follow the Drive ones. */
    function tiles(container: HTMLElement): HTMLElement[] {
        return Array.from(container.querySelectorAll(".photo-container > button")) as HTMLElement[];
    }

    /** Names of the first `count` tiles, by alt text. */
    function firstAlts(container: HTMLElement, count: number): (string | null)[] {
        return tiles(container)
            .slice(0, count)
            .map((tile) => tile.querySelector("img")?.getAttribute("alt") ?? null);
    }

    function drag(from: HTMLElement, to: HTMLElement) {
        const dataTransfer = { effectAllowed: "", dropEffect: "", setData: jest.fn(), getData: jest.fn() };
        fireEvent.dragStart(from, { dataTransfer });
        fireEvent.dragOver(to, { dataTransfer });
        fireEvent.drop(to, { dataTransfer });
        fireEvent.dragEnd(from, { dataTransfer });
    }

    /** Serve the manifest and record any order writes. */
    function mockWithOrder(writes: unknown[] = [], saveOk = true) {
        const fn = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/manage/gallery/order") && init?.method === "PUT") {
                writes.push(JSON.parse(String(init.body)));
                if (!saveOk) return { ok: false, status: 500, json: async () => ({ error: "Nope." }) };
                return { ok: true, status: 200, json: async () => ({ ids: [], count: 0 }) };
            }
            return { ok: true, status: 200, json: async () => MANIFEST };
        });
        globalThis.fetch = fn as unknown as typeof fetch;
        return fn;
    }

    function signIn() {
        globalThis.localStorage.setItem(
            "autoboat.calendar.session",
            JSON.stringify({ token: "test-token", name: "Officer", expiresAt: Date.now() + 600_000 }),
        );
    }

    afterEach(() => {
        jest.restoreAllMocks();
        globalThis.localStorage?.clear();
    });

    it("does not make tiles draggable for a visitor", async () => {
        // A visitor has nothing to save to, and a tile that lifts on drag but
        // snaps back reads as broken.
        mockWithOrder();
        const { container } = render(<Gallery />);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThan(0));
        expect(tiles(container)[0]?.getAttribute("draggable")).toBe("false");
        // And no reorder hint.
        expect(screen.queryByText(/drag a photo to reorder/i)).not.toBeInTheDocument();
    });

    it("makes the Drive tiles draggable for an officer, with a hint", async () => {
        signIn();
        mockWithOrder();
        const { container } = render(<Gallery />);

        await waitFor(() => {
            expect(screen.getByText(/drag a photo to reorder/i)).toBeInTheDocument();
        });
        expect(tiles(container)[0]?.getAttribute("draggable")).toBe("true");
    });

    it("makes the curated tiles draggable too, for an officer", async () => {
        // THE BUG THIS GUARDS: an earlier version only made DRIVE tiles draggable,
        // because the saved order was a list of Drive ids. The curated photos had
        // no id, so "some images can't be reordered". Ordering is keyed now.
        signIn();
        mockWithOrder();
        const { container } = render(<Gallery />);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThan(3));
        const curatedTile = tiles(container)[3];
        expect(curatedTile?.getAttribute("draggable")).toBe("true");
    });

    it("saves the whole order after dragging one photo onto another", async () => {
        signIn();
        const writes: unknown[] = [];
        mockWithOrder(writes);
        const { container } = render(<Gallery />);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThanOrEqual(3));
        const [first, , third] = tiles(container) as [HTMLElement, HTMLElement, HTMLElement];
        drag(first, third);

        await waitFor(() => {
            expect(writes).toHaveLength(1);
        });
        // alpha moved to position 3, and the payload is TILE KEYS -- which is what
        // lets curated photos appear in the same sequence.
        const sent = writes[0] as { keys: string[] };
        expect(sent.keys.slice(0, 3)).toEqual(["drive:bravo", "drive:charlie", "drive:alpha"]);
    });

    it("shows the new order immediately, before the refetch lands", async () => {
        // The save is optimistic; a snap-back-then-jump would look broken.
        signIn();
        mockWithOrder();
        const { container } = render(<Gallery />);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThanOrEqual(3));
        const [first, , third] = tiles(container) as [HTMLElement, HTMLElement, HTMLElement];
        drag(first, third);

        await waitFor(() => {
            expect(firstAlts(container, 3)).toEqual(["bravo", "charlie", "alpha"]);
        });
    });

    it("reports a failed save and restores the stored order", async () => {
        signIn();
        mockWithOrder([], false);
        const { container } = render(<Gallery />);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThanOrEqual(3));
        const [first, , third] = tiles(container) as [HTMLElement, HTMLElement, HTMLElement];
        drag(first, third);

        await waitFor(() => {
            expect(screen.getByRole("alert")).toHaveTextContent(/nope/i);
        });
        expect(firstAlts(container, 3)).toEqual(["alpha", "bravo", "charlie"]);
    });

    it("does not save when a tile is dropped on itself", async () => {
        signIn();
        const writes: unknown[] = [];
        mockWithOrder(writes);
        const { container } = render(<Gallery />);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThanOrEqual(3));
        const first = tiles(container)[0] as HTMLElement;
        drag(first, first);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThanOrEqual(3));
        expect(writes).toHaveLength(0);
    });

    it("does not open the lightbox after a drag", async () => {
        // A `drop` is usually followed by a `click` in some browsers, which
        // would pop the photo the officer just moved.
        signIn();
        mockWithOrder();
        const { container } = render(<Gallery />);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThanOrEqual(3));
        const [first, , third] = tiles(container) as [HTMLElement, HTMLElement, HTMLElement];
        drag(first, third);
        fireEvent.click(third);

        await waitFor(() => {
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    it("still opens the lightbox on a plain click", async () => {
        signIn();
        mockWithOrder();
        const { container } = render(<Gallery />);

        await waitFor(() => expect(tiles(container).length).toBeGreaterThan(0));
        fireEvent.click(tiles(container)[0] as HTMLElement);

        await waitFor(() => {
            expect(screen.getByRole("dialog")).toBeInTheDocument();
        });
    });
});

/**
 * Per-photo permalinks on the SITE's own domain (`/gallery/<photoId>`).
 *
 * WHAT THIS CAN AND CANNOT VERIFY. These assert the routing and rendering
 * contract: that a shared link opens the photo, that a stale link degrades to
 * the grid, and that the advertised share URL is the site domain rather than the
 * Worker origin. They cannot assert anything about S3, which is what actually
 * serves `/gallery/<id>` in production with a 404 status and the app shell as
 * the body -- see the WARNING in galleryClient.ts.
 */
describe("Gallery photo permalinks", () => {
    const MANIFEST = {
        syncedAt: Date.now(),
        images: [
            { id: "alpha", name: "alpha.jpg", width: null, height: null, modifiedTime: null },
            { id: "bravo", name: "bravo.jpg", width: null, height: null, modifiedTime: null },
        ],
        pending: 0,
        warning: null,
    };

    function mockManifest() {
        globalThis.fetch = jest
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => MANIFEST }) as unknown as typeof fetch;
    }

    afterEach(() => {
        jest.restoreAllMocks();
        globalThis.localStorage?.clear();
    });

    it("opens the photo named in the URL", async () => {
        // The whole point of the route: a shared link lands on the photo.
        mockManifest();
        render(<Gallery />, { route: "/gallery/bravo" });

        await waitFor(() => {
            expect(screen.getByRole("dialog")).toBeInTheDocument();
        });
        // The lightbox shows the bravo photo, not alpha.
        expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toContain("/image/bravo");
    });

    it("shows the plain grid for a photo that is no longer published", async () => {
        // A hidden or deleted photo must not leave a broken lightbox, and the
        // visitor should be told rather than silently seeing the grid.
        mockManifest();
        render(<Gallery />, { route: "/gallery/does-not-exist" });

        await waitFor(() => {
            expect(screen.getByText(/no longer in the gallery/i)).toBeInTheDocument();
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows no missing-photo note while the manifest is still loading", async () => {
        // Before the fetch resolves, EVERY id looks missing. Flashing the note
        // would be a false alarm on every shared link.
        let resolve: ((value: unknown) => void) | undefined;
        globalThis.fetch = jest.fn().mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        ) as unknown as typeof fetch;

        render(<Gallery />, { route: "/gallery/bravo" });

        expect(screen.queryByText(/no longer in the gallery/i)).not.toBeInTheDocument();

        // Settle the pending promise so the test does not leak an act() warning.
        resolve?.({ ok: true, status: 200, json: async () => MANIFEST });
        await waitFor(() => {
            expect(screen.getByRole("dialog")).toBeInTheDocument();
        });
    });

    it("offers a copy-link control that names the site domain, not the Worker", async () => {
        // The user-visible promise: the shareable link is autoboat.aoe.vt.edu.
        mockManifest();
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis.navigator, "clipboard", {
            value: { writeText },
            configurable: true,
        });

        render(<Gallery />, { route: "/gallery/alpha" });

        const button = await screen.findByRole("button", { name: /copy link/i });
        fireEvent.click(button);

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        const copied = writeText.mock.calls[0]?.[0] as string;
        expect(copied).toContain("autoboat.aoe.vt.edu/gallery/alpha");
        expect(copied).not.toContain("workers.dev");
    });

    it("offers the copy control for a curated photo too", async () => {
        // THE BUG THIS GUARDS. Curated (build-time) photos used to have no id,
        // so they opened in local state and the lightbox offered no Copy link --
        // "not all images have the copy link button". Every tile now carries a
        // `photoId` (a Drive id or a curated slug), so every photo is linkable.
        globalThis.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ...MANIFEST, images: [] }),
        }) as unknown as typeof fetch;

        const { container } = render(<Gallery />);

        await waitFor(() => expect(container.querySelectorAll(".photo-container img").length).toBeGreaterThan(0));
        fireEvent.click(container.querySelector(".photo-container > button") as HTMLElement);

        await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
        expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
    });

    it("puts a curated photo in the URL so its link is shareable", async () => {
        // The link is only worth copying if it reopens the same photo.
        globalThis.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ...MANIFEST, images: [] }),
        }) as unknown as typeof fetch;

        const { container } = render(<Gallery />);

        await waitFor(() => expect(container.querySelectorAll(".photo-container img").length).toBeGreaterThan(0));
        fireEvent.click(container.querySelector(".photo-container > button") as HTMLElement);

        await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
        // Navigated to /gallery/<slug>, not left on the bare grid.
        expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toContain("/images/");
    });

    it("does not offer the remove action for a curated photo", async () => {
        // Copy link is universal; REMOVE is not. A curated photo has no Drive
        // file, so the hide endpoint would 404 on it.
        globalThis.localStorage.setItem(
            "autoboat.calendar.session",
            JSON.stringify({ token: "t", name: "Officer", expiresAt: Date.now() + 600_000 }),
        );
        globalThis.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ...MANIFEST, images: [] }),
        }) as unknown as typeof fetch;

        const { container } = render(<Gallery />);

        await waitFor(() => expect(container.querySelectorAll(".photo-container img").length).toBeGreaterThan(0));
        fireEvent.click(container.querySelector(".photo-container > button") as HTMLElement);

        await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
        expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /remove from gallery/i })).not.toBeInTheDocument();
    });
});
