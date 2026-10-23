/**
 * @jest-environment node
 *
 * Route-level tests for the gallery display-order endpoints.
 *
 * The security shape is the same as upload and hide: the order is written with
 * the service account's authority, so the session check is the only gate. The
 * other cases that matter are the body validation (a non-array or a non-string
 * entry would otherwise apply a sequence the officer never saw) and the
 * "unsynced gallery" case, which must not create an empty manifest.
 */

import { buildManifest, mirrorKey } from "../../../worker/src/gallery";
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
    return {
        async get() {
            return null;
        },
        async put() {},
        async delete() {},
        async list() {
            return { objects: [], truncated: false, cursor: undefined };
        },
    };
}

/** The Worker's fetch handler, widened once so call sites stay clean. */
const fetchWorker = worker.fetch as unknown as (
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void },
) => Promise<Response>;

function call(method: string, path: string, body?: unknown, token?: string, env: Record<string, unknown> = {}) {
    const full = { ...ENV, EVENTS_KV: makeKv(), GALLERY_BUCKET: makeBucket(), ...env };
    const headers: Record<string, string> = { Origin: PROD_ORIGIN };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = new Request(`https://worker.example${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    return { res: fetchWorker(request, full, ctx), env: full };
}

async function officerToken() {
    return (await createSession(SECRET, { id: "1", name: "Officer", canCreateEvents: true })).token;
}

async function memberToken() {
    return (await createSession(SECRET, { id: "2", name: "Member", canCreateEvents: false })).token;
}

/** A manifest with three mirrored photos, in default newest-first order. */
function manifestWithThree() {
    return buildManifest(
        [
            { id: "alpha", name: "alpha.jpg", width: 10, height: 10, modifiedTime: "2026-10-01T00:00:00Z" },
            { id: "bravo", name: "bravo.jpg", width: 10, height: 10, modifiedTime: "2026-10-02T00:00:00Z" },
            { id: "charlie", name: "charlie.jpg", width: 10, height: 10, modifiedTime: "2026-10-03T00:00:00Z" },
        ],
        new Set(["alpha", "bravo", "charlie"].map((id) => mirrorKey(id))),
        null,
        NOW,
    );
}

describe("GET /manage/gallery/order", () => {
    it("lists the visible photos in display order", async () => {
        const res = await call("GET", "/manage/gallery/order", undefined, await officerToken(), {
            EVENTS_KV: makeKv({ "gallery:manifest:v1": manifestWithThree() }),
        }).res;

        expect(res.status).toBe(200);
        const body = (await res.json()) as { images: { id: string }[] };
        // Default order is newest-first.
        expect(body.images.map((i) => i.id)).toEqual(["charlie", "bravo", "alpha"]);
    });

    it("excludes photos that are hidden", async () => {
        // Arranging a position for a photo nobody can see would be invisible work.
        const manifest = manifestWithThree();
        manifest.entries = manifest.entries.map((e) => (e.id === "bravo" ? { ...e, hidden: true } : e));
        const res = await call("GET", "/manage/gallery/order", undefined, await officerToken(), {
            EVENTS_KV: makeKv({ "gallery:manifest:v1": manifest }),
        }).res;

        const body = (await res.json()) as { images: { id: string }[] };
        expect(body.images.map((i) => i.id)).toEqual(["charlie", "alpha"]);
    });

    it("is officer-only", async () => {
        expect((await call("GET", "/manage/gallery/order").res).status).toBe(401);
        expect((await call("GET", "/manage/gallery/order", undefined, await memberToken()).res).status).toBe(403);
    });

    it("returns an empty list before any sync", async () => {
        const res = await call("GET", "/manage/gallery/order", undefined, await officerToken()).res;
        const body = (await res.json()) as { images: unknown[] };
        expect(body.images).toEqual([]);
    });
});

describe("PUT /manage/gallery/order", () => {
    it("saves the order", async () => {
        const kv = makeKv({ "gallery:manifest:v1": manifestWithThree() });
        const res = await call(
            "PUT",
            "/manage/gallery/order",
            { keys: ["drive:alpha", "drive:charlie", "drive:bravo"] },
            await officerToken(),
            { EVENTS_KV: kv },
        ).res;

        expect(res.status).toBe(200);
        const stored = kv.store["gallery:order:v1"] as { keys: string[] };
        expect(stored.keys).toEqual(["drive:alpha", "drive:charlie", "drive:bravo"]);
    });

    it("normalizes bare Drive ids to tile keys", async () => {
        // A hand-written curl body naturally uses plain ids; accepting them keeps
        // that from silently matching nothing.
        const kv = makeKv({ "gallery:manifest:v1": manifestWithThree() });
        const res = await call("PUT", "/manage/gallery/order", { ids: ["alpha"] }, await officerToken(), {
            EVENTS_KV: kv,
        }).res;

        expect(res.status).toBe(200);
        const stored = kv.store["gallery:order:v1"] as { keys: string[] };
        expect(stored.keys).toEqual(["drive:alpha"]);
    });

    it("accepts a curated key it has no entry for", async () => {
        // The browser owns the curated half, so the Worker must store the key
        // without complaining even though it cannot sort anything with it.
        const kv = makeKv({ "gallery:manifest:v1": manifestWithThree() });
        const res = await call(
            "PUT",
            "/manage/gallery/order",
            { keys: ["site:/images/x.webp", "drive:alpha"] },
            await officerToken(),
            { EVENTS_KV: kv },
        ).res;

        expect(res.status).toBe(200);
        const stored = kv.store["gallery:order:v1"] as { keys: string[] };
        expect(stored.keys).toEqual(["site:/images/x.webp", "drive:alpha"]);
    });

    it("re-sorts the manifest so the page reflects it immediately", async () => {
        const kv = makeKv({ "gallery:manifest:v1": manifestWithThree() });
        await (
            await call("PUT", "/manage/gallery/order", { ids: ["alpha", "charlie", "bravo"] }, await officerToken(), {
                EVENTS_KV: kv,
            })
        ).res;

        const stored = kv.store["gallery:manifest:v1"] as { entries: { id: string }[] };
        expect(stored.entries.map((e) => e.id)).toEqual(["alpha", "charlie", "bravo"]);
    });

    it("accepts a partial list, appending the unlisted photos", async () => {
        // Normal case: a photo was uploaded after the order was arranged.
        const kv = makeKv({ "gallery:manifest:v1": manifestWithThree() });
        const res = await call("PUT", "/manage/gallery/order", { ids: ["alpha"] }, await officerToken(), {
            EVENTS_KV: kv,
        }).res;

        expect(res.status).toBe(200);
        const stored = kv.store["gallery:manifest:v1"] as { entries: { id: string }[] };
        expect(stored.entries[0]?.id).toBe("alpha");
        expect(stored.entries).toHaveLength(3);
    });

    it("ignores an id that is not in the gallery", async () => {
        // Harmless: the stored list is not pruned, so a stale id is expected.
        const kv = makeKv({ "gallery:manifest:v1": manifestWithThree() });
        const res = await call("PUT", "/manage/gallery/order", { ids: ["gone", "alpha"] }, await officerToken(), {
            EVENTS_KV: kv,
        }).res;

        expect(res.status).toBe(200);
        const stored = kv.store["gallery:manifest:v1"] as { entries: { id: string }[] };
        expect(stored.entries[0]?.id).toBe("alpha");
    });

    it("rejects an unauthenticated request", async () => {
        const res = await call("PUT", "/manage/gallery/order", { ids: ["alpha"] }).res;
        expect(res.status).toBe(401);
    });

    it("rejects a member without the officer permission", async () => {
        const res = await call("PUT", "/manage/gallery/order", { ids: ["alpha"] }, await memberToken()).res;
        expect(res.status).toBe(403);
    });

    it("rejects a missing ids array", async () => {
        const res = await call("PUT", "/manage/gallery/order", {}, await officerToken()).res;
        expect(res.status).toBe(400);
    });

    it("rejects a non-array ids value", async () => {
        const res = await call("PUT", "/manage/gallery/order", { ids: "alpha" }, await officerToken()).res;
        expect(res.status).toBe(400);
    });

    it("rejects a non-string entry rather than filtering it", async () => {
        // Silently dropping part of the submitted order would apply a sequence
        // the officer never saw.
        const res = await call("PUT", "/manage/gallery/order", { ids: ["alpha", 7] }, await officerToken()).res;
        expect(res.status).toBe(400);
    });

    it("404s before the first sync rather than creating an empty manifest", async () => {
        // An empty manifest would be marked fresh and blank the gallery for a
        // whole TTL.
        const kv = makeKv();
        const res = await call("PUT", "/manage/gallery/order", { ids: ["alpha"] }, await officerToken(), {
            EVENTS_KV: kv,
        }).res;

        expect(res.status).toBe(404);
        expect(kv.writes).toEqual([]);
    });

    it("is not confused with the hide endpoint's parameterized path", async () => {
        // `/manage/gallery/order` must be claimed by the exact-match table, not
        // treated as a file id by the `{id}` route. A PATCH here must 405, and a
        // correct PUT must reach the order handler.
        const patched = await call("PATCH", "/manage/gallery/order", { hidden: true }, await officerToken()).res;
        expect(patched.status).toBe(405);
    });
});

describe("advertised CORS methods", () => {
    it("includes PUT, which the preflight must allow", async () => {
        // A method missing from Access-Control-Allow-Methods fails at the
        // PREFLIGHT with a generic network error, not a 405.
        const res = await call("OPTIONS", "/manage/gallery/order").res;
        expect(res.headers.get("Access-Control-Allow-Methods") ?? "").toContain("PUT");
    });
});
