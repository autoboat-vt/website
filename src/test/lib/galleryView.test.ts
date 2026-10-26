import {
    altFromFileName,
    applyTileOrder,
    buildGalleryTiles,
    curatedPhotoId,
    galleryStatusNote,
    moveWithin,
    tileKeysOf,
} from "../../lib/galleryView";

/**
 * Tests for the gallery's presentation logic.
 *
 * The two rules worth guarding are the merge order (Drive photos are the new
 * ones, so they lead) and the dedupe by `src` (the grid keys tiles by src, so a
 * duplicate would drop a tile and warn).
 */

const curated = [
    { src: "/images/our_team_images/software/cv.webp", alt: "Computer Vision", caption: "A caption" },
    { src: "/images/our_team_images/mechanical/boat1.webp", alt: "Vessel Hull 1" },
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

    it("gives EVERY tile a photoId, curated ones included", () => {
        // THE BUG THIS GUARDS. Curated tiles used to have no id, so only Drive
        // photos could be linked and the lightbox offered no Copy link for them.
        const tiles = buildGalleryTiles(
            [{ id: "abc", name: "regatta.jpg", width: null, height: null, modifiedTime: null }],
            curated,
            imageUrl,
        );

        expect(tiles).toHaveLength(3);
        for (const tile of tiles) {
            expect(typeof tile.photoId).toBe("string");
            expect(tile.photoId.length).toBeGreaterThan(0);
        }
        // The Drive tile is keyed by its real Drive id, so old links survive.
        expect(tiles[0]?.photoId).toBe("abc");
    });

    it("keeps curated photoIds unique across the whole grid", () => {
        // A duplicate would make two photos share one permalink.
        const ids = buildGalleryTiles([], curated, imageUrl).map((t) => t.photoId);
        expect(new Set(ids).size).toBe(ids.length);
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
        // Targeted by src rather than index so reordering the fixture cannot
        // silently make this assert the wrong tile.
        const tiles = buildGalleryTiles([], curated, imageUrl);
        const uncaptioned = tiles.find((t) => t.src.includes("boat1.webp"));
        expect(uncaptioned).not.toHaveProperty("caption");
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

describe("tileKeysOf", () => {
    const imageUrl = (id: string) => `https://worker.example/gallery/image/${id}`;

    it("lists EVERY tile key, curated ones included", () => {
        // THE BUG THIS GUARDS. An earlier version used Drive ids, so the curated
        // photos had no entry in the sequence and could not be reordered. Keys
        // exist for both sources.
        const tiles = buildGalleryTiles(
            [{ id: "a", name: "a.jpg", width: null, height: null, modifiedTime: null }],
            curated,
            imageUrl,
        );

        expect(tileKeysOf(tiles)).toEqual([`drive:a`, `site:${curated[0]?.src}`, `site:${curated[1]?.src}`]);
    });

    it("returns every key when there are no Drive tiles", () => {
        expect(tileKeysOf(buildGalleryTiles([], curated, imageUrl))).toHaveLength(curated.length);
    });
});

describe("applyTileOrder", () => {
    const imageUrl = (id: string) => `https://worker.example/gallery/image/${id}`;
    const threeDrive = () =>
        buildGalleryTiles(
            [
                { id: "a", name: "a.jpg", width: null, height: null, modifiedTime: null },
                { id: "b", name: "b.jpg", width: null, height: null, modifiedTime: null },
                { id: "c", name: "c.jpg", width: null, height: null, modifiedTime: null },
            ],
            curated,
            imageUrl,
        );

    it("reorders the Drive tiles", () => {
        expect(tileKeysOf(applyTileOrder(threeDrive(), ["drive:c", "drive:a", "drive:b"]))).toEqual([
            "drive:c",
            "drive:a",
            "drive:b",
            `site:${curated[0]?.src}`,
            `site:${curated[1]?.src}`,
        ]);
    });

    it("reorders a curated tile too", () => {
        // The whole point of the key change: curated photos are arrangeable.
        const tiles = threeDrive();
        const curatedKey = `site:${curated[1]?.src}`;
        const result = applyTileOrder(tiles, [curatedKey]);

        expect(result[0]?.key).toBe(curatedKey);
        expect(result).toHaveLength(tiles.length);
    });

    it("appends tiles the order does not name", () => {
        // A photo uploaded after the drag happened is not in the list yet, so it
        // must still appear rather than vanish.
        const result = applyTileOrder(threeDrive(), ["drive:c"]);
        expect(result[0]?.key).toBe("drive:c");
        expect(result).toHaveLength(threeDrive().length);
    });

    it("ignores a key that is not in the list", () => {
        const result = applyTileOrder(threeDrive(), ["gone", "drive:b", "drive:a"]);
        expect(tileKeysOf(result).slice(0, 3)).toEqual(["drive:b", "drive:a", "drive:c"]);
    });

    it("returns the tiles unchanged for an empty order", () => {
        expect(applyTileOrder(threeDrive(), [])).toEqual(threeDrive());
    });

    it("does not mutate the input", () => {
        const tiles = threeDrive();
        const before = tileKeysOf(tiles);
        applyTileOrder(tiles, ["drive:c", "drive:b", "drive:a"]);
        expect(tileKeysOf(tiles)).toEqual(before);
    });
});

describe("moveWithin", () => {
    it("moves an item forward", () => {
        expect(moveWithin(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    });

    it("moves an item backward", () => {
        expect(moveWithin(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    });

    it("returns a copy for a same-index move", () => {
        const items = ["a", "b"];
        const next = moveWithin(items, 1, 1);
        expect(next).toEqual(["a", "b"]);
        expect(next).not.toBe(items);
    });

    it("ignores out-of-range indices", () => {
        // The list can change between the render that produced the drag and the
        // drop that carries it.
        expect(moveWithin(["a", "b"], 5, 0)).toEqual(["a", "b"]);
        expect(moveWithin(["a", "b"], 0, 9)).toEqual(["a", "b"]);
    });

    it("handles an empty list", () => {
        expect(moveWithin([], 0, 1)).toEqual([]);
    });
});

describe("curatedPhotoId", () => {
    it("is URL-safe", () => {
        // It goes straight into /gallery/<id>, so it must need no escaping.
        expect(curatedPhotoId("/images/our_team_images/software/cv.webp")).toMatch(/^[a-z0-9-]+$/);
    });

    it("is namespaced away from Drive ids", () => {
        // A Drive id never starts with "site-", so the two sources cannot collide.
        expect(curatedPhotoId("/images/a/b.webp").startsWith("site-")).toBe(true);
    });
    it("includes the folder so same-named files stay distinct", () => {
        // electronics/photo.webp and mechanical/photo.webp are different photos.
        expect(curatedPhotoId("/images/x/electronics/photo.webp")).not.toBe(
            curatedPhotoId("/images/x/mechanical/photo.webp"),
        );
    });

    it("is stable across calls", () => {
        // These become public URLs; a shifting id would break pasted links.
        const src = "/images/our_team_images/mechanical/boat1.webp";
        expect(curatedPhotoId(src)).toBe(curatedPhotoId(src));
    });

    it("reads recognizably from the filename", () => {
        expect(curatedPhotoId("/images/our_team_images/mechanical/boat1.webp")).toBe("site-mechanical-boat1");
    });

    it("copes with a bare filename", () => {
        // Defensive: a malformed entry must not throw or produce "site--".
        expect(() => curatedPhotoId("photo.webp")).not.toThrow();
        expect(curatedPhotoId("photo.webp")).toMatch(/^[a-z0-9-]+$/);
    });
});
