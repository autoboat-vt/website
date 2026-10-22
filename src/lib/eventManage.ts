/**
 * Client for the event-creation flow on the Discord-events Worker.
 *
 * The read-only calendar lives in `discord.ts`; this module is the write side,
 * kept separate so the calendar's data path does not grow a login dependency
 * and so the management surface is easy to audit in one place.
 *
 * SESSION STORAGE
 *
 * The session is a bearer token returned by the Worker, NOT a cookie. The site
 * and the Worker are different origins (`autoboat.aoe.vt.edu` vs
 * `*.workers.dev`), so a cookie set by the Worker is third-party -- blocked by
 * Safari and being phased out in Chrome. A token in `localStorage` survives a
 * reload without those restrictions.
 *
 * WARNING: `localStorage` is readable by any script on the page, so a future XSS
 * would expose the token. That is acceptable here because the token only grants
 * "may create events for two hours" -- it cannot read the officer feed, which
 * is already unauthenticated, and it is not a Discord credential. Do NOT store
 * a Discord access token here; the Worker never returns one.
 *
 * WARNING: Storage access THROWS in private-browsing modes and when site data is
 * blocked. Every access is wrapped so a blocked store degrades to "logged out"
 * rather than taking the calendar page down.
 */

import { EVENTS_URL } from "./discord";

/** Key for the persisted session. Namespaced so it cannot collide. */
const SESSION_STORAGE_KEY = "autoboat.calendar.session";

/** Where the Worker's management routes live. */
export const MANAGE_URL = `${EVENTS_URL}/manage`;

/** A signed-in officer, as reported by the Worker. */
export interface ManageSession {
    token: string;
    /** Display name (Discord `global_name` when set). */
    name: string;
    /** Epoch ms after which the token must not be used. */
    expiresAt: number;
    /**
     * The page this login should return to, allowlisted by the Worker.
     *
     * Optional so a session persisted by an older build still loads; callers
     * fall back to `/calendar/`. Only meaningful on the callback, since a
     * restored session has already arrived.
     */
    returnPath?: string;
}

/**
 * Why a login was refused, as reported by the Worker.
 *
 * - `not-a-member`: signed into a Discord account that is not in the team
 *   server (very often the WRONG account -- people have a personal and a
 *   school account).
 * - `missing-role`: in the server, but without `MANAGE_EVENTS`.
 *
 * Kept as codes rather than matching on the message text: the wording is a
 * presentation detail and must be free to change without breaking the branch.
 */
export type ManageDenialReason = "not-a-member" | "missing-role";

/** Why a login or create attempt failed, with enough detail to word the UI. */
export class ManageError extends Error {
    readonly status: number;
    /**
     * `true` when the user is in the guild but lacks the officer permission.
     * The two are worded differently: "ask for the role" is actionable, "join
     * the server" is not something a stranger can fix.
     */
    readonly needsRole: boolean;
    /** `true` when the user is not a member of the team guild at all. */
    readonly notAMember: boolean;
    /** The structured reason, when the Worker supplied one. */
    readonly reason: ManageDenialReason | null;
    /** The Discord display name the refusal applied to, when known. */
    readonly account: string | null;
    /** The team server's name, when the Worker resolved it. */
    readonly guildName: string | null;

    constructor(
        message: string,
        status: number,
        flags: {
            needsRole?: boolean;
            notAMember?: boolean;
            reason?: ManageDenialReason | null;
            account?: string | null;
            guildName?: string | null;
        } = {},
    ) {
        super(message);
        this.name = "ManageError";
        this.status = status;
        this.needsRole = flags.needsRole ?? false;
        this.notAMember = flags.notAMember ?? false;
        this.reason = flags.reason ?? null;
        this.account = flags.account ?? null;
        this.guildName = flags.guildName ?? null;
    }

    /**
     * A sentence for a refusal that explains what to do next, or null when this
     * is not a permission refusal.
     *
     * WHY THIS EXISTS: the Worker's `error` field is written for whoever reads
     * the logs. The person who needs it is the officer who just signed in with
     * the wrong account, and they need three things the raw message omits --
     * which account was refused, which server was expected, and how to fix it.
     */
    get remedy(): string | null {
        if (this.reason === "not-a-member") {
            const account = this.account ? `"${this.account}"` : "that Discord account";
            const server = this.guildName ? `the ${this.guildName} server` : "the team's Discord server";
            return (
                `You are signed in to Discord as ${account}, which is not a member of ${server}. ` +
                "If you have a second Discord account, sign in with that one."
            );
        }
        if (this.reason === "missing-role") {
            const server = this.guildName ? `the ${this.guildName} server` : "the team's server";
            return (
                `You are in ${server}, but only officers can add events. ` +
                "Ask an officer to give your Discord account the officer role, then sign in again."
            );
        }
        return null;
    }
}

interface StoredSession {
    token: string;
    name: string;
    expiresAt: number;
    returnPath?: string;
}

function readStoredSession(): StoredSession | null {
    try {
        const raw = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return null;
        const candidate = parsed as Record<string, unknown>;
        if (typeof candidate.token !== "string" || typeof candidate.name !== "string") return null;
        if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt)) return null;
        return {
            token: candidate.token,
            name: candidate.name,
            expiresAt: candidate.expiresAt,
            // Optional: a session stored before the return path existed simply
            // has none, and callers default to the calendar.
            ...(typeof candidate.returnPath === "string" ? { returnPath: candidate.returnPath } : {}),
        };
    } catch {
        // Storage blocked (private mode), quota exceeded, or corrupt JSON.
        return null;
    }
}

/**
 * The current session, or null when absent/expired.
 *
 * Expiry is checked CLIENT-side purely to avoid a pointless round trip; the
 * Worker re-verifies the token's signature and expiry on every call, so a
 * tampered `expiresAt` only causes a 401, not access.
 */
export function loadSession(now: Date = new Date()): ManageSession | null {
    const stored = readStoredSession();
    if (!stored) return null;
    if (stored.expiresAt <= now.getTime()) {
        clearSession();
        return null;
    }
    return stored;
}

function saveSession(session: StoredSession): void {
    try {
        globalThis.localStorage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
        // A blocked store means the session lasts only for this page view,
        // which is still usable -- do not fail the login over it.
    }
}

/** Forget the persisted session. Safe to call when none is stored. */
export function clearSession(): void {
    try {
        globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY);
    } catch {
        // Nothing to do; the in-memory state is cleared by the caller.
    }
}

/** Read one of our JSON error bodies, tolerating a non-JSON response. */
async function errorFromResponse(res: Response): Promise<ManageError> {
    let body: Record<string, unknown> = {};
    try {
        const parsed: unknown = await res.json();
        if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
        // Fall through to the status-based message.
    }
    const message = typeof body.error === "string" && body.error ? body.error : `Request failed (${res.status}).`;

    // Prefer the Worker's explicit `reason` code. The `member` flag is a
    // fallback for any response that predates it, so an older deployed Worker
    // still produces the right wording rather than a bare message.
    const rawReason = body.reason;
    const reason: ManageDenialReason | null =
        rawReason === "not-a-member" || rawReason === "missing-role"
            ? rawReason
            : body.member === false
              ? "not-a-member"
              : res.status === 403
                ? "missing-role"
                : null;

    return new ManageError(message, res.status, {
        reason,
        // `member: false` is the Worker's explicit "not in the server" signal.
        notAMember: reason === "not-a-member",
        // `member: true` plus a 403 means "in the server, lacks the role".
        needsRole: reason === "missing-role",
        account: typeof body.account === "string" ? body.account : null,
        guildName: typeof body.guildName === "string" ? body.guildName : null,
    });
}

/**
 * Start a login: fetch the authorize URL and send the browser to Discord.
 *
 * The URL is built by the Worker so the client id, redirect URI, and the
 * signed `state` come from server-side configuration rather than from
 * anything the page could be tricked into supplying.
 *
 * `returnTo` is the page to land on after the callback. Discord requires the
 * redirect URI itself to be one fixed registered value, so the destination
 * rides in the signed state instead -- this is what lets the gallery page offer
 * a sign-in without stranding the officer on the calendar. The Worker
 * allowlists it; an unknown value falls back to `/calendar/`.
 *
 * `navigate` is injectable because jsdom's `location` is non-configurable and
 * `location.assign` cannot be spied on -- the alternative is an untestable
 * hard-coded navigation. The default is the real one.
 */
export async function beginLogin(
    navigate: (url: string) => void = (url) => globalThis.location.assign(url),
    returnTo?: string,
): Promise<void> {
    const endpoint = returnTo
        ? `${MANAGE_URL}/auth/url?return=${encodeURIComponent(returnTo)}`
        : `${MANAGE_URL}/auth/url`;
    const res = await fetch(endpoint, { cache: "no-store" });
    if (!res.ok) throw await errorFromResponse(res);
    const body = (await res.json()) as { url?: unknown };
    if (typeof body.url !== "string" || !body.url) {
        throw new ManageError("Discord login is misconfigured.", 503);
    }
    navigate(body.url);
}

/**
 * Complete a login by exchanging the callback's `code` and `state`.
 *
 * Resolves to the new session (also persisted). Throws `ManageError` for every
 * rejection the UI needs to distinguish: not a member, no officer role, expired
 * login, or a misconfigured Worker.
 */
export async function completeLogin(code: string, state: string): Promise<ManageSession> {
    const res = await fetch(`${MANAGE_URL}/auth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
        cache: "no-store",
    });
    if (!res.ok) throw await errorFromResponse(res);

    const body = (await res.json()) as {
        token?: unknown;
        name?: unknown;
        expiresIn?: unknown;
        returnPath?: unknown;
    };
    if (typeof body.token !== "string" || typeof body.name !== "string" || typeof body.expiresIn !== "number") {
        throw new ManageError("Discord returned an unusable login response.", 502);
    }
    const session: ManageSession = {
        token: body.token,
        name: body.name,
        // Derive the deadline from `expiresIn` rather than trusting a server
        // clock to agree with this machine's.
        expiresAt: Date.now() + body.expiresIn * 1000,
        // Signed inside the state, so it cannot be steered by the query string.
        // A Worker too old to send it falls back to the calendar, which is
        // where every login used to land anyway.
        returnPath: typeof body.returnPath === "string" && body.returnPath ? body.returnPath : "/calendar/",
    };
    saveSession(session);
    return session;
}

/** Drop a session locally. The token is stateless, so there is no server call. */
export function logOut(): void {
    clearSession();
}

/** What the create form submits. Mirrors the Worker's `CreateEventInput`. */
export interface CreateEventInput {
    name: string;
    description?: string | null;
    /** ISO-8601 instant. */
    start: string;
    end?: string | null;
    /** Discord voice/stage channel id, or null for an event without a channel. */
    channelId?: string | null;
    /** Venue or link. Required when there is no channel. */
    location?: string | null;
    recurrence?: {
        frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
        interval?: number;
        byWeekday?: number[];
        byNWeekday?: { n: number; day: number }[];
        byMonth?: number[];
        byMonthDay?: number[];
    } | null;
}

/** The created event as the Worker normalizes it, plus its resolved audience. */
export interface CreateEventResult {
    event: {
        id: string;
        name: string;
        start: string;
        audience: "public" | "officer";
    } | null;
    officerOnly: boolean;
}

/**
 * Create a guild scheduled event in Discord via the Worker.
 *
 * Throws `ManageError` on every failure, including a 401 (expired session --
 * the caller should route the user back through `beginLogin`) and a 403 (the
 * account lost the officer role).
 */
export async function createEvent(session: ManageSession, input: CreateEventInput): Promise<CreateEventResult> {
    const res = await fetch(`${MANAGE_URL}/events`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify(input),
        cache: "no-store",
    });
    if (!res.ok) throw await errorFromResponse(res);
    return (await res.json()) as CreateEventResult;
}

/**
 * Delete a guild scheduled event.
 *
 * Throws `ManageError` on failure: 401 (session expired -- sign in again), 403
 * (lost the officer role), 404 (already deleted, e.g. in the Discord client),
 * or 429 (Discord rate limited).
 *
 * WARNING: Deleting in Discord removes it from the calendar because the Worker drops
 * it from its archive; this path does the same thing directly so the event
 * disappears immediately rather than waiting for the next cache refresh.
 */
export async function deleteEvent(session: ManageSession, eventId: string): Promise<void> {
    if (!/^\d{15,20}$/.test(eventId)) {
        // Refuse locally: a malformed id would otherwise become a 400 whose
        // message is about the id, which is more confusing than this.
        throw new ManageError("That event cannot be deleted because its id is invalid.", 400);
    }
    const res = await fetch(`${MANAGE_URL}/events/${eventId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}` },
        cache: "no-store",
    });
    if (!res.ok) throw await errorFromResponse(res);
}
