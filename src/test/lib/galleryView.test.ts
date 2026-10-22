import { altFromFileName, buildGalleryTiles, galleryStatusNote } from "../../lib/galleryView";

/**
 * Tests for the gallery's presentation logic.
 *
 * The two rules worth guarding are the merge order (Drive photos are the new
 * ones, so they lead) and the dedupe by `src` (the grid keys tiles by src, so a
 * duplicate would drop a tile and warn).
 */

const curated = [
    { src: "/images/gallery/1.webp", alt: "#1" },
    { src: "/images/our_team_images/software/cv.webp", alt: "Computer Vision", caption: "A caption" },
];

const imageUrl = (id: string) => `https://worker.example/gallery/image/${id}`;

describe("buildGalleryTiles", () => {
    it("puts Drive images before the curated ones", () => {
        // New photos land in Drive, so the newest activity should lead.
        const tiles = buildGalleryTiles(
            [{ id: "abc", name: "regatta.jpg", width: null, height: null, modifiedTime: null }],
            curated,
            imageUrl,
        );

        expect(tiles[0]?.src).toBe(imageUrl("abc"));
        expect(tiles.slice(1).map((t) => t.src)).toEqual(curated.map((c) => c.src));
    });

    it("keeps every curated image when Drive has none", () => {
        // The Drive fetch failing must not remove the curated gallery.
        expect(buildGalleryTiles([], curated, imageUrl)).toHaveLength(curated.length);
    });

    it("carries a caption through to the lightbox", () => {
        const tiles = buildGalleryTiles([], curated, imageUrl);
        expect(tiles.find((t) => t.src.includes("cv.webp"))?.caption).toBe("A caption");
    });

    it("omits caption entirely when there is none", () => {
        // An explicit `caption: undefined` would render an empty paragraph.
        const tiles = buildGalleryTiles([], curated, imageUrl);
        expect(tiles[0]).not.toHaveProperty("caption");
    });

    it("derives alt text from the filename", () => {
        const tiles = buildGalleryTiles(
            [{ id: "a", name: "lake_test-2026.jpg", width: null, height: null, modifiedTime: null }],
            [],
            imageUrl,
        );
        expect(tiles[0]?.alt).toBe("lake test 2026");
    });

    it("gives every tile a unique key", () => {
        // React would drop a tile and warn on a duplicate key.
        const tiles = buildGalleryTiles(
            [
                { id: "a", name: "a.jpg", width: null, height: null, modifiedTime: null },
                { id: "b", name: "b.jpg", width: null, height: null, modifiedTime: null },
            ],
            curated,
            imageUrl,
        );
        expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
    });

    it("drops a Drive image that duplicates a curated src", () => {
        // Cannot collide today, but a future change that served a Drive photo
        // through a local path would otherwise render the same tile twice.
        const tiles = buildGalleryTiles(
            [{ id: "dup", name: "dup.jpg", width: null, height: null, modifiedTime: null }],
            [{ src: imageUrl("dup"), alt: "duplicate" }],
            imageUrl,
        );
        expect(tiles).toHaveLength(1);
    });
});

describe("altFromFileName", () => {
    it("drops the extension", () => {
        expect(altFromFileName("boat.jpg")).toBe("boat");
    });

    it("replaces separators with spaces", () => {
        expect(altFromFileName("regatta_day-2.jpeg")).toBe("regatta day 2");
    });

    it("leaves a leading date readable", () => {
        expect(altFromFileName("2026-04-12_lake_test.jpg")).toBe("2026 04 12 lake test");
    });

    it("keeps an extensionless name intact", () => {
        expect(altFromFileName("boat")).toBe("boat");
    });

    it("falls back to the raw name when it reduces to nothing", () => {
        // A name like ".jpg" would otherwise produce empty alt text, which is
        // worse for a screen reader than the raw filename.
        expect(altFromFileName(".jpg")).toBe(".jpg");
    });
});

describe("galleryStatusNote", () => {
    it("returns null when there is nothing to say", () => {
        expect(galleryStatusNote(0, null)).toBeNull();
    });

    it("reports a single pending photo in the singular", () => {
        expect(galleryStatusNote(1, null)).toContain("1 more photo is");
    });

    it("reports several pending photos in the plural", () => {
        expect(galleryStatusNote(3, null)).toContain("3 more photos are");
    });

    it("uses the warning when nothing is pending", () => {
        // A failed sync leaves a warning but no backlog; the warning already
        // reads as a sentence, so it is passed through.
        expect(galleryStatusNote(0, "Drive is unavailable.")).toBe("Drive is unavailable.");
    });

    it("prefers the pending count over a stale warning", () => {
        expect(galleryStatusNote(2, "Drive hiccup.")).toContain("2 more photos are");
    });
});
