import { render, screen, waitFor } from "@testing-library/react";
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
