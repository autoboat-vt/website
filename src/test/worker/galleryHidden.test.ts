/**
 * @jest-environment node
 *
 * Tests for hiding and restoring a gallery photo.
 *
 * THE REQUIREMENT THIS GUARDS: removing a photo must NOT delete it. The Drive
 * file and the mirrored bytes stay exactly as they are, so an officer who
 * removes the wrong photo can put it back. These tests assert both halves --
 * that the photo leaves the public list, and that nothing was destroyed.
 *
 * The other half is durability: the manifest is rebuilt from Drive on every
 * sync, so a `hidden` flag stored only there would be erased the next time the
 * folder was listed. The hidden set therefore lives on its own KV key, and the
 * "survives a re-list" test is what catches a regression that hides it in the
 * manifest instead.
 */

import { buildManifest, mirrorKey, parseHiddenList, setEntryHidden, withHidden } from "../../../worker/src/gallery";
import worker from "../../../worker/src/index";
import { createSession } from "../../../worker/src/session";

const SECRET = "test-session-secret";
const PROD_ORIGIN = "https://autoboat.aoe.vt.edu";
const NOW = new Date("2026-10-22T12:00:00Z");

const ENV = {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "1017960606403416085",
    ALLOWED_ORIGIN: PROD_ORIGIN,
    CACHE_TTL_SECONDS: "180",
    OFFICERS_CHANNEL_ID: "1550594891766308997",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: SECRET,
    OAUTH_REDIRECT_URI: `${PROD_ORIGIN}/calendar/`,
    DRIVE_GALLERY_FOLDER_ID: "folder-id",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@project.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: "not-a-real-key",
};

/** A KV stub that records writes, so a test can prove nothing was deleted. */
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

function makeBucket() {
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
            return { objects: [], truncated: false, cursor: undefined };
        },
    };
}

function makeCtx() {
    return {
        ctx: { waitUntil: () => {}, passThroughOnException: () => {} },
    };
}

/** The Worker's fetch handler, widened once so call sites stay clean. */
const fetchWorker = worker.fetch as unknown as (
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void },
) => Promise<Response>;

async function officerToken() {
    return (await createSession(SECRET, { id: "1", name: "Officer", canCreateEvents: true })).token;
}

async function memberToken() {
    return (await createSession(SECRET, { id: "2", name: "Member", canCreateEvents: false })).token;
}

/** A manifest with two mirrored photos, both visible. */
function manifestWithTwo() {
    const built = buildManifest(
        [
            { id: "photo-one", name: "one.jpg", width: 100, height: 75, modifiedTime: "2026-10-01T00:00:00Z" },
            { id: "photo-two", name: "two.jpg", width: 100, height: 75, modifiedTime: "2026-10-02T00:00:00Z" },
        ],
        new Set([mirrorKey("photo-one"), mirrorKey("photo-two")]),
        null,
        NOW,
    );
    return built;
}

async function patch(fileId: string, body: unknown, token?: string, env: Record<string, unknown> = {}) {
    const full = {
        ...ENV,
        EVENTS_KV: makeKv(),
        GALLERY_BUCKET: makeBucket(),
        ...env,
    };
    const headers: Record<string, string> = { Origin: PROD_ORIGIN, "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = new Request(`https://worker.example/manage/gallery/${fileId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
    });
    const { ctx } = makeCtx();
    return { res: await fetchWorker(request, full, ctx), env: full };
}

describe("PATCH /manage/gallery/{id}", () => {
    it("hides a photo", async () => {
        const kv = makeKv({ "gallery:manifest:v1": manifestWithTwo() });
        const { res } = await patch("photo-one", { hidden: true }, await officerToken(), { EVENTS_KV: kv });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: "photo-one", hidden: true });
    });

    it("does not delete the mirrored bytes", async () => {
        // THE CENTRAL REQUIREMENT. Removing a photo from the page must not touch
        // the mirror -- restoring depends on those bytes still being there.
        const bucket = makeBucket();
        const kv = makeKv({ "gallery:manifest:v1": manifestWithTwo() });
        await patch("photo-one", { hidden: true }, await officerToken(), { EVENTS_KV: kv, GALLERY_BUCKET: bucket });

        expect(bucket.deleted).toEqual([]);
    });

    it("keeps the entry in the manifest, only flagged", async () => {
        // The entry has to survive so the officer's restore list can show a
        // thumbnail and restoring is a flag flip rather than a re-copy.
        const kv = makeKv({ "gallery:manifest:v1": manifestWithTwo() });
        await patch("photo-one", { hidden: true }, await officerToken(), { EVENTS_KV: kv });

        const stored = kv.store["gallery:manifest:v1"] as { entries: { id: string; hidden: boolean }[] };
        expect(stored.entries).toHaveLength(2);
        expect(stored.entries.find((e) => e.id === "photo-one")?.hidden).toBe(true);
    });

    it("records the id in the durable hidden set", async () => {
        // Rebuilt manifests re-apply this set, which is what makes hiding survive
        // a Drive re-list.
        const kv = makeKv({ "gallery:manifest:v1": manifestWithTwo() });
        await patch("photo-one", { hidden: true }, await officerToken(), { EVENTS_KV: kv });

        const stored = kv.store["gallery:hidden:v1"] as { ids: string[] };
        expect(stored.ids).toEqual(["photo-one"]);
    });

    it("removes a hidden photo from the public manifest", async () => {
        const kv = makeKv({ "gallery:manifest:v1": manifestWithTwo() });
        const token = await officerToken();
        await patch("photo-one", { hidden: true }, token, { EVENTS_KV: kv });

        const request = new Request("https://worker.example/gallery", { headers: { Origin: PROD_ORIGIN } });
        const { ctx } = makeCtx();
        const res = await fetchWorker(request, { ...ENV, EVENTS_KV: kv, GALLERY_BUCKET: makeBucket() }, ctx);
        const body = (await res.json()) as { images: { id: string }[] };

        expect(body.images.map((i) => i.id)).toEqual(["photo-two"]);
    });

    it("restores a hidden photo", async () => {
        const kv = makeKv({
            "gallery:manifest:v1": manifestWithTwo(),
            "gallery:hidden:v1": { ids: ["photo-one"], updatedAt: 1 },
        });
        const token = await officerToken();
        const { res } = await patch("photo-one", { hidden: false }, token, { EVENTS_KV: kv });

        expect(res.status).toBe(200);
        const stored = kv.store["gallery:hidden:v1"] as { ids: string[] };
        expect(stored.ids).toEqual([]);
    });

    it("rejects an unauthenticated request", async () => {
        const { res } = await patch("photo-one", { hidden: true });
        expect(res.status).toBe(401);
    });

    it("rejects a member without the officer permission", async () => {
        const { res } = await patch("photo-one", { hidden: true }, await memberToken());
        expect(res.status).toBe(403);
    });

    it("rejects a forged token", async () => {
        const forged = (await createSession("wrong-secret", { id: "1", name: "X", canCreateEvents: true })).token;
        const { res } = await patch("photo-one", { hidden: true }, forged);
        expect(res.status).toBe(401);
    });

    it("rejects a non-boolean hidden value", async () => {
        // `{"hidden": "false"}` is a string and would read as truthy, silently
        // hiding a photo the caller meant to restore.
        const { res } = await patch("photo-one", { hidden: "false" }, await officerToken());
        expect(res.status).toBe(400);
    });

    it("rejects a missing hidden value", async () => {
        const { res } = await patch("photo-one", {}, await officerToken());
        expect(res.status).toBe(400);
    });

    it("404s for a photo the manifest does not contain", async () => {
        const kv = makeKv({ "gallery:manifest:v1": manifestWithTwo() });
        const { res } = await patch("not-in-there", { hidden: true }, await officerToken(), { EVENTS_KV: kv });
        expect(res.status).toBe(404);
    });

    it("404s when nothing has synced yet", async () => {
        // Writing an empty manifest here would mark it fresh and blank the
        // gallery for a whole TTL.
        const { res } = await patch("photo-one", { hidden: true }, await officerToken());
        expect(res.status).toBe(404);
    });

    it("404s a malformed id rather than treating it as a key", async () => {
        const { res } = await patch("..%2Fsecret", { hidden: true }, await officerToken());
        expect(res.status).toBe(404);
    });
});

describe("GET /manage/gallery/hidden", () => {
    async function listHidden(token?: string, env: Record<string, unknown> = {}) {
        const full = { ...ENV, EVENTS_KV: makeKv(), GALLERY_BUCKET: makeBucket(), ...env };
        const headers: Record<string, string> = { Origin: PROD_ORIGIN };
        if (token) headers.Authorization = `Bearer ${token}`;
        const request = new Request("https://worker.example/manage/gallery/hidden", { headers });
        const { ctx } = makeCtx();
        return fetchWorker(request, full, ctx);
    }

    it("lists the removed photos so they can be restored", async () => {
        const manifest = { ...manifestWithTwo() };
        manifest.entries = manifest.entries.map((e) => (e.id === "photo-one" ? { ...e, hidden: true } : e));
        const res = await listHidden(await officerToken(), {
            EVENTS_KV: makeKv({ "gallery:manifest:v1": manifest }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { images: { id: string }[] };
        expect(body.images.map((i) => i.id)).toEqual(["photo-one"]);
    });

    it("is officer-only", async () => {
        // The public must not be told which photos were taken down.
        expect((await listHidden()).status).toBe(401);
        expect((await listHidden(await memberToken())).status).toBe(403);
    });

    it("returns an empty list before any sync", async () => {
        const res = await listHidden(await officerToken());
        const body = (await res.json()) as { images: unknown[] };
        expect(body.images).toEqual([]);
    });
});

describe("hidden state survives a Drive re-list", () => {
    // WARNING: These assert the RECONCILIATION RULE only -- that `buildManifest` honours
    // a hidden set it is given. They cannot prove the sync passes one in: a
    // test that supplies the set by hand stays green even if `syncGallery`
    // forgets to load it. That wiring is covered in `gallerySync.test.ts`, and
    // the split is deliberate -- see the note there.

    it("keeps a hidden photo mirrored so restoring is instant", () => {
        const rebuilt = buildManifest(
            [{ id: "photo-one", name: "one.jpg", width: null, height: null, modifiedTime: null }],
            new Set([mirrorKey("photo-one")]),
            null,
            NOW,
            new Set(["photo-one"]),
        );

        expect(rebuilt.entries[0]?.mirroredAt).not.toBeNull();
        expect(rebuilt.entries[0]?.hidden).toBe(true);
    });
});

describe("hidden-list helpers", () => {
    it("parses a stored list", () => {
        expect(parseHiddenList({ ids: ["a", "b"] })).toEqual(new Set(["a", "b"]));
    });

    it("reads anything unrecognisable as nothing hidden", () => {
        // Showing the full gallery is the safe direction: the alternative hides
        // photos the team never took down.
        expect(parseHiddenList(null)).toEqual(new Set());
        expect(parseHiddenList({})).toEqual(new Set());
        expect(parseHiddenList({ ids: "nope" })).toEqual(new Set());
    });

    it("drops non-string entries", () => {
        expect(parseHiddenList({ ids: ["a", 3, null, ""] })).toEqual(new Set(["a"]));
    });

    it("adds and removes without mutating the original set", () => {
        const original = new Set(["a"]);
        expect(withHidden(original, "b", true)).toEqual(new Set(["a", "b"]));
        expect(withHidden(original, "a", false)).toEqual(new Set());
        expect(original).toEqual(new Set(["a"]));
    });

    it("returns null for an id the manifest does not contain", () => {
        expect(setEntryHidden(manifestWithTwo(), "nope", true)).toBeNull();
    });

    it("flips only the requested entry", () => {
        const updated = setEntryHidden(manifestWithTwo(), "photo-one", true);
        expect(updated?.entries.find((e) => e.id === "photo-one")?.hidden).toBe(true);
        expect(updated?.entries.find((e) => e.id === "photo-two")?.hidden).toBe(false);
    });
});
