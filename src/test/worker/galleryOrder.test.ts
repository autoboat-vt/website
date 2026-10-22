/**
 * @jest-environment node
 *
 * Tests for the officer-chosen gallery display order.
 *
 * Two layers matter, and they are deliberately separate:
 *
 *  1. The pure rule (`sortEntriesByOrder`) -- listed photos come first in the
 *     officer's sequence, unlisted ones follow newest-first.
 *  2. The WIRING in `syncGallery` -- that the saved order is actually loaded and
 *     passed to `buildManifest`. Layer 1 can be perfectly correct while the sync
 *     forgets to load the order, and the gallery silently reverts to newest-first
 *     on the next cron tick. That exact trap already cost us once with the hidden
 *     set, so it has its own test in `galleryOrderSync.test.ts`.
 */

import {
    buildManifest,
    type GalleryEntry,
    type GalleryManifest,
    MAX_ORDERED_IDS,
    mirrorKey,
    moveInOrder,
    parseOrder,
    reorderableIds,
    serializeOrder,
    sortEntriesByOrder,
} from "../../../worker/src/gallery";

const NOW = new Date("2026-10-22T12:00:00Z");

/** Minimal entry for the pure sort tests. */
function entry(id: string, modifiedTime: string | null = "2026-10-01T00:00:00Z"): GalleryEntry {
    return {
        id,
        name: `${id}.jpg`,
        key: mirrorKey(id),
        width: null,
        height: null,
        modifiedTime,
        mirroredAt: 1,
        hidden: false,
    };
}

const FILES = [
    { id: "alpha", name: "alpha.jpg", width: null, height: null, modifiedTime: "2026-10-01T00:00:00Z" },
    { id: "bravo", name: "bravo.jpg", width: null, height: null, modifiedTime: "2026-10-02T00:00:00Z" },
    { id: "charlie", name: "charlie.jpg", width: null, height: null, modifiedTime: "2026-10-03T00:00:00Z" },
];
const MIRRORED = new Set(FILES.map((f) => mirrorKey(f.id)));

describe("sortEntriesByOrder", () => {
    it("puts listed photos first, in the officer's sequence", () => {
        const entries = [entry("alpha"), entry("bravo"), entry("charlie")];
        sortEntriesByOrder(entries, ["charlie", "alpha", "bravo"]);
        expect(entries.map((e) => e.id)).toEqual(["charlie", "alpha", "bravo"]);
    });

    it("appends photos that are not in the list, keeping newest-first among them", () => {
        // The normal case: a photo was uploaded after the order was set. It must
        // still appear, and it must not displace a photo someone placed.
        const entries = [
            entry("alpha", "2026-10-01T00:00:00Z"),
            entry("bravo", "2026-10-05T00:00:00Z"),
            entry("charlie", "2026-10-03T00:00:00Z"),
        ];
        sortEntriesByOrder(entries, ["alpha"]);
        expect(entries.map((e) => e.id)).toEqual(["alpha", "bravo", "charlie"]);
    });

    it("ignores stale ids from photos that left Drive", () => {
        // The list is deliberately not pruned when a file disappears, so it can
        // contain ids that match nothing. That must be harmless.
        const entries = [entry("alpha"), entry("bravo")];
        sortEntriesByOrder(entries, ["gone", "alpha", "also-gone", "bravo"]);
        expect(entries.map((e) => e.id)).toEqual(["alpha", "bravo"]);
    });

    it("takes the FIRST position for a duplicated id", () => {
        // `parseOrder` de-duplicates keeping the first occurrence; the sort has to
        // agree, or a stored list would order differently than it reads.
        const entries = [entry("alpha"), entry("bravo")];
        sortEntriesByOrder(entries, ["bravo", "alpha", "bravo"]);
        expect(entries.map((e) => e.id)).toEqual(["bravo", "alpha"]);
    });

    it("falls back to newest-first with an empty order", () => {
        const entries = [entry("alpha", "2026-10-01T00:00:00Z"), entry("bravo", "2026-10-05T00:00:00Z")];
        sortEntriesByOrder(entries, []);
        expect(entries.map((e) => e.id)).toEqual(["bravo", "alpha"]);
    });

    it("is stable for equal reference times", () => {
        const entries = [entry("b", "2026-10-01T00:00:00Z"), entry("a", "2026-10-01T00:00:00Z")];
        sortEntriesByOrder(entries, []);
        expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
    });
});

describe("buildManifest with an order", () => {
    it("applies the officer's order to the rebuilt manifest", () => {
        const manifest = buildManifest(FILES, MIRRORED, null, NOW, new Set(), ["bravo", "charlie", "alpha"]);
        expect(manifest.entries.map((e) => e.id)).toEqual(["bravo", "charlie", "alpha"]);
    });

    it("defaults to newest-first when no order was set", () => {
        const manifest = buildManifest(FILES, MIRRORED, null, NOW);
        expect(manifest.entries.map((e) => e.id)).toEqual(["charlie", "bravo", "alpha"]);
    });

    it("keeps hidden photos in the manifest even when they are unlisted", () => {
        // Hiding and ordering are independent; an entry must not be dropped by
        // the ordering pass.
        const manifest = buildManifest(FILES, MIRRORED, null, NOW, new Set(["bravo"]), ["charlie"]);
        expect(manifest.entries).toHaveLength(3);
        expect(manifest.entries.find((e) => e.id === "bravo")?.hidden).toBe(true);
    });
});

describe("parseOrder", () => {
    it("reads a stored list", () => {
        expect(parseOrder({ ids: ["a", "b"] })).toEqual(["a", "b"]);
    });

    it("reads anything unrecognisable as no custom order", () => {
        // Falling back to newest-first is the safe direction; the alternative is
        // a gallery that renders nothing.
        expect(parseOrder(null)).toEqual([]);
        expect(parseOrder({})).toEqual([]);
        expect(parseOrder({ ids: "nope" })).toEqual([]);
    });

    it("drops non-string and empty entries", () => {
        expect(parseOrder({ ids: ["a", 3, null, "", "b"] })).toEqual(["a", "b"]);
    });

    it("de-duplicates keeping the first occurrence", () => {
        expect(parseOrder({ ids: ["a", "b", "a"] })).toEqual(["a", "b"]);
    });
});

describe("serializeOrder", () => {
    it("stores the ids with a timestamp", () => {
        expect(serializeOrder(["a", "b"], NOW)).toEqual({ ids: ["a", "b"], updatedAt: NOW.getTime() });
    });

    it("caps the list at the safety ceiling", () => {
        const many = Array.from({ length: MAX_ORDERED_IDS + 10 }, (_, i) => `id-${i}`);
        expect(serializeOrder(many, NOW).ids).toHaveLength(MAX_ORDERED_IDS);
    });
});

describe("moveInOrder", () => {
    it("moves an item earlier", () => {
        expect(moveInOrder(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    });

    it("moves an item later", () => {
        expect(moveInOrder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    });

    it("returns an unchanged copy for a no-op move", () => {
        const current = ["a", "b"];
        const next = moveInOrder(current, 1, 1);
        expect(next).toEqual(["a", "b"]);
        // A new array, so a caller cannot accidentally mutate the input.
        expect(next).not.toBe(current);
    });

    it("clamps out-of-range indices instead of throwing", () => {
        // The list can change between the render that produced the click and the
        // request carrying it.
        expect(moveInOrder(["a", "b"], 5, 0)).toEqual(["b", "a"]);
        expect(moveInOrder(["a", "b"], 0, 99)).toEqual(["b", "a"]);
    });

    it("handles an empty list", () => {
        expect(moveInOrder([], 0, 1)).toEqual([]);
    });
});

describe("reorderableIds", () => {
    it("lists only visible photos, in display order", () => {
        const manifest = buildManifest(FILES, MIRRORED, null, NOW, new Set(["bravo"]), ["charlie", "alpha", "bravo"]);
        expect(reorderableIds(manifest)).toEqual(["charlie", "alpha"]);
    });

    it("excludes photos whose bytes are not mirrored yet", () => {
        // They are not on the page, so arranging them would be invisible work.
        const manifest: GalleryManifest = buildManifest(FILES, new Set([mirrorKey("alpha")]), null, NOW);
        expect(reorderableIds(manifest)).toEqual(["alpha"]);
    });
});
