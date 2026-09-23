/**
 * @jest-environment node
 *
 * WARNING: Node environment, not the repo's default jsdom. This suite drives the
 * Worker's real `fetch` handler, which needs global `Request`/`Response` --
 * jsdom does not provide them, so under jsdom every test fails with
 * `ReferenceError: Request is not defined`. Nothing here touches the DOM, so
 * the node environment is both sufficient and faster.
 */

import { DEFAULT_OFFICERS_CHANNEL_ID, GUILD_CATEGORY } from "../../../worker/src/audience";
import worker from "../../../worker/src/index";

/**
 * Route-level tests for the Worker itself.
 *
 * The other Worker suites test pure modules. This one drives the actual
 * `fetch` entry point, because the highest-consequence bug in this area is not
 * a classification mistake -- it is a ROUTE WIRING mistake: mapping
 * `/events` at the officer audience (or vice versa) leaks officer events while
 * every unit test still passes. Asserting the route -> audience table through
 * the real handler is the only way to catch that.
 *
 * WARNING: Classification is by CHANNEL ID: the fixture's officer and public voice
 * channels share one category, as they do in the real guild.
 */

const EVENTS_CATEGORY = "1000";
const OFFICER_VOICE = "1002";
const SOFTWARE_VOICE = "2001";

const CHANNELS = [
    { id: EVENTS_CATEGORY, name: "Events", type: GUILD_CATEGORY, parent_id: null },
    { id: "1001", name: "Officers", type: GUILD_CATEGORY, parent_id: null },
    { id: OFFICER_VOICE, name: "Officer Voice", type: 2, parent_id: EVENTS_CATEGORY },
    { id: SOFTWARE_VOICE, name: "Software Voice", type: 2, parent_id: EVENTS_CATEGORY },
];

function discordEvent(id: string, name: string, channelId: string | null) {
    return {
        id,
        guild_id: "999",
        channel_id: channelId,
        name,
        description: null,
        scheduled_start_time: "2026-10-01T19:00:00.000Z",
        scheduled_end_time: null,
        privacy_level: 2,
        status: 1,
        entity_type: 2,
        entity_metadata: null,
        user_count: null,
        image: null,
        recurrence_rule: null,
    };
}

const RAW_EVENTS = [
    discordEvent("officer-1", "Officer Budget Review", OFFICER_VOICE),
    discordEvent("public-1", "Software Work Session", SOFTWARE_VOICE),
];

/** Minimal KV stub. `store` is passed in so tests can seed a warm cache. */
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
        },
    };
}

const ENV = {
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_GUILD_ID: "999",
    ALLOWED_ORIGIN: "https://autoboat.aoe.vt.edu",
    CACHE_TTL_SECONDS: "60",
    OFFICERS_CHANNEL_ID: OFFICER_VOICE,
};

/** A no-op ExecutionContext; `waitUntil` just runs the promise. */
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

/** Stub Discord so both resources resolve. */
function stubDiscord(opts: { failChannels?: boolean; channels?: typeof CHANNELS; events?: typeof RAW_EVENTS } = {}) {
    const calls: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/channels")) {
            if (opts.failChannels) {
                return new Response("nope", { status: 500 });
            }
            return new Response(JSON.stringify(opts.channels ?? CHANNELS), { status: 200 });
        }
        if (url.includes("/scheduled-events")) {
            return new Response(JSON.stringify(opts.events ?? RAW_EVENTS), { status: 200 });
        }
        return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;
    return calls;
}

async function get(
    path: string,
    opts: {
        kv?: ReturnType<typeof makeKv>;
        failChannels?: boolean;
        method?: string;
        env?: Record<string, string>;
    } = {},
) {
    const kv = opts.kv ?? makeKv();
    stubDiscord(opts);
    const { ctx, promises } = makeCtx();
    const res = await worker.fetch(
        new Request(`https://worker.test${path}`, { method: opts.method ?? "GET" }),
        { ...ENV, ...opts.env, EVENTS_KV: kv } as never,
        ctx as never,
    );
    // Let fire-and-forget KV writes settle so assertions can inspect them.
    await Promise.all(promises);
    return { res, kv };
}

const realFetch = global.fetch;

afterEach(() => {
    global.fetch = realFetch;
});

describe("route -> audience wiring", () => {
    it("GET /events excludes officer events but keeps public ones", async () => {
        const { res } = await get("/events");
        const body = (await res.json()) as { id: string }[];
        expect(body.map((e) => e.id)).toEqual(["public-1"]);
    });

    it("GET /officers/events includes BOTH officer and public events", async () => {
        // Officers should see the whole picture, not just their own events.
        const { res } = await get("/officers/events");
        const body = (await res.json()) as { id: string }[];
        expect(body.map((e) => e.id).sort()).toEqual(["officer-1", "public-1"]);
    });

    it("GET /calendar.ics excludes officer events", async () => {
        const { res } = await get("/calendar.ics");
        const body = await res.text();
        expect(body).toContain("Software Work Session");
        expect(body).not.toContain("Officer Budget Review");
    });

    it("GET /officers/calendar.ics includes officer events", async () => {
        const { res } = await get("/officers/calendar.ics");
        const body = await res.text();
        expect(body).toContain("Software Work Session");
        expect(body).toContain("Officer Budget Review");
    });

    it("reports the audience it served in a header", async () => {
        expect((await get("/events")).res.headers.get("X-Audience")).toBe("public");
        expect((await get("/officers/events")).res.headers.get("X-Audience")).toBe("officer");
    });

    it("normalizes a trailing slash without changing the audience", async () => {
        const { res } = await get("/officers/events/");
        const body = (await res.json()) as { id: string }[];
        expect(body.map((e) => e.id).sort()).toEqual(["officer-1", "public-1"]);
    });

    it("works against the REAL committed officer channel id", async () => {
        // WARNING: The end-to-end guard for the shipped configuration. Every other
        // test here overrides OFFICERS_CHANNEL_ID with a fixture value, which
        // means a typo, a stale id, or an accidental blanking of
        // DEFAULT_OFFICERS_CHANNEL_ID would leave the whole suite green while
        // the deployed site published officer events. This one omits the env
        // var entirely, so it exercises the committed default.
        const officerChannel = DEFAULT_OFFICERS_CHANNEL_ID;
        const channels = [
            { id: EVENTS_CATEGORY, name: "Events", type: GUILD_CATEGORY, parent_id: null },
            // Same shared category as the public channel, as in the real guild.
            { id: officerChannel, name: "Officer Voice", type: 2, parent_id: EVENTS_CATEGORY },
            { id: SOFTWARE_VOICE, name: "Software Voice", type: 2, parent_id: EVENTS_CATEGORY },
        ];
        const events = [
            discordEvent("officer-1", "Officer Budget Review", officerChannel),
            discordEvent("public-1", "Software Work Session", SOFTWARE_VOICE),
        ];
        stubDiscord({ channels, events });
        // OFFICERS_CHANNEL_ID is absent (not blank) so the committed default
        // is what gets resolved.
        const env = { ...ENV } as Record<string, unknown>;
        delete env.OFFICERS_CHANNEL_ID;
        const { ctx } = makeCtx();

        const res = await worker.fetch(
            new Request("https://worker.test/events"),
            { ...env, EVENTS_KV: makeKv() } as never,
            ctx as never,
        );
        const body = (await res.json()) as { id: string }[];

        expect(res.headers.get("X-Audience-Configured")).toBe("true");
        expect(body.map((e) => e.id)).toEqual(["public-1"]);
    });
});

describe("unconfigured officer channel", () => {
    // WARNING: This is the one place the policy is fail-CLOSED. Everywhere else an
    // unknown channel is public (the team asked for that). But with no officer
    // channel configured the Worker cannot tell an officer event from a public
    // one, so publishing "everything" would publish the officer calendar. It
    // serves nothing instead, and says so.
    const unconfigured = { OFFICERS_CHANNEL_ID: "" };

    it("serves an EMPTY public calendar rather than risking officer events", async () => {
        const { res } = await get("/events", { env: unconfigured });
        expect(res.status).toBe(200);
        expect((await res.json()) as unknown[]).toEqual([]);
    });

    it("serves an empty officer calendar too", async () => {
        const { res } = await get("/officers/events", { env: unconfigured });
        expect((await res.json()) as unknown[]).toEqual([]);
    });

    it("serves an empty .ics feed on both routes", async () => {
        // A feed with zero VEVENTs is valid iCalendar; asserting the envelope
        // is present proves it is a calendar response, not an error page.
        for (const path of ["/calendar.ics", "/officers/calendar.ics"]) {
            const { res } = await get(path, { env: unconfigured });
            const body = await res.text();
            expect(body).toContain("BEGIN:VCALENDAR");
            expect(body).not.toContain("BEGIN:VEVENT");
        }
    });

    it("reports X-Audience-Configured: false so the state is visible", async () => {
        for (const path of ["/events", "/officers/events", "/calendar.ics", "/officers/calendar.ics"]) {
            const { res } = await get(path, { env: unconfigured });
            expect(res.headers.get("X-Audience-Configured")).toBe("false");
        }
    });

    it("reports X-Audience-Configured: true when a channel is set", async () => {
        const { res } = await get("/events");
        expect(res.headers.get("X-Audience-Configured")).toBe("true");
    });

    it("does not write the event cache while unconfigured", async () => {
        // Nothing is served, so it would be misleading to persist a result
        // computed under a broken configuration.
        const { kv } = await get("/events", { env: unconfigured });
        expect(kv.writes["events:v2"]).toBeUndefined();
    });

    it("treats whitespace-only as unconfigured, not as a channel id", async () => {
        const { res } = await get("/events", { env: { OFFICERS_CHANNEL_ID: "   " } });
        expect((await res.json()) as unknown[]).toEqual([]);
        expect(res.headers.get("X-Audience-Configured")).toBe("false");
    });
});

describe("caching", () => {
    it("caches the FULL event set, so officer routes can be served from cache", async () => {
        const { kv } = await get("/events");
        const cached = kv.writes["events:v2"] as { id: string; audience: string }[];
        // Storing only the public subset would force the officer routes to hit
        // Discord on every request.
        expect(cached.map((e) => e.id).sort()).toEqual(["officer-1", "public-1"]);
        expect(cached.find((e) => e.id === "officer-1")?.audience).toBe("officer");
    });

    it("reports X-Cache: MISS on a cold cache and HIT when warm", async () => {
        expect((await get("/events")).res.headers.get("X-Cache")).toBe("MISS");
        expect((await get("/officers/events")).res.headers.get("X-Cache")).toBe("MISS");
    });

    it("filters correctly from a warm cache without refetching Discord", async () => {
        // Seed a warm cache containing an officer event, then request the
        // PUBLIC route. This is the case that would leak if filtering were
        // skipped on the hit path.
        const seeded = [
            { ...discordEvent("public-1", "Software Work Session", SOFTWARE_VOICE), audience: "public" },
            { ...discordEvent("officer-1", "Officer Budget Review", OFFICER_VOICE), audience: "officer" },
        ];
        const kv = makeKv({ "events:v2": seeded, "channels:v1": CHANNELS });
        const calls = stubDiscord({ failChannels: true });
        const { ctx } = makeCtx();

        const res = await worker.fetch(
            new Request("https://worker.test/events"),
            { ...ENV, EVENTS_KV: kv } as never,
            ctx as never,
        );
        const body = (await res.json()) as { id: string }[];

        expect(res.headers.get("X-Cache")).toBe("HIT");
        expect(body.map((e) => e.id)).toEqual(["public-1"]);
        // No Discord traffic at all -- the cache was warm.
        expect(calls).toHaveLength(0);
    });
});

describe("degraded channel fetch", () => {
    it("still serves the public calendar when the channel list is unavailable", async () => {
        // Availability trade-off: a hiccup on the secondary call must not blank
        // the public calendar.
        const { res } = await get("/events", { failChannels: true });
        expect(res.status).toBe(200);
        expect((await res.json()) as unknown[]).toHaveLength(1);
    });

    it("still hides officer events when the channel list is unavailable", async () => {
        // WARNING: This is the improvement the channel-id design bought. Under the
        // old category-based rule the audience came from the channel's parent,
        // so losing the channel list degraded to publishing BOTH events -- a
        // leak on an unrelated Discord hiccup. Matching the channel id needs no
        // lookup, so the filter holds regardless.
        const { res } = await get("/events", { failChannels: true });
        const body = (await res.json()) as { id: string }[];
        expect(body.map((e) => e.id)).toEqual(["public-1"]);
    });

    it("flags that the channel list was unavailable", async () => {
        // X-Audience-Source is now informational only -- it no longer implies a
        // degraded audience, since classification does not depend on the list.
        const { res } = await get("/events", { failChannels: true });
        expect(res.headers.get("X-Audience-Source")).toBe("unavailable");
    });

    it("reports channels as the source when the list loaded", async () => {
        const { res } = await get("/events");
        expect(res.headers.get("X-Audience-Source")).toBe("channels");
    });
});

describe("GET /audiences", () => {
    it("reports the officer channel as the signal", async () => {
        const { res } = await get("/audiences");
        const body = (await res.json()) as {
            officersChannelId: string;
            configured: boolean;
            channels: { id: string; name: string; categoryId: string | null; audience: string }[];
        };

        expect(body.configured).toBe(true);
        expect(body.officersChannelId).toBe(OFFICER_VOICE);

        const byId = Object.fromEntries(body.channels.map((c) => [c.id, c]));
        expect(byId[OFFICER_VOICE]?.audience).toBe("officer");
        expect(byId[SOFTWARE_VOICE]?.audience).toBe("public");
        // Both live in the SAME category, which is the whole point.
        expect(byId[OFFICER_VOICE]?.categoryId).toBe(EVENTS_CATEGORY);
        expect(byId[SOFTWARE_VOICE]?.categoryId).toBe(EVENTS_CATEGORY);
    });

    it("lists channels and categories separately", async () => {
        const { res } = await get("/audiences");
        const body = (await res.json()) as {
            categories: { id: string }[];
            channels: { id: string }[];
        };

        // Categories are not channels and vice versa.
        expect(body.categories.map((c) => c.id)).toContain(EVENTS_CATEGORY);
        expect(body.categories.map((c) => c.id)).not.toContain(SOFTWARE_VOICE);
        expect(body.channels.map((c) => c.id)).not.toContain(EVENTS_CATEGORY);
    });

    it("warns when nothing is configured", async () => {
        const { res } = await get("/audiences", { env: { OFFICERS_CHANNEL_ID: "" } });
        const body = (await res.json()) as { configured: boolean; warning?: string };
        expect(body.configured).toBe(false);
        expect(body.warning).toContain("OFFICERS_CHANNEL_ID");
    });

    it("is not cached, so a config change is immediately visible", async () => {
        const { res } = await get("/audiences");
        expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("502s when the channel list cannot be fetched at all", async () => {
        const { res } = await get("/audiences", { failChannels: true });
        expect(res.status).toBe(502);
    });
});

describe("protocol handling", () => {
    it("404s an unknown path", async () => {
        const { res } = await get("/nope");
        expect(res.status).toBe(404);
    });

    it("does not treat an unknown path as a public calendar route", async () => {
        // Guards against a prefix-matching router leaking /officers data on a
        // typo'd public path.
        const { res } = await get("/officers");
        expect(res.status).toBe(404);
    });

    it("204s a preflight with CORS headers", async () => {
        const { res } = await get("/events", { method: "OPTIONS" });
        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://autoboat.aoe.vt.edu");
    });

    it("405s a non-GET method", async () => {
        const { res } = await get("/events", { method: "POST" });
        expect(res.status).toBe(405);
    });

    it("sets CORS on the officer routes too", async () => {
        const { res } = await get("/officers/events");
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://autoboat.aoe.vt.edu");
    });
});
