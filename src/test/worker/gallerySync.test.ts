/**
 * @jest-environment node
 *
 * Sync-level tests for the gallery: the paths that actually run on the cron.
 *
 * WHY THESE EXIST, AND WHY THE PURE TESTS ARE NOT ENOUGH. `gallery.test.ts`
 * exercises `buildManifest` in isolation, so it verifies the reconciliation
 * RULES but not that `syncGallery` passes the right arguments into them -- and
 * the hidden-photo flag is precisely a value that has to be threaded through
 * the sync. A test that calls `buildManifest` with a hidden set directly will
 * happily pass while `syncGallery` forgets to load it, and every removed photo
 * silently reappears on the next cron tick. That regression was real: the probe
 * (delete the `loadHiddenIds` call from the sync) left the pure test green.
 *
 * So this file mocks the Drive client and drives `syncGallery` itself.
 */

import { mirrorKey } from "../../../worker/src/gallery";
import { syncGallery } from "../../../worker/src/gallerySync";

// The Drive client is replaced wholesale: this file is about the SYNC's
// bookkeeping, not about Drive. `uploadImage`/`downloadFile` are stubbed so a
// mirror attempt cannot reach the network either.
jest.mock("../../../worker/src/drive", () => ({
    listFolderImages: jest.fn(),
    downloadFile: jest.fn(),
    uploadImage: jest.fn(),
    getFileMetadata: jest.fn(),
}));

// The service-account exchange needs a real RSA key, which a unit test does not
// have. Returning a fake token is fine: nothing below inspects it.
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
const FOLDER = "folder-id";

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

/** An R2 stub whose `list` reports the given keys as already mirrored. */
function makeBucket(keys: string[] = []) {
    const written: string[] = [];
    const deleted: string[] = [];
    return {
        written,
        deleted,
        async get() {
            return null;
        },
        async put(key: string) {
            written.push(key);
        },
        async delete(key: string) {
            deleted.push(key);
        },
        async list() {
            return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
        },
    };
}

function makeEnv(overrides: { kv?: ReturnType<typeof makeKv>; bucket?: ReturnType<typeof makeBucket> } = {}) {
    return {
        EVENTS_KV: overrides.kv ?? makeKv(),
        GALLERY_BUCKET: overrides.bucket ?? makeBucket(),
        DRIVE_GALLERY_FOLDER_ID: FOLDER,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.com",
        GOOGLE_PRIVATE_KEY: "unused",
    };
}

/** Two displayable images, already mirrored. */
function twoDriveFiles() {
    return [
        {
            id: "photo-one",
            name: "one.jpg",
            mimeType: "image/jpeg",
            width: 10,
            height: 10,
            modifiedTime: null,
            size: 1,
        },
        {
            id: "photo-two",
            name: "two.jpg",
            mimeType: "image/jpeg",
            width: 10,
            height: 10,
            modifiedTime: null,
            size: 1,
        },
    ];
}

beforeEach(() => {
    jest.clearAllMocks();
    // Default: the listing succeeds, and no mirroring is attempted (both files
    // are already present in the bucket).
    listFolderImagesMock.mockResolvedValue(twoDriveFiles());
    downloadFileMock.mockResolvedValue({
        ok: true,
        body: new ReadableStream(),
    });
});

describe("syncGallery and hidden photos", () => {
    it("re-applies the hidden set on a re-list so a removed photo stays removed", async () => {
        // THE REGRESSION TEST. The manifest is rebuilt from Drive every sync, so
        // a flag kept only there is lost. The durable `gallery:hidden:v1` key is
        // what has to be read back and passed into `buildManifest`.
        const kv = makeKv({ "gallery:hidden:v1": { ids: ["photo-one"], updatedAt: 1 } });
        const bucket = makeBucket([mirrorKey("photo-one"), mirrorKey("photo-two")]);

        const result = await syncGallery(makeEnv({ kv, bucket }), NOW);

        expect(result.manifest.entries.find((e) => e.id === "photo-one")?.hidden).toBe(true);
        expect(result.manifest.entries.find((e) => e.id === "photo-two")?.hidden).toBe(false);
    });

    it("keeps the mirror for a hidden photo rather than sweeping it", async () => {
        // The bytes are still in Drive, so the delete sweep must not touch them.
        // Sweeping would make restoring a re-download, and would break the
        // restore list's thumbnail.
        const kv = makeKv({ "gallery:hidden:v1": { ids: ["photo-one"], updatedAt: 1 } });
        const bucket = makeBucket([mirrorKey("photo-one"), mirrorKey("photo-two")]);

        await syncGallery(makeEnv({ kv, bucket }), NOW);

        expect(bucket.deleted).toEqual([]);
    });

    it("writes nothing to the hidden key during a sync", async () => {
        // The hidden set only changes when an officer acts, so the sync must not
        // spend KV writes on it. (The manifest write is the sync's one write.)
        const kv = makeKv();
        const bucket = makeBucket([mirrorKey("photo-one"), mirrorKey("photo-two")]);

        await syncGallery(makeEnv({ kv, bucket }), NOW);

        expect(kv.writes).not.toContain("gallery:hidden:v1");
        // Exactly one write per sync, as the write budget requires.
        expect(kv.writes).toEqual(["gallery:manifest:v1"]);
    });

    it("shows every photo when nothing is hidden", async () => {
        const bucket = makeBucket([mirrorKey("photo-one"), mirrorKey("photo-two")]);

        const result = await syncGallery(makeEnv({ bucket }), NOW);

        expect(result.manifest.entries.every((e) => e.hidden === false)).toBe(true);
    });
});

describe("syncGallery keeps serving when Drive fails", () => {
    it("keeps the previous entries and attaches a warning", async () => {
        // A Google outage must leave a working (stale) gallery, not an error.
        listFolderImagesMock.mockRejectedValue(new Error("Drive is down"));
        const previous = {
            syncedAt: 1,
            entries: [
                {
                    id: "photo-one",
                    name: "one.jpg",
                    key: mirrorKey("photo-one"),
                    width: null,
                    height: null,
                    modifiedTime: null,
                    mirroredAt: 1,
                    hidden: false,
                },
            ],
            pending: [],
            warning: null,
        };
        const kv = makeKv({ "gallery:manifest:v1": previous });

        const result = await syncGallery(makeEnv({ kv }), NOW);

        expect(result.manifest.entries).toHaveLength(1);
        expect(result.manifest.warning).toContain("Drive is down");
        expect(result.mirrored).toBe(0);
    });
});
