/**
 * @jest-environment node
 *
 * Tests for the gallery reconciliation rules.
 *
 * These are the rules that decide what the public page contains, so the cases
 * that matter are the ones where a naive implementation silently publishes
 * something broken or hides something real:
 *
 *  - an image whose bytes are not mirrored yet must NOT be advertised
 *  - a file still in Drive must never be swept from R2
 *  - a file that left Drive MUST be swept
 *  - a mirror timestamp must survive a re-list, or every sync re-copies
 *    everything
 */

import {
    buildManifest,
    fileIdFromKey,
    filesToMirror,
    type GalleryManifest,
    keysToDelete,
    markMirrored,
    mirrorKey,
    parseManifest,
    removeEntry,
    renderableEntries,
} from "../../../worker/src/gallery";

const NOW = new Date("2026-10-22T12:00:00Z");

function file(id: string, name: string, modifiedTime: string | null = "2026-10-20T00:00:00Z") {
    return { id, name, width: 100, height: 75, modifiedTime };
}

describe("mirrorKey / fileIdFromKey", () => {
    it("round-trips a Drive file id", () => {
        const key = mirrorKey("1AbC-d_ef");
        expect(fileIdFromKey(key)).toBe("1AbC-d_ef");
    });

    it("rejects a key outside the gallery prefix", () => {
        expect(fileIdFromKey("events/v2")).toBeNull();
        expect(fileIdFromKey("gallery/sub/dir")).toBeNull();
    });

    it("rejects a key with a path traversal segment", () => {
        // R2 keys are flat, but a manifest is untrusted input on the way back
        // in -- this must not resolve to a different object.
        expect(fileIdFromKey("gallery/..%2Fsecret")).toBeNull();
    });
});

describe("buildManifest", () => {
    it("lists every Drive file, mirroring only those present in R2", () => {
        const manifest = buildManifest(
            [file("a", "one.jpg"), file("b", "two.jpg")],
            new Set([mirrorKey("a")]),
            null,
            NOW,
        );

        expect(manifest.entries).toHaveLength(2);
        expect(manifest.entries.find((e) => e.id === "a")?.mirroredAt).toBe(NOW.getTime());
        expect(manifest.entries.find((e) => e.id === "b")?.mirroredAt).toBeNull();
    });

    it("marks unmirrored files as pending", () => {
        const manifest = buildManifest([file("a", "one.jpg"), file("b", "two.jpg")], new Set(), null, NOW);
        expect(manifest.pending.sort()).toEqual(["a", "b"]);
    });

    it("keeps a previously recorded mirror time across a re-list", () => {
        // Without this, every sync would consider the file unmirrored and copy
        // the whole folder again.
        const first = buildManifest([file("a", "one.jpg")], new Set([mirrorKey("a")]), null, new Date(1000));
        const second = buildManifest([file("a", "one.jpg")], new Set([mirrorKey("a")]), first, NOW);

        expect(second.entries[0]?.mirroredAt).toBe(1000);
    });

    it("clears the mirror time when the bytes are gone from R2", () => {
        // This is the repair path: a file whose object was evicted must be
        // reported as needing a copy, not as ready.
        const first = buildManifest([file("a", "one.jpg")], new Set([mirrorKey("a")]), null, new Date(1000));
        const second = buildManifest([file("a", "one.jpg")], new Set(), first, NOW);

        expect(second.entries[0]?.mirroredAt).toBeNull();
        expect(second.pending).toEqual(["a"]);
    });

    it("sorts newest first", () => {
        const manifest = buildManifest(
            [file("old", "old.jpg", "2026-01-01T00:00:00Z"), file("new", "new.jpg", "2026-10-01T00:00:00Z")],
            new Set(),
            null,
            NOW,
        );
        expect(manifest.entries.map((e) => e.id)).toEqual(["new", "old"]);
    });

    it("sorts undated files after dated ones", () => {
        // A file Drive has not finished processing must not jump to the top and
        // then move once its date arrives.
        const manifest = buildManifest(
            [file("undated", "undated.jpg", null), file("dated", "dated.jpg", "2026-01-01T00:00:00Z")],
            new Set(),
            null,
            NOW,
        );
        expect(manifest.entries.map((e) => e.id)).toEqual(["dated", "undated"]);
    });

    it("orders equal timestamps by name, numerically", () => {
        const same = "2026-10-01T00:00:00Z";
        const manifest = buildManifest([file("b", "10.jpg", same), file("a", "2.jpg", same)], new Set(), null, NOW);
        expect(manifest.entries.map((e) => e.name)).toEqual(["2.jpg", "10.jpg"]);
    });

    it("carries dimensions through for layout reservation", () => {
        const manifest = buildManifest([file("a", "one.jpg")], new Set(), null, NOW);
        expect(manifest.entries[0]).toMatchObject({ width: 100, height: 75 });
    });
});

describe("renderableEntries", () => {
    it("omits images whose bytes are not in place yet", () => {
        // This is the guard against a broken tile on a public page.
        const manifest = buildManifest(
            [file("ready", "r.jpg"), file("pending", "p.jpg")],
            new Set([mirrorKey("ready")]),
            null,
            NOW,
        );
        expect(renderableEntries(manifest).map((e) => e.id)).toEqual(["ready"]);
    });
});

describe("filesToMirror", () => {
    it("returns at most the limit", () => {
        const manifest = buildManifest(
            [file("a", "a.jpg"), file("b", "b.jpg"), file("c", "c.jpg")],
            new Set(),
            null,
            NOW,
        );
        expect(filesToMirror(manifest, 2)).toHaveLength(2);
    });

    it("returns nothing when the limit is zero or negative", () => {
        const manifest = buildManifest([file("a", "a.jpg")], new Set(), null, NOW);
        expect(filesToMirror(manifest, 0)).toEqual([]);
        expect(filesToMirror(manifest, -1)).toEqual([]);
    });
});

describe("keysToDelete", () => {
    it("returns keys for files that left Drive", () => {
        const keys = [mirrorKey("gone"), mirrorKey("still-there")];
        expect(keysToDelete(keys, new Set(["still-there"]))).toEqual([mirrorKey("gone")]);
    });

    it("never touches keys outside the gallery prefix", () => {
        // The bucket may hold other data; an unrelated key must not be swept
        // merely because it is not a gallery image.
        const keys = ["events/v2", "thumbnails/x", mirrorKey("live")];
        expect(keysToDelete(keys, new Set(["live"]))).toEqual([]);
    });

    it("deletes nothing when every file is still live", () => {
        const keys = [mirrorKey("a"), mirrorKey("b")];
        expect(keysToDelete(keys, new Set(["a", "b"]))).toEqual([]);
    });
});

describe("markMirrored / removeEntry", () => {
    const base = (): GalleryManifest => buildManifest([file("a", "a.jpg"), file("b", "b.jpg")], new Set(), null, NOW);

    it("records the mirror time and clears pending", () => {
        const manifest = markMirrored(base(), "a", NOW);
        expect(manifest.entries.find((e) => e.id === "a")?.mirroredAt).toBe(NOW.getTime());
        expect(manifest.pending).toEqual(["b"]);
    });

    it("does not overwrite an existing mirror time", () => {
        const first = markMirrored(base(), "a", new Date(1000));
        const second = markMirrored(first, "a", NOW);
        expect(second.entries.find((e) => e.id === "a")?.mirroredAt).toBe(1000);
    });

    it("removes an entry from both entries and pending", () => {
        const manifest = removeEntry(base(), "a");
        expect(manifest.entries.map((e) => e.id)).toEqual(["b"]);
        expect(manifest.pending).toEqual(["b"]);
    });
});

describe("parseManifest", () => {
    it("returns null for anything unrecognisable", () => {
        // A corrupt value must read as "no manifest yet" so the next sync
        // rebuilds, not as an outage.
        expect(parseManifest(null)).toBeNull();
        expect(parseManifest("{}")).toBeNull();
        expect(parseManifest({})).toBeNull();
        expect(parseManifest({ entries: "nope" })).toBeNull();
    });

    it("drops malformed entries but keeps the good ones", () => {
        const parsed = parseManifest({
            syncedAt: 123,
            entries: [{ id: "a", name: "a.jpg", mirroredAt: 5 }, { nope: true }, { id: "" }],
        });
        expect(parsed?.entries).toHaveLength(1);
        expect(parsed?.syncedAt).toBe(123);
    });

    it("derives the mirror key when one is missing", () => {
        const parsed = parseManifest({ entries: [{ id: "abc", name: "a.jpg" }] });
        expect(parsed?.entries[0]?.key).toBe(mirrorKey("abc"));
    });

    it("rebuilds pending from unmirrored entries when absent", () => {
        const parsed = parseManifest({
            entries: [
                { id: "a", name: "a.jpg", mirroredAt: 5 },
                { id: "b", name: "b.jpg" },
            ],
        });
        expect(parsed?.pending).toEqual(["b"]);
    });
});
