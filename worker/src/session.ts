/**
 * Stateless session tokens for the event-creation flow.
 *
 * WHY NOT A COOKIE. The site is served from `autoboat.aoe.vt.edu` while this
 * Worker answers on `*.workers.dev`. A cookie set by the Worker is therefore a
 * THIRD-PARTY cookie in every request the site makes, which Safari blocks
 * outright and Chrome is phasing out. A cookie-based session would work in the
 * browser it was tested in and fail silently for a meaningful share of users.
 * The token is instead returned to the page and sent back as
 * `Authorization: Bearer <token>`, which is not subject to cookie partitioning.
 *
 * WHY STATELESS. There is no database here, and KV writes are budgeted at
 * 1,000/day on the free tier (see the write-budget note in index.ts). A signed
 * token needs no storage, so a login costs zero KV writes.
 *
 * FORMAT. `v1.<base64url(payload-json)>.<base64url(hmac-sha256)>`, where the
 * signature covers `v1.<payload>`. The version prefix exists so a future format
 * change can reject old tokens explicitly instead of misparsing them.
 *
 * WARNING: This module is NOT an authorization decision on its own. A valid token
 * proves the bearer completed a Discord OAuth flow for this guild at some
 * point; it does not prove they still hold `MANAGE_EVENTS`. Permissions are
 * re-checked when a token is issued, and the token is short-lived (see
 * `SESSION_TTL_SECONDS`) so a revoked role takes effect within that window.
 * Do not lengthen the TTL without deciding how much staleness is acceptable.
 *
 * Deliberately takes the secret as an argument rather than reading `env`, so
 * every function here is pure and unit-testable without Cloudflare's ambient
 * types.
 */

/** Token version prefix. Bump when the payload shape or signing input changes. */
const TOKEN_VERSION = "v1";

/**
 * How long a session stays valid.
 *
 * Two hours is a deliberate compromise: long enough that an officer scheduling
 * a batch of meetings does not get logged out mid-task, short enough that
 * losing `MANAGE_EVENTS` or leaving the server takes effect the same day. The
 * website re-runs the OAuth flow when the token expires, which is one click.
 */
export const SESSION_TTL_SECONDS = 2 * 60 * 60;

/** How long an in-flight OAuth authorization may take before its state expires. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** What a verified session asserts. */
export interface SessionPayload {
    /** Discord user id. */
    sub: string;
    /** Display name, for the UI. Discord's `global_name` when set, else username. */
    name: string;
    /** Epoch SECONDS at which this token stops being valid. */
    exp: number;
    /**
     * Whether this user may create events at all.
     *
     * Only officers may, which is decided by `MANAGE_EVENTS` (see
     * permissions.ts) and resolved once at login. Re-reading it from Discord on
     * every write would add an API call per create for a value that changes at
     * most when someone's role does, and the token's TTL bounds the staleness.
     *
     * WARNING: Signed, so it cannot be forged, but it is a POINT-IN-TIME claim. A
     * user demoted mid-session keeps this flag until their token expires (two
     * hours). That is the documented trade -- see the TTL note above.
     */
    canCreateEvents: boolean;
}

/** Result of verifying a token: the payload, or why it was rejected. */
export type VerifyResult = { ok: true; payload: SessionPayload } | { ok: false; reason: string };

/** Generic signed payload, used for the OAuth `state` parameter too. */
export type SignedPayload = Record<string, unknown>;

function base64UrlEncode(bytes: Uint8Array): string {
    // Chunked so a large payload cannot blow the argument limit of
    // `String.fromCharCode`. Tokens here are tiny, but the helper is shared.
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

const encoder = new TextEncoder();

/** Import the HMAC key once per call -- Web Crypto keys are cheap here. */
async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
    ]);
}

async function sign(secret: string, signingInput: string): Promise<Uint8Array> {
    const key = await hmacKey(secret);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
    return new Uint8Array(signature);
}

/**
 * Compare two byte strings in constant time.
 *
 * WARNING: Do NOT replace this with `a === b` on the base64 strings. String
 * comparison short-circuits at the first differing byte, which leaks how much
 * of a guessed signature matched. The length check is allowed to be early
 * because the signature length is public.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        // `?? 0` satisfies noUncheckedIndexedAccess; the lengths already match.
        diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
}

/**
 * Sign an arbitrary JSON payload into a compact token.
 *
 * Exported because the OAuth `state` parameter uses the same envelope. Keeping
 * one implementation means the state and the session can never diverge on
 * canonicalization or base64 handling.
 */
export async function signPayload(secret: string, payload: SignedPayload): Promise<string> {
    const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
    const signingInput = `${TOKEN_VERSION}.${body}`;
    const signature = base64UrlEncode(await sign(secret, signingInput));
    return `${signingInput}.${signature}`;
}

/**
 * Verify a token's signature and return its payload (still unvalidated --
 * callers check `exp` and their own required fields).
 *
 * Returns `null` for anything malformed. Expiry is NOT checked here because
 * the different token kinds have different rules and clocks; see
 * `verifySession` and `verifyOAuthState`.
 */
export async function verifySignedPayload(secret: string, token: string): Promise<SignedPayload | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [version, body, signature] = parts;
    if (version !== TOKEN_VERSION || !body || !signature) return null;

    let expected: Uint8Array;
    let actual: Uint8Array;
    try {
        expected = await sign(secret, `${version}.${body}`);
        actual = base64UrlDecode(signature);
    } catch {
        // `atob` throws on a non-base64 signature.
        return null;
    }
    if (!timingSafeEqual(expected, actual)) return null;

    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        return parsed as SignedPayload;
    } catch {
        return null;
    }
}

/** Mint a session token for a Discord user. */
export async function createSession(
    secret: string,
    user: { id: string; name: string; canCreateEvents?: boolean },
    now: Date = new Date(),
): Promise<{ token: string; payload: SessionPayload }> {
    const payload: SessionPayload = {
        sub: user.id,
        name: user.name,
        exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
        // Absent means false: a caller that does not compute the flag must not
        // accidentally grant write access. This is the fail-CLOSED default.
        canCreateEvents: user.canCreateEvents === true,
    };
    return { token: await signPayload(secret, payload as unknown as SignedPayload), payload };
}

/**
 * Verify a session token's signature and expiry.
 *
 * A missing/empty secret always fails: an unset `SESSION_SECRET` must not
 * degrade into "any token verifies", which an HMAC keyed on `""` would do.
 */
export async function verifySession(
    secret: string | undefined,
    token: string | null | undefined,
    now: Date = new Date(),
): Promise<VerifyResult> {
    if (!secret) return { ok: false, reason: "session secret not configured" };
    if (!token) return { ok: false, reason: "missing token" };
    const payload = await verifySignedPayload(secret, token);
    if (!payload) return { ok: false, reason: "invalid token" };

    const sub = payload.sub;
    const name = payload.name;
    const exp = payload.exp;
    if (typeof sub !== "string" || !sub) return { ok: false, reason: "invalid token" };
    if (typeof name !== "string") return { ok: false, reason: "invalid token" };
    if (typeof exp !== "number" || !Number.isFinite(exp)) return { ok: false, reason: "invalid token" };

    if (exp * 1000 <= now.getTime()) return { ok: false, reason: "expired token" };
    return {
        ok: true,
        payload: {
            sub,
            name,
            exp,
            // Strict `=== true`: a token minted before this field existed must
            // degrade to "no write access" rather than inheriting a truthy
            // default.
            canCreateEvents: payload.canCreateEvents === true,
        },
    };
}

/** Extract the bearer token from an `Authorization` header, or null. */
export function bearerToken(header: string | null): string | null {
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() || null;
}
