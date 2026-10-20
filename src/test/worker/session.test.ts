/**
 * @jest-environment node
 *
 * `session.ts` relies on Web Crypto (`crypto.subtle`), which jsdom does not
 * provide; the node environment does.
 */

import {
    bearerToken,
    createSession,
    OAUTH_STATE_TTL_SECONDS,
    signPayload,
    verifySession,
    verifySignedPayload,
} from "../../../worker/src/session";

const SECRET = "test-secret-not-a-real-key";
const OTHER_SECRET = "a-different-secret";

/** Fixed clock so expiry assertions cannot flake on a slow CI machine. */
const NOW = new Date("2026-10-20T12:00:00.000Z");

describe("createSession / verifySession", () => {
    it("round-trips a user through a signed token", async () => {
        const { token } = await createSession(SECRET, { id: "42", name: "Ada", canCreateEvents: true }, NOW);
        const result = await verifySession(SECRET, token, NOW);
        expect(result).toEqual({
            ok: true,
            payload: { sub: "42", name: "Ada", exp: expect.any(Number), canCreateEvents: true },
        });
    });

    it("rejects a token signed with a different secret", async () => {
        const { token } = await createSession(SECRET, { id: "42", name: "Ada" }, NOW);
        expect(await verifySession(OTHER_SECRET, token, NOW)).toEqual({ ok: false, reason: "invalid token" });
    });

    it("rejects a token whose payload was tampered with", async () => {
        const { token } = await createSession(SECRET, { id: "42", name: "Ada" }, NOW);
        const [version, , signature] = token.split(".");
        // Re-encode a payload claiming officer rights, keep the original sig.
        const forgedBody = btoa(JSON.stringify({ sub: "42", name: "Ada", exp: 9999999999, canCreateEvents: true }))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        expect(await verifySession(SECRET, `${version}.${forgedBody}.${signature}`, NOW)).toEqual({
            ok: false,
            reason: "invalid token",
        });
    });

    it("rejects an expired token", async () => {
        const { token } = await createSession(SECRET, { id: "42", name: "Ada" }, NOW);
        const later = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
        expect(await verifySession(SECRET, token, later)).toEqual({ ok: false, reason: "expired token" });
    });

    it("treats a token as valid right up to its expiry", async () => {
        const { token, payload } = await createSession(SECRET, { id: "42", name: "Ada" }, NOW);
        const justBefore = new Date(payload.exp * 1000 - 1);
        expect((await verifySession(SECRET, token, justBefore)).ok).toBe(true);
    });

    it("fails closed when no secret is configured", async () => {
        const { token } = await createSession(SECRET, { id: "42", name: "Ada" }, NOW);
        // An unset secret must never behave like an HMAC keyed on "".
        expect(await verifySession(undefined, token, NOW)).toEqual({
            ok: false,
            reason: "session secret not configured",
        });
        expect(await verifySession("", token, NOW)).toEqual({ ok: false, reason: "session secret not configured" });
    });

    it("rejects missing, malformed, and non-base64 tokens", async () => {
        expect((await verifySession(SECRET, null, NOW)).ok).toBe(false);
        expect((await verifySession(SECRET, "", NOW)).ok).toBe(false);
        expect((await verifySession(SECRET, "not-a-token", NOW)).ok).toBe(false);
        expect((await verifySession(SECRET, "v1.abc.!!!", NOW)).ok).toBe(false);
        expect((await verifySession(SECRET, "v2.abc.def", NOW)).ok).toBe(false);
    });

    it("defaults canCreateEvents to false when the caller omits it", async () => {
        const { token } = await createSession(SECRET, { id: "42", name: "Ada" }, NOW);
        const result = await verifySession(SECRET, token, NOW);
        expect(result.ok && result.payload.canCreateEvents).toBe(false);
    });

    it("downgrades a token with no canCreateEvents claim to false", async () => {
        // Simulates a token minted before the field existed.
        const token = await signPayload(SECRET, {
            sub: "42",
            name: "Ada",
            exp: Math.floor(NOW.getTime() / 1000) + 60,
        });
        const result = await verifySession(SECRET, token, NOW);
        expect(result.ok && result.payload.canCreateEvents).toBe(false);
    });
});

describe("signPayload / verifySignedPayload", () => {
    it("round-trips arbitrary JSON", async () => {
        const token = await signPayload(SECRET, { purpose: "oauth-state", n: "abc", exp: 123 });
        expect(await verifySignedPayload(SECRET, token)).toEqual({ purpose: "oauth-state", n: "abc", exp: 123 });
    });

    it("returns null for a non-object payload", async () => {
        // Hand-build a token whose body is a JSON array.
        const body = btoa(JSON.stringify([1, 2, 3])).replace(/=+$/, "");
        const { signPayload: sign } = await import("../../../worker/src/session");
        const payloadToken = await sign(SECRET, { ok: true });
        const signature = payloadToken.split(".")[2];
        expect(await verifySignedPayload(SECRET, `v1.${body}.${signature}`)).toBeNull();
    });

    it("produces a different signature for a different secret", async () => {
        const a = await signPayload(SECRET, { n: "same" });
        const b = await signPayload(OTHER_SECRET, { n: "same" });
        expect(a).not.toBe(b);
        expect(await verifySignedPayload(SECRET, b)).toBeNull();
    });
});

describe("bearerToken", () => {
    it.each([
        ["Bearer abc123", "abc123"],
        ["bearer abc123", "abc123"],
        ["BEARER   abc123  ", "abc123"],
    ])("extracts the token from %p", (header, expected) => {
        expect(bearerToken(header)).toBe(expected);
    });

    it.each([null, "", "Basic abc", "Bearer", "abc123"])("returns null for %p", (header) => {
        expect(bearerToken(header)).toBeNull();
    });
});

describe("OAUTH_STATE_TTL_SECONDS", () => {
    it("is short enough that a stale state cannot linger", () => {
        expect(OAUTH_STATE_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    });
});
