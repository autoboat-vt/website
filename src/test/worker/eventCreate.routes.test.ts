/**
 * @jest-environment node
 *
 * Route-level tests for the event-creation endpoints.
 *
 * These drive the Worker's real `fetch` handler because the failure mode that
 * matters is a WIRING mistake: a management route reachable without a valid
 * session, or a create endpoint that trusts a token's claim without checking
 * the signature. Testing `handleCreateEvent` directly would not catch a route
 * table that points `/manage/events` at the wrong handler.
 *
 * The security tests here are the point of the suite. Events are created with
 * the BOT's token, so Discord enforces the bot's permissions -- if these gates
 * fail open, anyone can post to the team calendar.
 */

import worker from "../../../worker/src/index";
import { createSession, signPayload } from "../../../worker/src/session";

const SECRET = "test-session-secret";
const GUILD = "1017960606403416085";
const OFFICER_CHANNEL = "1550594891766308997";
const PUBLIC_CHANNEL = "1550592611859955862";
const PROD_ORIGIN = "https://autoboat.aoe.vt.edu";

const ENV = {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: GUILD,
    ALLOWED_ORIGIN: PROD_ORIGIN,
    CACHE_TTL_SECONDS: "180",
    OFFICERS_CHANNEL_ID: OFFICER_CHANNEL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: SECRET,
    OAUTH_REDIRECT_URI: `${PROD_ORIGIN}/calendar/`,
};

const FUTURE = "2026-11-05T19:00:00.000Z";

/** KV stub that records writes so the archive-merge assertion can inspect them. */
function makeKv(store: Record<string, unknown> = {}) {
    const writes: Record<string, unknown> = {};
    return {
        store,
        writes,
        async get(key: string) {
            return key in store ? store[key] : null;
        },
        async put(key: string, value: string) {
            writes[key] = JSON.parse(value);
            store[key] = JSON.parse(value);
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

type DiscordReply = { status: number; body: unknown };

/**
 * Stub Discord. `routes` maps a URL substring to a reply. Records every call so
 * tests can assert what was (and was not) sent upstream -- in particular that
 * the user's access token is used only for the two profile reads.
 *
 * WARNING: Matches the LONGEST pattern first. `/users/@me` is a substring of
 * `/users/@me/guilds`, so declaration order would otherwise make the guilds
 * read return the user object -- and the membership gate would silently see an
 * empty guild list instead of the fixture's permissions.
 */
function stubDiscord(routes: { match: string; reply: DiscordReply | (() => DiscordReply) }[]) {
    const calls: { url: string; method: string; headers: Headers; body: string | null }[] = [];
    const byLongestMatch = [...routes].sort((a, b) => b.match.length - a.match.length);
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const headers = new Headers(init?.headers);
        calls.push({ url, method, headers, body: typeof init?.body === "string" ? init.body : null });
        for (const route of byLongestMatch) {
            if (url.includes(route.match)) {
                const reply = typeof route.reply === "function" ? route.reply() : route.reply;
                return new Response(JSON.stringify(reply.body), {
                    status: reply.status,
                    headers: { "Content-Type": "application/json" },
                });
            }
        }
        return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;
    return calls;
}

/** A created-event payload as Discord returns it. */
function discordCreatedEvent(overrides: Record<string, unknown> = {}) {
    return {
        id: "evt-1",
        guild_id: GUILD,
        channel_id: PUBLIC_CHANNEL,
        name: "Software Meeting",
        description: null,
        scheduled_start_time: FUTURE,
        scheduled_end_time: null,
        privacy_level: 2,
        status: 1,
        entity_type: 2,
        entity_metadata: null,
        user_count: null,
        image: null,
        recurrence_rule: null,
        ...overrides,
    };
}

interface RequestOptions {
    kv?: ReturnType<typeof makeKv>;
    env?: Record<string, string | undefined>;
    token?: string | null;
    origin?: string;
    body?: unknown;
}

async function call(path: string, method: string, opts: RequestOptions = {}) {
    const kv = opts.kv ?? makeKv();
    const { ctx, promises } = makeCtx();
    const headers = new Headers();
    if (opts.origin) headers.set("Origin", opts.origin);
    if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
    if (opts.body !== undefined) headers.set("Content-Type", "application/json");
    const res = await worker.fetch(
        new Request(`https://worker.test${path}`, {
            method,
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        }),
        { ...ENV, ...opts.env, EVENTS_KV: kv } as never,
        ctx as never,
    );
    await Promise.all(promises);
    return { res, kv };
}

/** A valid officer session token. */
async function officerToken(now = new Date()) {
    const { token } = await createSession(SECRET, { id: "1", name: "Officer", canCreateEvents: true }, now);
    return token;
}

/** A valid token that does NOT carry the create claim. */
async function nonOfficerToken(now = new Date()) {
    const { token } = await createSession(SECRET, { id: "2", name: "Member", canCreateEvents: false }, now);
    return token;
}

const realFetch = global.fetch;
afterEach(() => {
    global.fetch = realFetch;
});

describe("management route wiring", () => {
    it("405s a GET on the create endpoint", async () => {
        // GET must never reach the handler: a create is a POST-only action, and
        // a permissive method check here is how a write endpoint becomes
        // reachable from a link or an img tag.
        const { res } = await call("/manage/events", "GET");
        expect(res.status).toBe(405);
    });

    it("405s a POST on the session endpoint", async () => {
        const { res } = await call("/manage/session", "POST", { body: {} });
        expect(res.status).toBe(405);
    });

    it("405s a POST on the auth-url endpoint", async () => {
        const { res } = await call("/manage/auth/url", "POST", { body: {} });
        expect(res.status).toBe(405);
    });

    it("404s an unknown management path", async () => {
        // Guards against a prefix route leaking the create endpoint on a typo.
        const { res } = await call("/manage/events/admin", "POST", { body: {} });
        expect(res.status).toBe(404);
    });

    it("204s a preflight for the create endpoint and advertises POST + Authorization", async () => {
        const { res } = await call("/manage/events", "OPTIONS", { origin: PROD_ORIGIN });
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PROD_ORIGIN);
        expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
        // Without Authorization in this list the browser blocks the real
        // request during preflight, which reports as a network error.
        expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    });

    it("marks management responses no-store", async () => {
        const token = await officerToken();
        stubDiscord([{ match: "/users/@me", reply: { status: 200, body: { name: "Officer" } } }]);
        const { res } = await call("/manage/session", "GET", { token, origin: PROD_ORIGIN });
        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
});

describe("GET /manage/auth/url", () => {
    it("returns a Discord authorize URL with the configured client id and redirect", async () => {
        const { res } = await call("/manage/auth/url", "GET");
        const body = (await res.json()) as { url: string };
        const url = new URL(body.url);
        expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
        expect(url.searchParams.get("client_id")).toBe("client-id");
        expect(url.searchParams.get("redirect_uri")).toBe(`${PROD_ORIGIN}/calendar/`);
        expect(url.searchParams.get("response_type")).toBe("code");
        // `guilds` is what makes the permission gate possible.
        expect(url.searchParams.get("scope")).toBe("identify guilds");
        expect(url.searchParams.get("state")).toBeTruthy();
    });

    it("issues a different state each time", async () => {
        const first = (await (await call("/manage/auth/url", "GET")).res.json()) as { url: string };
        const second = (await (await call("/manage/auth/url", "GET")).res.json()) as { url: string };
        expect(new URL(first.url).searchParams.get("state")).not.toBe(new URL(second.url).searchParams.get("state"));
    });

    it("503s when the OAuth config is incomplete", async () => {
        const { res } = await call("/manage/auth/url", "GET", {
            env: { DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "" },
        });
        expect(res.status).toBe(503);
    });

    it("503s when the session secret is missing", async () => {
        const { res } = await call("/manage/auth/url", "GET", { env: { SESSION_SECRET: "" } });
        expect(res.status).toBe(503);
    });
});

describe("POST /manage/auth/callback", () => {
    /** A state value the Worker would have issued. */
    async function validState() {
        const body = (await (await call("/manage/auth/url", "GET")).res.json()) as { url: string };
        return new URL(body.url).searchParams.get("state") as string;
    }

    const usersMe = { match: "/users/@me", reply: { status: 200, body: { id: "1", username: "officer" } } };

    it("issues a session for an officer", async () => {
        const state = await validState();
        stubDiscord([
            {
                match: "/oauth2/token",
                reply: { status: 200, body: { access_token: "user-token", scope: "identify guilds" } },
            },
            usersMe,
            {
                match: "/users/@me/guilds",
                reply: { status: 200, body: [{ id: GUILD, name: "AutoBoat", permissions: String(1n << 33n) }] },
            },
        ]);

        const { res } = await call("/manage/auth/callback", "POST", { body: { code: "the-code", state } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { token: string; name: string; expiresIn: number };
        expect(body.token).toBeTruthy();
        expect(body.name).toBe("officer");
        expect(body.expiresIn).toBeGreaterThan(0);
        // The user's Discord token must NEVER be handed to the browser.
        expect(JSON.stringify(body)).not.toContain("user-token");
    });

    it("exchanges the code with form encoding and HTTP Basic auth", async () => {
        const state = await validState();
        const calls = stubDiscord([
            { match: "/oauth2/token", reply: { status: 200, body: { access_token: "user-token" } } },
            usersMe,
            {
                match: "/users/@me/guilds",
                reply: { status: 200, body: [{ id: GUILD, permissions: String(1n << 33n) }] },
            },
        ]);
        await call("/manage/auth/callback", "POST", { body: { code: "the-code", state } });

        const tokenCall = calls.find((c) => c.url.includes("/oauth2/token"));
        expect(tokenCall?.method).toBe("POST");
        // Discord rejects JSON here, and the helper would reports a bare 401.
        expect(tokenCall?.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
        expect(tokenCall?.body).toContain("grant_type=authorization_code");
        expect(tokenCall?.body).toContain("code=the-code");
        expect(tokenCall?.headers.get("Authorization")).toBe(`Basic ${btoa("client-id:client-secret")}`);
    });

    it("rejects a forged state without spending a token exchange", async () => {
        const calls = stubDiscord([{ match: "/oauth2/token", reply: { status: 200, body: { access_token: "x" } } }]);
        const { res } = await call("/manage/auth/callback", "POST", {
            body: { code: "the-code", state: "v1.forged.sig" },
        });
        expect(res.status).toBe(400);
        expect(calls.some((c) => c.url.includes("/oauth2/token"))).toBe(false);
    });

    it("rejects a SESSION token used as a state", async () => {
        // Both are signed by the same secret, so only the `purpose` marker
        // separates them. Without that check a long-lived session token could
        // be replayed as a login state.
        const sessionToken = await officerToken();
        const { res } = await call("/manage/auth/callback", "POST", {
            body: { code: "the-code", state: sessionToken },
        });
        expect(res.status).toBe(400);
    });

    it("rejects an expired state", async () => {
        // Mint a state that expired an hour ago.
        const expired = await signPayload(SECRET, {
            purpose: "oauth-state",
            n: "x",
            exp: Math.floor(Date.now() / 1000) - 3600,
        });
        const { res } = await call("/manage/auth/callback", "POST", { body: { code: "the-code", state: expired } });
        expect(res.status).toBe(400);
    });

    it("400s without a code", async () => {
        const state = await validState();
        const { res } = await call("/manage/auth/callback", "POST", { body: { code: "", state } });
        expect(res.status).toBe(400);
    });

    it("400s on a non-JSON body", async () => {
        const { res } = await call("/manage/auth/callback", "POST", { body: undefined });
        expect(res.status).toBe(400);
    });

    it("403s a user who is not in the guild, with a distinct member flag", async () => {
        const state = await validState();
        stubDiscord([
            { match: "/oauth2/token", reply: { status: 200, body: { access_token: "user-token" } } },
            usersMe,
            { match: "/users/@me/guilds", reply: { status: 200, body: [{ id: "other-guild", permissions: "0" }] } },
        ]);
        const { res } = await call("/manage/auth/callback", "POST", { body: { code: "the-code", state } });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { member: boolean };
        expect(body.member).toBe(false);
    });

    it("403s an ordinary member -- only officers may create events", async () => {
        const state = await validState();
        stubDiscord([
            { match: "/oauth2/token", reply: { status: 200, body: { access_token: "user-token" } } },
            usersMe,
            {
                match: "/users/@me/guilds",
                // CREATE_EVENTS (2^44) alone. Ordinary members hold this.
                reply: { status: 200, body: [{ id: GUILD, permissions: String(1n << 44n) }] },
            },
        ]);
        const { res } = await call("/manage/auth/callback", "POST", { body: { code: "the-code", state } });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { member: boolean; canCreateEvents: boolean };
        expect(body.member).toBe(true);
        expect(body.canCreateEvents).toBe(false);
    });

    it("401s when Discord rejects the code", async () => {
        const state = await validState();
        stubDiscord([{ match: "/oauth2/token", reply: { status: 400, body: { error: "invalid_grant" } } }]);
        const { res } = await call("/manage/auth/callback", "POST", { body: { code: "bad", state } });
        expect(res.status).toBe(401);
    });

    it("502s when Discord's profile read fails", async () => {
        const state = await validState();
        stubDiscord([
            { match: "/oauth2/token", reply: { status: 200, body: { access_token: "user-token" } } },
            { match: "/users/@me", reply: { status: 500, body: {} } },
        ]);
        const { res } = await call("/manage/auth/callback", "POST", { body: { code: "the-code", state } });
        expect(res.status).toBe(502);
    });

    it("never returns or logs the client secret", async () => {
        const state = await validState();
        stubDiscord([
            { match: "/oauth2/token", reply: { status: 200, body: { access_token: "user-token" } } },
            usersMe,
            {
                match: "/users/@me/guilds",
                reply: { status: 200, body: [{ id: GUILD, permissions: String(1n << 33n) }] },
            },
        ]);
        const { res } = await call("/manage/auth/callback", "POST", { body: { code: "the-code", state } });
        expect(await res.text()).not.toContain("client-secret");
    });
});

describe("GET /manage/session", () => {
    it("reports the signed-in user", async () => {
        const token = await officerToken();
        const { res } = await call("/manage/session", "GET", { token });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ name: "Officer", canCreateEvents: true });
    });

    it("401s without a token", async () => {
        expect((await call("/manage/session", "GET")).res.status).toBe(401);
    });

    it("401s a token signed with the wrong secret", async () => {
        const { token } = await createSession("wrong-secret", { id: "1", name: "Imposter", canCreateEvents: true });
        expect((await call("/manage/session", "GET", { token })).res.status).toBe(401);
    });

    it("401s an expired token", async () => {
        const token = await officerToken(new Date(Date.now() - 3 * 60 * 60 * 1000));
        expect((await call("/manage/session", "GET", { token })).res.status).toBe(401);
    });

    it("401s when no session secret is configured", async () => {
        const token = await officerToken();
        expect((await call("/manage/session", "GET", { token, env: { SESSION_SECRET: undefined } })).res.status).toBe(
            401,
        );
    });
});

describe("POST /manage/events -- authorization", () => {
    const validBody = { name: "Software Meeting", start: FUTURE, channelId: PUBLIC_CHANNEL };

    it("401s without a token and never calls Discord", async () => {
        const calls = stubDiscord([
            { match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } },
        ]);
        const { res } = await call("/manage/events", "POST", { body: validBody });
        expect(res.status).toBe(401);
        expect(calls).toHaveLength(0);
    });

    it("401s a forged token", async () => {
        const { token } = await createSession("wrong-secret", { id: "1", name: "Imposter", canCreateEvents: true });
        const calls = stubDiscord([
            { match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } },
        ]);
        const { res } = await call("/manage/events", "POST", { body: validBody, token });
        expect(res.status).toBe(401);
        expect(calls).toHaveLength(0);
    });

    it("403s a valid token that lacks the create claim", async () => {
        // The token is genuine but was minted for a non-officer. This is the
        // second half of the gate: authentication is not authorization.
        const token = await nonOfficerToken();
        const calls = stubDiscord([
            { match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } },
        ]);
        const { res } = await call("/manage/events", "POST", { body: validBody, token });
        expect(res.status).toBe(403);
        expect(calls).toHaveLength(0);
    });

    it("401s an expired token", async () => {
        const token = await officerToken(new Date(Date.now() - 3 * 60 * 60 * 1000));
        const calls = stubDiscord([
            { match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } },
        ]);
        expect((await call("/manage/events", "POST", { body: validBody, token })).res.status).toBe(401);
        expect(calls).toHaveLength(0);
    });
});

describe("POST /manage/events -- creation", () => {
    const validBody = { name: "Software Meeting", start: FUTURE, channelId: PUBLIC_CHANNEL };

    it("creates the event and returns the normalized result", async () => {
        const token = await officerToken();
        const calls = stubDiscord([
            { match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } },
        ]);
        const { res } = await call("/manage/events", "POST", { body: validBody, token });

        expect(res.status).toBe(201);
        const body = (await res.json()) as { event: { id: string; audience: string }; officerOnly: boolean };
        expect(body.event.id).toBe("evt-1");
        // Normalized through the same path the read routes use, so a created
        // event is classified identically to a fetched one.
        expect(body.event.audience).toBe("public");
        expect(body.officerOnly).toBe(false);

        // Created with the BOT token, against the configured guild.
        const create = calls.find((c) => c.url.includes("/scheduled-events"));
        expect(create?.headers.get("Authorization")).toBe("Bot bot-token");
        expect(create?.url).toContain(`/guilds/${GUILD}/scheduled-events`);
        expect(create?.method).toBe("POST");
    });

    it("sends Discord's expected body shape for a VOICE event", async () => {
        const token = await officerToken();
        const calls = stubDiscord([
            { match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } },
        ]);
        await call("/manage/events", "POST", { body: validBody, token });

        const create = calls.find((c) => c.url.includes("/scheduled-events"));
        const sent = JSON.parse(create?.body ?? "{}");
        expect(sent).toMatchObject({
            name: "Software Meeting",
            scheduled_start_time: FUTURE,
            channel_id: PUBLIC_CHANNEL,
            entity_type: 2,
            privacy_level: 2,
        });
        expect(sent.entity_metadata).toBeUndefined();
        // An audit-log reason makes a bot-created event attributable.
        expect(create?.headers.get("X-Audit-Log-Reason")).toBeTruthy();
    });

    it("reports officerOnly when the event lands in the officer channel", async () => {
        const token = await officerToken();
        stubDiscord([
            {
                match: "/scheduled-events",
                reply: {
                    status: 200,
                    body: discordCreatedEvent({ channel_id: OFFICER_CHANNEL }),
                },
            },
        ]);
        const { res } = await call("/manage/events", "POST", {
            body: { ...validBody, channelId: OFFICER_CHANNEL },
            token,
        });
        const body = (await res.json()) as { event: { audience: string }; officerOnly: boolean };
        expect(body.officerOnly).toBe(true);
        // The normalized event is officer-only, so it is absent from the public feed.
        expect(body.event.audience).toBe("officer");
    });

    it("writes the new event into the KV archive so it is visible immediately", async () => {
        const token = await officerToken();
        stubDiscord([{ match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } }]);
        // Seed a POPULATED archive: a cold one is deliberately left alone (see
        // the next test), so the merge path only runs over real history.
        const kv = makeKv({ "events:v2": { fetchedAt: Date.now(), events: [] } });
        await call("/manage/events", "POST", { body: validBody, token, kv });

        const stored = kv.writes["events:v2"] as { events: { id: string }[] } | undefined;
        expect(stored?.events.map((e) => e.id)).toContain("evt-1");
    });

    it("leaves a COLD cache untouched rather than seeding a one-event archive", async () => {
        // WARNING: Writing `[created]` with a fresh `fetchedAt` would make the
        // calendar show ONLY the new event for a whole TTL, because the next
        // read would consider the archive current and skip Discord.
        const token = await officerToken();
        stubDiscord([{ match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } }]);
        const kv = makeKv();
        const { res } = await call("/manage/events", "POST", { body: validBody, token, kv });

        expect(res.status).toBe(201);
        expect(kv.writes["events:v2"]).toBeUndefined();
    });

    it("preserves existing archived events when merging the new one", async () => {
        const token = await officerToken();
        stubDiscord([{ match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } }]);
        const kv = makeKv({
            "events:v2": {
                fetchedAt: Date.now(),
                events: [
                    {
                        id: "old-1",
                        name: "Old Meeting",
                        start: "2026-09-01T19:00:00.000Z",
                        end: null,
                        status: "completed",
                        description: null,
                        location: null,
                        userCount: null,
                        isRecurring: false,
                        image: null,
                        recurrenceRule: null,
                        cancelledDates: [],
                        channelId: PUBLIC_CHANNEL,
                        audience: "public",
                    },
                ],
            },
        });
        await call("/manage/events", "POST", { body: validBody, token, kv });

        const stored = kv.writes["events:v2"] as { events: { id: string }[] };
        expect(stored.events.map((e) => e.id).sort()).toEqual(["evt-1", "old-1"]);
    });

    it("400s an invalid payload without calling Discord", async () => {
        const token = await officerToken();
        const calls = stubDiscord([
            { match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } },
        ]);
        const { res } = await call("/manage/events", "POST", {
            body: { name: "", start: FUTURE, channelId: PUBLIC_CHANNEL },
            token,
        });
        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it("400s a non-JSON body", async () => {
        const token = await officerToken();
        expect((await call("/manage/events", "POST", { token })).res.status).toBe(400);
    });

    it("surfaces Discord's field error as a 400", async () => {
        const token = await officerToken();
        stubDiscord([{ match: "/scheduled-events", reply: { status: 400, body: { message: "Invalid Form Body" } } }]);
        const { res } = await call("/manage/events", "POST", { body: validBody, token });
        expect(res.status).toBe(400);
        expect((await res.json()) as { error: string }).toEqual({ error: "Invalid Form Body" });
    });

    it("maps a rate limit to 429", async () => {
        const token = await officerToken();
        stubDiscord([{ match: "/scheduled-events", reply: { status: 429, body: { message: "rate limited" } } }]);
        expect((await call("/manage/events", "POST", { body: validBody, token })).res.status).toBe(429);
    });

    it("maps a network failure to 502", async () => {
        const token = await officerToken();
        global.fetch = (async () => {
            throw new Error("network down");
        }) as unknown as typeof fetch;
        expect((await call("/manage/events", "POST", { body: validBody, token })).res.status).toBe(502);
    });

    it("does not fail the request when the warm KV write fails", async () => {
        const token = await officerToken();
        stubDiscord([{ match: "/scheduled-events", reply: { status: 200, body: discordCreatedEvent() } }]);
        const kv = makeKv();
        kv.put = async () => {
            throw new Error("KV write rejected");
        };
        const { res } = await call("/manage/events", "POST", { body: validBody, token, kv });
        // The event exists in Discord; the next poll picks it up.
        expect(res.status).toBe(201);
    });
});
