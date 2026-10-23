/**
 * @jest-environment node
 *
 * WIRING tests for the saved gallery order, driven through `syncGallery`.
 *
 * WHY THESE EXIST SEPARATELY FROM `galleryOrder.test.ts`. Those tests call
 * `sortEntriesByOrder` / `buildManifest` directly and hand in an order, so they
 * verify the RULE. They cannot verify that `syncGallery` loads the saved order
 * at all -- deleting the `loadOrder` call leaves every one of them green while
 * the gallery silently reverts to newest-first on the next cron tick.
 *
 * That is not hypothetical: the identical gap existed for the hidden set, and a
 * probe (remove the wiring, re-run) proved the pure tests passed anyway. So the
 * load-order wiring gets a test that drives the sync itself.
 */

import { type GalleryManifest, mirrorKey } from "../../../worker/src/gallery";
import { GALLERY_ORDER_KV_KEY, syncGallery } from "../../../worker/src/gallerySync";

jest.mock("../../../worker/src/drive", () => ({
    listFolderImages: jest.fn(),
    downloadFile: jest.fn(),
    uploadImage: jest.fn(),
    getFileMetadata: jest.fn(),
}));

jest.mock("../../../worker/src/googleAuth", () => ({
    getAccessToken: jest.fn(async () => "fake-token"),
    serviceAccountConfigFromEnv: jest.fn(() => ({
        clientEmail: "svc@example.com",
        privateKeyPem: "unused",
    })),
}));

import { downloadFile, listFolderImages } from "../../../worker/src/drive";

const listFolderImagesMock = listFolderImages as unknown as jest.Mock;
const downloadFileMock = downloadFile as unknown as jest.Mock;

const NOW = new Date("2026-10-22T12:00:00Z");

function makeKv(store: Record<string, unknown> = {}) {
    const writes: string[] = [];
    return {
        store,
        writes,
        async get(key: string) {
            return key in store ? store[key] : null;
        },
        async put(key: string, value: string) {
            writes.push(key);
            store[key] = JSON.parse(value);
        },
    };
}

function makeBucket(keys: string[] = []) {
    const deleted: string[] = [];
    return {
        deleted,
        async get() {
            return null;
        },
        async put() {},
        async delete(key: string) {
            deleted.push(key);
        },
        async list() {
            return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
        },
    };
}

function makeEnv(kv = makeKv(), bucket = makeBucket()) {
    return {
        EVENTS_KV: kv,
        GALLERY_BUCKET: bucket,
        DRIVE_GALLERY_FOLDER_ID: "folder-id",
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.com",
        GOOGLE_PRIVATE_KEY: "unused",
    };
}

/** Three displayable images; Drive reports them in name order. */
function threeFiles() {
    return ["alpha", "bravo", "charlie"].map((id) => ({
        id,
        name: `${id}.jpg`,
        mimeType: "image/jpeg",
        width: 10,
        height: 10,
        modifiedTime: `2026-10-0${["alpha", "bravo", "charlie"].indexOf(id) + 1}T00:00:00Z`,
        size: 1,
    }));
}

const ALL_MIRRORED = ["alpha", "bravo", "charlie"].map((id) => mirrorKey(id));

beforeEach(() => {
    jest.clearAllMocks();
    listFolderImagesMock.mockResolvedValue(threeFiles());
    downloadFileMock.mockResolvedValue({ ok: true, body: new ReadableStream() });
});

describe("syncGallery applies the saved order", () => {
    it("re-sorts the manifest from the stored order", async () => {
        // THE REGRESSION TEST for this feature. Without the `loadOrder` call in
        // the sync, this reverts to charlie/bravo/alpha (newest first).
        const kv = makeKv({
            [GALLERY_ORDER_KV_KEY]: { keys: ["drive:bravo", "drive:charlie", "drive:alpha"], updatedAt: 1 },
        });

        const result = await syncGallery(makeEnv(kv, makeBucket(ALL_MIRRORED)), NOW);

        expect(result.manifest.entries.map((e) => e.id)).toEqual(["bravo", "charlie", "alpha"]);
    });

    it("falls back to newest-first with no stored order", async () => {
        const result = await syncGallery(makeEnv(makeKv(), makeBucket(ALL_MIRRORED)), NOW);

        expect(result.manifest.entries.map((e) => e.id)).toEqual(["charlie", "bravo", "alpha"]);
    });

    it("keeps a newly uploaded photo at the end rather than first", async () => {
        // The list is partial by design: a photo added after the order was saved
        // is not named in it, so it must not displace a deliberate placement.
        const kv = makeKv({ [GALLERY_ORDER_KV_KEY]: { keys: ["drive:charlie"], updatedAt: 1 } });

        const result = await syncGallery(makeEnv(kv, makeBucket(ALL_MIRRORED)), NOW);

        expect(result.manifest.entries.map((e) => e.id)).toEqual(["charlie", "bravo", "alpha"]);
    });

    it("does not write the order key during a sync", async () => {
        // The order only changes when an officer acts, so the sync must not spend
        // KV writes on it. (The manifest write is the sync's one write.)
        const kv = makeKv({ [GALLERY_ORDER_KV_KEY]: { keys: ["drive:bravo"], updatedAt: 1 } });

        await syncGallery(makeEnv(kv, makeBucket(ALL_MIRRORED)), NOW);

        expect(kv.writes).not.toContain(GALLERY_ORDER_KV_KEY);
        expect(kv.writes).toEqual(["gallery:manifest:v1"]);
    });

    it("applies order and hidden together", async () => {
        // The two preferences are independent and must both survive a rebuild.
        const kv = makeKv({
            "gallery:hidden:v1": { ids: ["alpha"], updatedAt: 1 },
            [GALLERY_ORDER_KV_KEY]: { keys: ["drive:charlie", "drive:bravo", "drive:alpha"], updatedAt: 1 },
        });

        const result = await syncGallery(makeEnv(kv, makeBucket(ALL_MIRRORED)), NOW);
        const entries = result.manifest.entries;

        // Ordering is preserved, and the hidden flag is still applied.
        expect(entries.map((e) => e.id)).toEqual(["charlie", "bravo", "alpha"]);
        expect(entries.find((e) => e.id === "alpha")?.hidden).toBe(true);
    });

    it("survives a corrupt order value by falling back", async () => {
        // An unreadable value must read as "no custom order", not blank the page.
        const kv = makeKv({ [GALLERY_ORDER_KV_KEY]: { nope: true } });

        const result = await syncGallery(makeEnv(kv, makeBucket(ALL_MIRRORED)), NOW);

        expect(result.manifest.entries).toHaveLength(3);
        expect(result.manifest.entries.map((e) => e.id)).toEqual(["charlie", "bravo", "alpha"]);
    });

    it("keeps a stale id in the stored order harmless", async () => {
        // A photo deleted from Drive leaves its id behind in the list. That is
        // deliberate (see sortEntriesByOrder) and must not break the sync.
        const kv = makeKv({
            [GALLERY_ORDER_KV_KEY]: {
                keys: ["drive:deleted-photo", "drive:charlie", "drive:alpha", "drive:bravo"],
                updatedAt: 1,
            },
        });

        const result = await syncGallery(makeEnv(kv, makeBucket(ALL_MIRRORED)), NOW);

        expect(result.manifest.entries.map((e) => e.id)).toEqual(["charlie", "alpha", "bravo"]);
    });
});

describe("order round-trip through the route's write path", () => {
    it("a saved order is what the next sync produces", async () => {
        // End-to-end through the two halves: write the order the way the route
        // does (`setGalleryOrder`), then sync, and the manifest must match.
        const { setGalleryOrder } = await import("../../../worker/src/gallerySync");
        const seeded: GalleryManifest = {
            syncedAt: 1,
            entries: threeFiles().map((f) => ({
                id: f.id,
                name: f.name,
                key: mirrorKey(f.id),
                width: 10,
                height: 10,
                modifiedTime: f.modifiedTime,
                mirroredAt: 1,
                hidden: false,
            })),
            pending: [],
            warning: null,
        };
        const kv = makeKv({ "gallery:manifest:v1": seeded });
        const bucket = makeBucket(ALL_MIRRORED);

        await setGalleryOrder(makeEnv(kv, bucket), ["drive:alpha", "drive:bravo", "drive:charlie"], NOW);
        const result = await syncGallery(makeEnv(kv, bucket), NOW);

        expect(result.manifest.entries.map((e) => e.id)).toEqual(["alpha", "bravo", "charlie"]);
    });
});
