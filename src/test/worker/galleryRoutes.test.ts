/**
 * @jest-environment node
 *
 * Route-level tests for the gallery endpoints.
 *
 * These drive the real `fetch` handler because the failure that matters is
 * WIRING: an upload endpoint reachable without a valid session. The Drive write
 * uses the SERVICE ACCOUNT's credentials, so Google enforces nothing about the
 * caller -- the session check is the only gate, exactly as with event creation
 * (see permissions.ts). A fail-open here lets anyone publish a photo to the
 * team's public site.
 *
 * The OAuth tests cover the return path added for the gallery: Discord requires
 * one fixed redirect URI, so the destination rides in the signed state. That
 * makes it an open-redirect candidate if the allowlist is ever loosened.
 */

import worker from "../../../worker/src/index";
import { createSession, signPayload } from "../../../worker/src/session";

const SECRET = "test-session-secret";
const GUILD = "1017960606403416085";
const PROD_ORIGIN = "https://autoboat.aoe.vt.edu";

const ENV = {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: GUILD,
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
    GALLERY_SYNC_TOKEN: "sync-token",
};

/** KV stub. */
function makeKv(store: Record<string, unknown> = {}) {
    return {
        store,
        async get(key: string) {
            return key in store ? store[key] : null;
        },
        async put(key: string, value: string) {
            store[key] = JSON.parse(value);
        },
    };
}

/** R2 stub: enough of the API for the mirror and the delete sweep. */
function makeBucket(objects: Record<string, { body: string; contentType: string }> = {}) {
    const deleted: string[] = [];
    return {
        objects,
        deleted,
        async get(key: string) {
            const found = objects[key];
            if (!found) return null;
            return {
                body: found.body,
                httpEtag: `"${key}"`,
                writeHttpMetadata(headers: Headers) {
                    headers.set("Content-Type", found.contentType);
                    headers.set("Cache-Control", "public, max-age=31536000, immutable");
                },
            };
        },
        async put(key: string, _value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
            objects[key] = { body: "bytes", contentType: options?.httpMetadata?.contentType ?? "" };
        },
        async delete(key: string) {
            deleted.push(key);
            delete objects[key];
        },
        async list() {
            return { objects: Object.keys(objects).map((key) => ({ key })), truncated: false, cursor: undefined };
        },
    };
}

function makeCtx() {
    const promises: Promise<unknown>[] = [];
    return {
        ctx: {
            waitUntil: (p: Promise<unknown>) => {
                promises.push(p);
            },
            passThroughOnException: () => {},
        },
        promises,
    };
}

/**
 * The Worker's fetch handler, widened for tests.
 *
 * WARNING: Typed through `unknown`, not `any` -- the real signature demands the
 * full Cloudflare `Env` (bindings are structural interfaces with dozens of
 * members), and a stub env is deliberately not that. A single named cast keeps
 * the escape hatch in one place instead of repeating `as any` at every call
 * site, and lint rejects the latter.
 */
const fetchWorker = worker.fetch as unknown as (
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void },
) => Promise<Response>;

async function call(
    path: string,
    method = "GET",
    options: { token?: string; body?: unknown; env?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
    const env = { ...ENV, EVENTS_KV: makeKv(), GALLERY_BUCKET: makeBucket(), ...options.env };
    const { ctx } = makeCtx();
    const headers: Record<string, string> = { Origin: PROD_ORIGIN, ...options.headers };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const request = new Request(`https://worker.example${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const res = await fetchWorker(request, env, ctx);
    return { res, env };
}

async function officerToken() {
    return (await createSession(SECRET, { id: "1", name: "Officer", canCreateEvents: true })).token;
}

async function memberToken() {
    return (await createSession(SECRET, { id: "2", name: "Member", canCreateEvents: false })).token;
}

describe("GET /gallery", () => {
    it("serves an empty manifest when nothing has synced", async () => {
        const { res } = await call("/gallery");
        expect(res.status).toBe(200);
        const body = (await res.json()) as { images: unknown[]; syncedAt: unknown };
        expect(body.images).toEqual([]);
        expect(body.syncedAt).toBeNull();
    });

    it("is readable without a session", async () => {
        // The gallery is public; only the upload is gated.
        const { res } = await call("/gallery");
        expect(res.status).toBe(200);
    });

    it("only reports images whose bytes are mirrored", async () => {
        // An advertised image the bucket does not hold renders as a broken
        // tile, so the manifest must not mention it.
        const manifest = {
            syncedAt: Date.now(),
            entries: [
                { id: "ready", name: "r.jpg", key: "gallery/ready", mirroredAt: 1 },
                { id: "pending", name: "p.jpg", key: "gallery/pending", mirroredAt: null },
            ],
            pending: ["pending"],
            warning: "1 image still copying.",
        };
        const { res } = await call("/gallery", "GET", {
            env: { EVENTS_KV: makeKv({ "gallery:manifest:v1": manifest }) },
        });
        const body = (await res.json()) as { images: { id: string }[]; pending: number };
        expect(body.images.map((i) => i.id)).toEqual(["ready"]);
        expect(body.pending).toBe(1);
    });

    it("returns 503 when Drive is not configured, rather than pretending it is empty", async () => {
        // An empty 200 reads as "all the photos are gone".
        const { res } = await call("/gallery", "GET", {
            env: { DRIVE_GALLERY_FOLDER_ID: "", GOOGLE_SERVICE_ACCOUNT_EMAIL: "", GOOGLE_PRIVATE_KEY: "" },
        });
        expect(res.status).toBe(503);
    });

    it("names the missing configuration value", async () => {
        const { res } = await call("/gallery", "GET", { env: { DRIVE_GALLERY_FOLDER_ID: "" } });
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("DRIVE_GALLERY_FOLDER_ID");
    });
});

describe("GET /gallery/image/:id", () => {
    it("serves a mirrored image with its stored content type", async () => {
        const bucket = makeBucket({ "gallery/filed-1": { body: "jpegbytes", contentType: "image/jpeg" } });
        const { res } = await call("/gallery/image/filed-1", "GET", { env: { GALLERY_BUCKET: bucket } });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    });

    it("is immutable-cacheable, since the key is a Drive id", async () => {
        const bucket = makeBucket({ "gallery/filed-1": { body: "x", contentType: "image/png" } });
        const { res } = await call("/gallery/image/filed-1", "GET", { env: { GALLERY_BUCKET: bucket } });
        expect(res.headers.get("Cache-Control")).toContain("immutable");
    });

    it("404s for an image that has not been mirrored", async () => {
        const { res } = await call("/gallery/image/nothere-1", "GET");
        expect(res.status).toBe(404);
    });

    it("404s a malformed id instead of treating it as a key", async () => {
        // R2 keys are flat strings, so an unvalidated suffix could address a
        // different object. The id is validated as part of route matching.
        const { res } = await call("/gallery/image/..%2Fsecret", "GET");
        expect(res.status).toBe(404);
    });

    it("does not require a session", async () => {
        const bucket = makeBucket({ "gallery/filed-1": { body: "x", contentType: "image/png" } });
        const { res } = await call("/gallery/image/filed-1", "GET", { env: { GALLERY_BUCKET: bucket } });
        expect(res.status).toBe(200);
    });

    it("is a READ route, so it must not advertise write methods", async () => {
        // Widening this to the management header set would advertise POST and
        // an Authorization header on a public image endpoint, and would make
        // the browser preflight every image.
        const res = await call("/gallery/image/filed-1", "OPTIONS");
        expect(res.res.status).toBe(204);
        expect(res.res.headers.get("Access-Control-Allow-Methods") ?? "").not.toContain("POST");
    });
});

describe("POST /manage/gallery", () => {
    /**
     * A minimal multipart body, as the browser would build it.
     *
     * NOTE: the bytes are wrapped in a fresh `ArrayBuffer` slice because
     * `Uint8Array<ArrayBufferLike>` is not assignable to `BlobPart` -- a
     * `Uint8Array` can be backed by a `SharedArrayBuffer`, which `Blob` cannot
     * accept. Copying gives it a concrete `ArrayBuffer`.
     */
    function multipart(file: { name: string; type: string; bytes: Uint8Array }) {
        const form = new FormData();
        const copy = new Uint8Array(file.bytes).buffer;
        form.append("file", new File([copy], file.name, { type: file.type }));
        return form;
    }

    async function upload(options: { token?: string; file?: { name: string; type: string; bytes: Uint8Array } }) {
        const env = { ...ENV, EVENTS_KV: makeKv(), GALLERY_BUCKET: makeBucket() };
        const { ctx } = makeCtx();
        const headers: Record<string, string> = { Origin: PROD_ORIGIN };
        if (options.token) headers.Authorization = `Bearer ${options.token}`;
        const request = new Request("https://worker.example/manage/gallery", {
            method: "POST",
            headers,
            body: multipart(options.file ?? { name: "boat.jpg", type: "image/jpeg", bytes: JPEG }),
        });
        return fetchWorker(request, env, ctx);
    }

    /** A minimal valid JPEG header. */
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    it("rejects an unauthenticated upload", async () => {
        // THE CRITICAL TEST. The Drive write uses the service account, so
        // Discord enforces nothing -- this check is the whole gate.
        const res = await upload({});
        expect(res.status).toBe(401);
    });

    it("rejects a forged token", async () => {
        const res = await upload({
            token: await createSession("wrong-secret", { id: "1", name: "X", canCreateEvents: true }).then(
                (s) => s.token,
            ),
        });
        expect(res.status).toBe(401);
    });

    it("rejects a member without the officer permission", async () => {
        const res = await upload({ token: await memberToken() });
        expect(res.status).toBe(403);
    });

    it("rejects an expired session", async () => {
        const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
        const { token } = await createSession(SECRET, { id: "1", name: "Officer", canCreateEvents: true }, past);
        const res = await upload({ token });
        expect(res.status).toBe(401);
    });

    it("rejects a body that is not multipart", async () => {
        const env = { ...ENV, EVENTS_KV: makeKv(), GALLERY_BUCKET: makeBucket() };
        const { ctx } = makeCtx();
        const request = new Request("https://worker.example/manage/gallery", {
            method: "POST",
            headers: { Authorization: `Bearer ${await officerToken()}`, "Content-Type": "application/json" },
            body: JSON.stringify({ file: "nope" }),
        });
        const res = await fetchWorker(request, env, ctx);
        expect(res.status).toBe(400);
    });

    it("rejects a file whose bytes are not an image, even under an image name", async () => {
        // The declared type is the OS's guess at the extension, so the bytes
        // get the final say.
        const res = await upload({
            token: await officerToken(),
            file: {
                name: "fake.jpg",
                type: "image/jpeg",
                bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]),
            },
        });
        expect(res.status).toBe(400);
    });

    it("explains a HEIC rejection instead of failing generically", async () => {
        const heic = new Uint8Array(32);
        heic.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70], 0);
        heic.set([0x68, 0x65, 0x69, 0x63], 8); // "heic"
        const res = await upload({
            token: await officerToken(),
            file: { name: "IMG_1.heic", type: "image/heic", bytes: heic },
        });
        const body = (await res.json()) as { error: string };
        expect(res.status).toBe(400);
        expect(body.error).toContain("HEIC");
    });

    it("returns 503 when Drive is not configured, after the session check", async () => {
        const env = { ...ENV, EVENTS_KV: makeKv(), GALLERY_BUCKET: makeBucket(), DRIVE_GALLERY_FOLDER_ID: "" };
        const { ctx } = makeCtx();
        const request = new Request("https://worker.example/manage/gallery", {
            method: "POST",
            headers: { Authorization: `Bearer ${await officerToken()}`, Origin: PROD_ORIGIN },
            body: multipart({ name: "boat.jpg", type: "image/jpeg", bytes: JPEG }),
        });
        const res = await fetchWorker(request, env, ctx);
        expect(res.status).toBe(503);
    });

    it("still refuses a non-officer even when Drive is unconfigured", async () => {
        // The session check must run FIRST, so configuration state cannot be
        // used to probe the endpoint.
        const env = { ...ENV, EVENTS_KV: makeKv(), GALLERY_BUCKET: makeBucket(), DRIVE_GALLERY_FOLDER_ID: "" };
        const { ctx } = makeCtx();
        const request = new Request("https://worker.example/manage/gallery", {
            method: "POST",
            headers: { Authorization: `Bearer ${await memberToken()}`, Origin: PROD_ORIGIN },
            body: multipart({ name: "boat.jpg", type: "image/jpeg", bytes: JPEG }),
        });
        const res = await fetchWorker(request, env, ctx);
        expect(res.status).toBe(403);
    });
});

describe("POST /manage/gallery/sync", () => {
    it("is disabled when no token is configured", async () => {
        const { res } = await call("/manage/gallery/sync", "POST", { env: { GALLERY_SYNC_TOKEN: "" } });
        expect(res.status).toBe(503);
    });

    it("rejects a wrong token", async () => {
        const { res } = await call("/manage/gallery/sync", "POST", { token: "wrong" });
        expect(res.status).toBe(401);
    });

    it("rejects a request with no token", async () => {
        const { res } = await call("/manage/gallery/sync", "POST");
        expect(res.status).toBe(401);
    });
});

describe("auth return path", () => {
    it("accepts an allowlisted return path", async () => {
        const { res } = await call("/manage/auth/url?return=/gallery/");
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string };
        expect(body.url).toContain("discord.com/oauth2/authorize");
        // The redirect URI itself must remain the single registered value.
        expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(`${PROD_ORIGIN}/calendar/`);
    });

    it("normalizes a bare path to the allowlisted form", async () => {
        const { res } = await call("/manage/auth/url?return=/gallery");
        const body = (await res.json()) as { url: string };
        const state = new URL(body.url).searchParams.get("state") as string;
        const payload = JSON.parse(
            atob(state.split(".")[1] as string)
                .replace(/-/g, "+")
                .replace(/_/g, "/"),
        );
        expect(payload.ret).toBe("/gallery/");
    });

    it("refuses an off-site return path, preventing an open redirect", async () => {
        // Without the allowlist this would be a phishing primitive: sign in
        // with Discord, then land wherever the attacker pointed.
        const { res } = await call("/manage/auth/url?return=https://evil.example/steal");
        const body = (await res.json()) as { url: string };
        const state = new URL(body.url).searchParams.get("state") as string;
        const payload = JSON.parse(
            atob(state.split(".")[1] as string)
                .replace(/-/g, "+")
                .replace(/_/g, "/"),
        );
        expect(payload.ret).toBe("/calendar/");
    });

    it("refuses a protocol-relative return path", async () => {
        const { res } = await call("/manage/auth/url?return=//evil.example");
        const body = (await res.json()) as { url: string };
        const state = new URL(body.url).searchParams.get("state") as string;
        const payload = JSON.parse(
            atob(state.split(".")[1] as string)
                .replace(/-/g, "+")
                .replace(/_/g, "/"),
        );
        expect(payload.ret).toBe("/calendar/");
    });

    it("defaults to the calendar when no return path is given", async () => {
        const { res } = await call("/manage/auth/url");
        const body = (await res.json()) as { url: string };
        const state = new URL(body.url).searchParams.get("state") as string;
        const payload = JSON.parse(
            atob(state.split(".")[1] as string)
                .replace(/-/g, "+")
                .replace(/_/g, "/"),
        );
        expect(payload.ret).toBe("/calendar/");
    });

    it("ignores a tampered return path in the state", async () => {
        // The state is signed, so a rewritten `ret` fails verification rather
        // than redirecting somewhere new.
        const forged = await signPayload(SECRET, {
            n: "x",
            exp: Math.floor(Date.now() / 1000) + 600,
            purpose: "oauth-state",
            ret: "/gallery/",
        });
        const tampered = `${forged.slice(0, forged.lastIndexOf("."))}.AAAA`;
        const { res } = await call("/manage/auth/callback", "POST", {
            body: { code: "the-code", state: tampered },
        });
        expect(res.status).toBe(400);
    });
});
