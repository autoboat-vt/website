/**
 * Google service-account authentication for the gallery's Drive integration.
 *
 * WHY A SERVICE ACCOUNT AND NOT THE OFFICER'S GOOGLE LOGIN. The gallery is
 * PUBLIC: a visitor loading /gallery has no Google account, and the Worker must
 * read the Drive folder on its own authority. A service account is the
 * two-legged ("2LO") credential for exactly that -- no user is involved.
 *
 * WARNING: A service account has NO OWN STORAGE QUOTA. It can read a folder that
 * was shared with it, but it cannot create files inside someone's personal
 * "My Drive" -- Google rejects the upload with a quota error. Uploads therefore
 * need one of:
 *
 *   1. a **Shared Drive** (Workspace), where the drive owns the bytes, or
 *   2. **domain-wide delegation** (`GOOGLE_IMPERSONATE_EMAIL`), where the upload
 *      is attributed to a real Workspace user and counts against their quota.
 *
 * Set `GOOGLE_IMPERSONATE_EMAIL` for path 2. Both are documented in
 * worker/README.md.
 *
 * WHY JWT INSTEAD OF A CLIENT LIBRARY. The Drive API does not accept a raw JWT
 * as a bearer token, so the assertion is exchanged at Google's token endpoint
 * for an access token. That is one signed request plus one HTTP round trip, and
 * doing it with Web Crypto keeps the Worker dependency-free -- the Node Google
 * libraries assume Node built-ins and a filesystem the Workers runtime lacks.
 *
 * Deliberately takes its configuration as arguments rather than reading `env`,
 * so the signing input and the claim set are unit-testable with a throwaway
 * key. `index.ts` owns the bindings.
 */

/** OAuth token endpoint for the JWT bearer grant. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Scopes requested for the gallery.
 *
 * `drive.readonly` is what makes the folder LISTABLE: officers upload through
 * the normal Drive UI, and those files belong to the human, not to the app.
 *
 * `drive.file` is what allows the app to CREATE files (an upload from the
 * website). Requesting both grants the union: read anything the account can
 * see, write only files the app itself created.
 *
 * WARNING: `drive.file` alone cannot see a file a person uploaded, so narrowing to
 * it would make the gallery silently empty. The full `drive` scope would also
 * work but grants write access over every file the account can reach -- do not
 * widen to it without a reason.
 */
export const DRIVE_SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
] as const;

/** Everything needed to mint an access token. */
export interface ServiceAccountConfig {
    /** The `client_email` from the service-account JSON key. */
    clientEmail: string;
    /** The PEM-encoded `private_key` from the same file. */
    privateKeyPem: string;
    /**
     * Optional Workspace user to act as (domain-wide delegation).
     *
     * Required when the gallery folder lives in a person's My Drive, because a
     * service account cannot own uploads there. Leave unset for a Shared Drive.
     */
    impersonate?: string;
    /** Scopes to request. Defaults to `DRIVE_SCOPES`. */
    scopes?: readonly string[];
}

/** An access token plus the instant it stops being usable. */
export interface AccessToken {
    token: string;
    /** Epoch milliseconds. */
    expiresAt: number;
}

const encoder = new TextEncoder();

/**
 * base64url-encode bytes.
 *
 * WARNING: This is the unpadded URL-safe alphabet the JWT spec requires, NOT
 * plain base64. A `/` or `+` left in the signature makes Google reject the
 * assertion with `invalid_grant`, which reads like a bad key rather than bad
 * encoding.
 */
function base64UrlEncode(bytes: Uint8Array): string {
    let binary = "";
    // Chunked so a large argument list cannot blow `String.fromCharCode`'s
    // limit. Signatures are small, but the helper is shared with the header.
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a PEM private key into the raw PKCS#8 bytes Web Crypto imports.
 *
 * Accepts the escaped form that survives an environment variable: the JSON key
 * file contains literal newlines, but `wrangler secret put` and `.dev.vars`
 * store it with `\n` two-character escapes. Both are normalized here so the
 * operator does not have to know which form their secret ended up in.
 */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
    const normalized = pem.replace(/\\n/g, "\n");
    const body = normalized
        .replace(/-----BEGIN [^-]+-----/, "")
        .replace(/-----END [^-]+-----/, "")
        // Any remaining whitespace is line wrapping, not data.
        .replace(/\s+/g, "");
    if (!body) {
        throw new Error("private key is empty");
    }
    const binary = atob(body);
    // WARNING: Backed by a concrete `ArrayBuffer`, not `ArrayBufferLike`. Web
    // Crypto's `BufferSource` rejects a `SharedArrayBuffer`-backed view, and a
    // bare `Uint8Array` widens to exactly that in TS 5.7+.
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** Import a PEM private key for RS256 signing. */
export async function importSigningKey(pem: string): Promise<CryptoKey> {
    return crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "sign",
    ]);
}

/**
 * Build the signed JWT assertion the token endpoint accepts.
 *
 * Claims are the minimum Google requires:
 *  - `iss` is the service account's email (NOT the project id).
 *  - `aud` is the token endpoint itself, not the API being called.
 *  - `scope` is SPACE-separated. A comma-separated list is silently read as one
 *    nonsense scope and fails with `invalid_scope`.
 *  - `exp` must be within 60 minutes of `iat`; 55 minutes leaves room for clock
 *    skew without tripping the "short-lived token" rejection.
 *  - `sub` is the impersonated user, and is present ONLY for delegation.
 *
 * Exported so a test can decode the payload and assert the claims directly --
 * that is the part most likely to be wrong and least likely to be obvious from
 * a network error.
 */
export async function buildAssertion(
    config: ServiceAccountConfig,
    key: CryptoKey,
    now: Date = new Date(),
): Promise<string> {
    const iat = Math.floor(now.getTime() / 1000);
    const claims: Record<string, unknown> = {
        iss: config.clientEmail,
        scope: (config.scopes ?? DRIVE_SCOPES).join(" "),
        aud: GOOGLE_TOKEN_URL,
        exp: iat + 55 * 60,
        iat,
    };
    // Only present for domain-wide delegation. Sending an empty string would
    // ask Google to impersonate nobody and be rejected.
    if (config.impersonate) claims.sub = config.impersonate;

    const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Cached access token, keyed by the identity and scopes it was minted for.
 *
 * WHY MODULE SCOPE IS ACCEPTABLE HERE. This is a shared CREDENTIAL, not
 * per-request state: it carries no user identity and every caller with the same
 * config gets the same value, so there is no way for one request's data to leak
 * into another's. Without it, syncing ten images would mint ten tokens (ten
 * signing operations and ten round trips) for one 55-minute credential.
 *
 * The cache is per isolate, so a fresh isolate simply mints a new token --
 * correctness does not depend on the cache being warm.
 */
let cachedToken: { fingerprint: string; value: AccessToken } | null = null;

/** Drop the cached token. Used by tests, and after a 401 from Google. */
export function clearTokenCache(): void {
    cachedToken = null;
}

function fingerprintOf(config: ServiceAccountConfig): string {
    // Scopes and impersonation change what the token grants, so they must be
    // part of the key -- otherwise a widened scope silently reuses a token that
    // does not carry it.
    return [config.clientEmail, config.impersonate ?? "", (config.scopes ?? DRIVE_SCOPES).join(",")].join("|");
}

/**
 * Mint (or reuse) an access token for the service account.
 *
 * Throws on any failure; the caller decides how to report it. Errors never
 * include the assertion or the private key.
 */
export async function getAccessToken(config: ServiceAccountConfig, now: Date = new Date()): Promise<string> {
    const fingerprint = fingerprintOf(config);
    // A minute of slack so a token cannot expire mid-flight between two Drive
    // calls in the same sync.
    if (
        cachedToken &&
        cachedToken.fingerprint === fingerprint &&
        cachedToken.value.expiresAt - 60_000 > now.getTime()
    ) {
        return cachedToken.value.token;
    }

    const key = await importSigningKey(config.privateKeyPem);
    const assertion = await buildAssertion(config, key, now);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let body: unknown;
    try {
        const res = await fetch(GOOGLE_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion,
            }).toString(),
            signal: controller.signal,
        });
        if (!res.ok) {
            // Status only. The response body can echo the assertion on some
            // errors, and that is a signature over the account's identity.
            throw new Error(`Google rejected the service account credentials (${res.status}).`);
        }
        body = await res.json();
    } finally {
        clearTimeout(timer);
    }

    const parsed = parseTokenResponse(body, now);
    if (!parsed) throw new Error("Google returned an unusable token response.");
    cachedToken = { fingerprint, value: parsed };
    return parsed.token;
}

/**
 * Parse `{ access_token, expires_in }` into a token with a deadline.
 *
 * `expires_in` is seconds and is occasionally absent on non-standard responses;
 * falling back to Google's documented 3600 keeps the cache conservative rather
 * than treating the token as already expired (which would mint one per call).
 */
export function parseTokenResponse(data: unknown, now: Date = new Date()): AccessToken | null {
    if (typeof data !== "object" || data === null) return null;
    const body = data as Record<string, unknown>;
    const token = body.access_token;
    if (typeof token !== "string" || token.length === 0) return null;
    const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 3600;
    return { token, expiresAt: now.getTime() + expiresIn * 1000 };
}

/**
 * Whether the Drive integration has the configuration it needs.
 *
 * Reports which NAMES are missing, never the values -- this reaches an HTTP
 * response and the UI. `DRIVE_GALLERY_FOLDER_ID` is included because a service
 * account with perfect credentials and no folder has nothing to sync.
 */
export function missingDriveConfig(env: {
    GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
    GOOGLE_PRIVATE_KEY?: string;
    DRIVE_GALLERY_FOLDER_ID?: string;
}): string[] {
    const required = ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY", "DRIVE_GALLERY_FOLDER_ID"] as const;
    return required.filter((name) => {
        const value = env[name];
        return typeof value !== "string" || value.trim() === "";
    });
}

/** Build the config object from `env`, or null when anything is missing. */
export function serviceAccountConfigFromEnv(env: {
    GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
    GOOGLE_PRIVATE_KEY?: string;
    GOOGLE_IMPERSONATE_EMAIL?: string;
}): ServiceAccountConfig | null {
    const clientEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
    const privateKeyPem = env.GOOGLE_PRIVATE_KEY;
    if (!clientEmail || !privateKeyPem) return null;
    const impersonate = env.GOOGLE_IMPERSONATE_EMAIL?.trim();
    return {
        clientEmail,
        privateKeyPem,
        // An empty var means "no delegation", not "impersonate nobody".
        ...(impersonate ? { impersonate } : {}),
    };
}
