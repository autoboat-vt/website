/**
 * Discord OAuth2 (authorization code grant) helpers for the event-creation
 * flow. Kept pure -- URL construction and response parsing only -- so the
 * network calls stay in `index.ts` next to the other `fetch` usage, and every
 * branch here is unit-testable.
 *
 * FLOW
 *
 *   1. The browser navigates to Discord's authorize URL (built by
 *      `buildAuthorizeUrl`), carrying a signed `state`.
 *   2. Discord redirects back to `/manage/auth/callback?code=...&state=...`.
 *   3. The Worker verifies `state`, exchanges `code` for a user access token
 *      (this is the step that needs `SESSION_SECRET` -- the client secret never
 *      reaches the browser), then reads `/users/@me/guilds` with that token.
 *   4. If the user is in the guild with event-management permission, the Worker
 *      mints its OWN session token and hands it to the page.
 *
 * WHY `identify guilds` AND NOT `guilds.members.read`: `guilds` returns every
 * guild the user belongs to along with the user's permissions in it, which is
 * exactly the two facts the gate needs. `guilds.members.read` returns one
 * guild's member object but not a computed permission set, so it cannot answer
 * "may this person manage events" without the full permission algorithm.
 *
 * WHY THE CODE IS EXCHANGED SERVER-SIDE: it requires `DISCORD_CLIENT_SECRET`.
 * Doing it in the browser (the implicit/PKCE flow) would either put the secret
 * in the bundle or leave an access token in the URL fragment, which leaks
 * through history and Referer headers. The redirect target is the site, not the
 * Worker, so the code is handed to the Worker over the same CORS-controlled
 * origin the rest of the API already uses.
 */

import { OAUTH_STATE_TTL_SECONDS, type SignedPayload, signPayload, verifySignedPayload } from "./session";

/** Scopes requested from the user. Both are non-privileged. */
export const OAUTH_SCOPES = "identify guilds";

/** Discord's OAuth2 endpoints. */
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/v10/oauth2/token";

export interface AuthorizeUrlOptions {
    clientId: string;
    redirectUri: string;
    /** Signed anti-CSRF token, returned by Discord and verified on the callback. */
    state: string;
    /** `consent` re-shows the approval screen; `none` skips it when already granted. */
    prompt?: "consent" | "none";
}

/**
 * Build the URL the browser is sent to.
 *
 * `redirect_uri` must match an entry registered in the Discord developer portal
 * EXACTLY (scheme, host, path, trailing slash). Discord rejects a mismatch with
 * an error page rather than a usable message, so a mismatch looks like "login
 * is broken" with no detail. It is passed in rather than derived so the value
 * is one configured string on both sides.
 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
    const params = new URLSearchParams({
        response_type: "code",
        client_id: options.clientId,
        scope: OAUTH_SCOPES,
        redirect_uri: options.redirectUri,
        state: options.state,
        // GUILD_INSTALL. Only meaningful with `applications.commands`, but
        // harmless and keeps the request explicit.
        integration_type: "0",
    });
    if (options.prompt) params.set("prompt", options.prompt);
    return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** The token endpoint. Content type MUST be form-encoded; Discord rejects JSON. */
export const DISCORD_TOKEN_URL = TOKEN_URL;

/** What we need out of the token response. */
export interface OAuthToken {
    accessToken: string;
    scope: string;
}

/**
 * Parse the token response, rejecting anything unusable.
 *
 * The access token is a bearer credential for the USER -- it is used for one
 * request (`/users/@me/guilds`) and then discarded. It is never logged,
 * returned to the browser, or stored.
 */
export function parseTokenResponse(data: unknown): OAuthToken | null {
    if (typeof data !== "object" || data === null) return null;
    const body = data as Record<string, unknown>;
    const accessToken = body.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) return null;
    return {
        accessToken,
        scope: typeof body.scope === "string" ? body.scope : "",
    };
}

/** The subset of Discord's user object this flow reads. */
export interface OAuthUser {
    id: string;
    /** `global_name` when set (the modern display name), else `username`. */
    name: string;
}

/**
 * Parse `/users/@me` into a display identity.
 *
 * Discord's `username` is the legacy handle and `global_name` is what the
 * client actually shows; preferring `global_name` means the name in the UI
 * matches what the user sees in Discord. Both are optional in practice for
 * removed/deleted accounts, so a missing name falls back to the user id rather
 * than failing the login.
 */
export function parseUser(data: unknown): OAuthUser | null {
    if (typeof data !== "object" || data === null) return null;
    const body = data as Record<string, unknown>;
    const id = body.id;
    if (typeof id !== "string" || id.length === 0) return null;
    const globalName = typeof body.global_name === "string" ? body.global_name.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    return { id, name: globalName || username || id };
}

/**
 * Create a signed `state` value binding an OAuth attempt to a nonce.
 *
 * Without this, an attacker can feed a victim a callback URL carrying the
 * attacker's own authorization code ("login CSRF"), which would sign the victim
 * into the attacker's account. Verifying a signature we minted ourselves means
 * only a state this Worker issued can complete the flow.
 *
 * WARNING: The nonce is NOT persisted, so this does not make an attempt
 * single-use -- replaying the same callback URL inside the 10-minute window
 * would mint a second session. That is bounded by the same permission check
 * (a replayed state still belongs to the same authorized user) and by the
 * short window; making it single-use would need a KV write per login, which the
 * free tier's write budget cannot absorb comfortably. Do not lengthen
 * `OAUTH_STATE_TTL_SECONDS` without revisiting that trade.
 */
export async function createOAuthState(secret: string, now: Date = new Date()): Promise<string> {
    const nonce = crypto.randomUUID();
    const payload: SignedPayload = {
        n: nonce,
        exp: Math.floor(now.getTime() / 1000) + OAUTH_STATE_TTL_SECONDS,
        purpose: "oauth-state",
    };
    return signPayload(secret, payload);
}

/**
 * Verify a returned `state` value.
 *
 * Checks the signature, the purpose marker (so a SESSION token can never be
 * used as a state), and the expiry -- all three matter, and checking only the
 * signature would let a long-lived session token be replayed as a state.
 */
export async function verifyOAuthState(
    secret: string | undefined,
    state: string | null | undefined,
    now: Date = new Date(),
): Promise<boolean> {
    if (!secret) return false;
    if (!state) return false;
    const payload = await verifySignedPayload(secret, state);
    if (!payload) return false;
    if (payload.purpose !== "oauth-state") return false;
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
    return exp * 1000 > now.getTime();
}
