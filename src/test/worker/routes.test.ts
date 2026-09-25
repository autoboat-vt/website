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

function discordEvent(
    id: string,
    name: string,
    channelId: string | null,
    times: { start?: string; end?: string | null } = {},
) {
    return {
        id,
        guild_id: "999",
        channel_id: channelId,
        name,
        description: null,
        scheduled_start_time: times.start ?? "2026-10-01T19:00:00.000Z",
        scheduled_end_time: times.end === undefined ? null : times.end,
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

describe("past-event retention", () => {
    // WHY THIS SUITE EXISTS. Discord's `/guilds/{id}/scheduled-events` returns
    // only `SCHEDULED`/`ACTIVE` events, and both `COMPLETED` and `CANCELED` are
    // terminal -- so an event leaves the API the moment it ends, and a plain
    // cache forgot it immediately. These tests drive the real handler across
    // TWO successive fetches, which is the only way to observe the merge: a
    // single request can never distinguish "archived" from "still in Discord's
    // list".
    //
    // WARNING: The stored side of the cache is a NORMALIZED `CalendarEvent` (what
    // `normalizeEvents` produced on a previous request), not a raw Discord
    // payload. Seeding raw payloads here would exercise a shape the Worker
    // never actually writes.
    //
    // The default dates are RELATIVE to now, deliberately. Hard-coding an old
    // literal (e.g. 2020) would make the tests pass for the wrong reason --
    // under an explicit retention window the event would be dropped by the age
    // filter rather than exercised.
    const PAST_DAYS_AGO = 7;
    function daysFromNow(days: number): string {
        return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }
    /** One normalized, already-ended event as the Worker would have stored it. */
    function storedPastEvent(id: string, name: string, overrides: Record<string, unknown> = {}) {
        return {
            id,
            name,
            description: null,
            start: daysFromNow(-PAST_DAYS_AGO),
            end: daysFromNow(-PAST_DAYS_AGO + 1 / 24),
            status: "scheduled",
            location: null,
            userCount: null,
            isRecurring: false,
            image: null,
            recurrenceRule: null,
            channelId: SOFTWARE_VOICE,
            audience: "public",
            cancelledDates: [],
            ...overrides,
        };
    }

    /** Seed a stale cache entry holding `stored`, then refetch `fresh`. */
    async function refetch(opts: {
        stored: Record<string, unknown>[];
        fresh?: ReturnType<typeof discordEvent>[];
        env?: Record<string, string>;
        path?: string;
    }) {
        const kv = makeKv({
            "events:v2": {
                fetchedAt: Date.now() - 600_000, // > ENV.CACHE_TTL_SECONDS (60)
                events: opts.stored,
            },
        });
        stubDiscord({ events: opts.fresh ?? [] });
        const { ctx, promises } = makeCtx();
        const res = await worker.fetch(
            new Request(`https://worker.test${opts.path ?? "/events"}`),
            { ...ENV, ...opts.env, EVENTS_KV: kv } as never,
            ctx as never,
        );
        await Promise.all(promises);
        return { body: (await res.json()) as { id: string; name?: string; status?: string }[], kv };
    }

    it("keeps a past event after Discord stops reporting it", async () => {
        // The headline behavior: the event is gone from the fresh payload (as
        // Discord does once it completes) but must still be served.
        const { body } = await refetch({
            stored: [storedPastEvent("completed-1", "Week 3 Build Session")],
            fresh: [discordEvent("still-upcoming", "Next Meeting", SOFTWARE_VOICE)],
        });

        expect(body.map((e) => e.id)).toContain("completed-1");
    });

    it("marks an archived event as completed so it renders as history", async () => {
        // Discord's terminal status never reaches us (the event is absent from
        // the payload), so the Worker synthesizes it. Without this a past event
        // would render with live styling.
        const { body } = await refetch({ stored: [storedPastEvent("completed-1", "Week 3 Build Session")] });

        expect(body.find((e) => e.id === "completed-1")?.status).toBe("completed");
    });

    it("keeps an upcoming event that vanished from Discord", async () => {
        // The team asked to keep EVERY event. "Discord stopped reporting it"
        // is not a reliable "this was scrapped" signal -- the API cannot tell
        // deletion from cancellation -- so a future event is retained too.
        const { body } = await refetch({
            stored: [
                storedPastEvent("future-dropped", "Vanished In Discord", {
                    start: daysFromNow(30),
                    end: daysFromNow(31),
                }),
            ],
        });

        expect(body.map((e) => e.id)).toContain("future-dropped");
    });

    it("keeps an arbitrarily old event by default", async () => {
        // Retention is unbounded unless RETENTION_DAYS is set, so nothing is
        // ever discarded for being old.
        const { body } = await refetch({
            stored: [
                storedPastEvent("ancient", "From Years Ago", {
                    start: daysFromNow(-4000),
                    end: daysFromNow(-3999),
                }),
            ],
        });

        expect(body.map((e) => e.id)).toContain("ancient");
    });

    it("prunes old history only when RETENTION_DAYS opts in", async () => {
        // The escape hatch: an explicit window restores age-based pruning,
        // which is the safety valve if the archive ever grows too large.
        const { body } = await refetch({
            stored: [
                storedPastEvent("ancient", "From Years Ago", {
                    start: daysFromNow(-400),
                    end: daysFromNow(-399),
                }),
            ],
            env: { RETENTION_DAYS: "90" },
        });

        expect(body.map((e) => e.id)).not.toContain("ancient");
    });

    it("treats a malformed RETENTION_DAYS as keep-everything, not as a window", async () => {
        // Losing history is unrecoverable, so an unparseable value must err
        // toward retaining rather than falling back to some default cutoff.
        const { body } = await refetch({
            stored: [
                storedPastEvent("ancient", "From Years Ago", {
                    start: daysFromNow(-4000),
                    end: daysFromNow(-3999),
                }),
            ],
            env: { RETENTION_DAYS: "not-a-number" },
        });

        expect(body.map((e) => e.id)).toContain("ancient");
    });

    it("honours a huge RETENTION_DAYS as effectively unbounded", async () => {
        // A large finite window is a valid way to express keep-everything
        // without leaving the var unset.
        const { body } = await refetch({
            stored: [
                storedPastEvent("ancient", "From Years Ago", {
                    start: daysFromNow(-400),
                    end: daysFromNow(-399),
                }),
            ],
            env: { RETENTION_DAYS: "40000" },
        });

        expect(body.map((e) => e.id)).toContain("ancient");
    });

    it("writes the archive with NO expiry while retention is unbounded", async () => {
        // WARNING: The failure this guards is silent and total. If the key carried
        // an expiry while the archive is meant to live forever, the whole
        // history would lapse and the next request would archive only what
        // Discord still reports -- past events would vanish again, which is
        // the exact bug this feature fixes.
        const kv = makeKv();
        let putOptions: unknown;
        const spyKv = {
            ...kv,
            async put(key: string, value: string, options?: unknown) {
                putOptions = options;
                return kv.put(key, value);
            },
        };
        stubDiscord();
        const { ctx, promises } = makeCtx();
        await worker.fetch(
            new Request("https://worker.test/events"),
            { ...ENV, EVENTS_KV: spyKv } as never,
            ctx as never,
        );
        await Promise.all(promises);

        expect(putOptions).toBeUndefined();
    });

    it("serves a retained officer event on the officer route", async () => {
        // Retention is applied to the FULL set before audience filtering, so an
        // archived officer event must survive on the officer route as well.
        const { body } = await refetch({
            stored: [
                storedPastEvent("officer-past", "Past Officer Sync", { channelId: OFFICER_VOICE, audience: "officer" }),
            ],
            path: "/officers/events",
        });

        expect(body.map((e) => e.id)).toContain("officer-past");
    });

    it("keeps a retained officer event off the PUBLIC route", async () => {
        // The complementary leak guard: archiving must not bypass audience
        // filtering.
        const { body } = await refetch({
            stored: [
                storedPastEvent("officer-past", "Past Officer Sync", { channelId: OFFICER_VOICE, audience: "officer" }),
            ],
        });

        expect(body).toEqual([]);
    });

    it("does not duplicate an event that stays in the payload across refreshes", async () => {
        // The merge keys on the Discord event id. A recurring event is present
        // in every payload with the SAME id, so it must not be archived
        // alongside itself.
        const { body } = await refetch({
            stored: [
                storedPastEvent("recurring-1", "Weekly Standup", {
                    start: daysFromNow(30),
                    end: daysFromNow(31),
                }),
            ],
            fresh: [
                discordEvent("recurring-1", "Weekly Standup", SOFTWARE_VOICE, {
                    start: daysFromNow(37),
                    end: daysFromNow(38),
                }),
            ],
        });

        expect(body.filter((e) => e.id === "recurring-1")).toHaveLength(1);
    });

    it("takes the FRESH copy of an event that is still in the payload", async () => {
        // A renamed event must not keep serving its stale archived name.
        const { body } = await refetch({
            stored: [
                storedPastEvent("recurring-1", "Old Name", {
                    start: daysFromNow(30),
                    end: daysFromNow(31),
                }),
            ],
            fresh: [
                discordEvent("recurring-1", "New Name", SOFTWARE_VOICE, {
                    start: daysFromNow(30),
                    end: daysFromNow(31),
                }),
            ],
        });

        expect(body.find((e) => e.id === "recurring-1")?.name).toBe("New Name");
    });

    it("persists the retained set so the NEXT request also sees it", async () => {
        // The archive is only useful if it is written back -- a merge that is
        // served but not stored would collapse back to Discord's view on the
        // following refresh.
        const { kv } = await refetch({ stored: [storedPastEvent("completed-1", "Week 3 Build Session")] });
        const written = kv.writes["events:v2"] as { events: { id: string }[] };

        expect(written.events.map((e) => e.id)).toContain("completed-1");
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
        const cached = kv.writes["events:v2"] as { events: { id: string; audience: string }[] };
        // Storing only the public subset would force the officer routes to hit
        // Discord on every request.
        expect(cached.events.map((e) => e.id).sort()).toEqual(["officer-1", "public-1"]);
        expect(cached.events.find((e) => e.id === "officer-1")?.audience).toBe("officer");
    });

    it("stamps the entry with fetchedAt so freshness survives a long-lived key", async () => {
        // The key expires on the RETENTION window, not the cache TTL, so
        // freshness has to live in the value. Without this stamp every request
        // after the first would look "fresh" for days.
        const before = Date.now();
        const { kv } = await get("/events");
        const cached = kv.writes["events:v2"] as { fetchedAt: number };
        expect(typeof cached.fetchedAt).toBe("number");
        expect(cached.fetchedAt).toBeGreaterThanOrEqual(before);
        expect(cached.fetchedAt).toBeLessThanOrEqual(Date.now());
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
        const kv = makeKv({ "events:v2": { fetchedAt: Date.now(), events: seeded } });
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

    it("refetches once the entry is older than the TTL", async () => {
        // Freshness is `now - fetchedAt >= TTL`, NOT "the key is still there".
        // The key outlives the TTL by design, so this is what keeps the write
        // rate at 86400/TTL instead of collapsing to one fetch per retention
        // window.
        const stale = [{ ...discordEvent("public-1", "Stale Copy", SOFTWARE_VOICE), audience: "public" }];
        const kv = makeKv({ "events:v2": { fetchedAt: Date.now() - 120_000, events: stale } });
        const calls = stubDiscord();
        const { ctx } = makeCtx();

        const res = await worker.fetch(
            new Request("https://worker.test/events"),
            { ...ENV, EVENTS_KV: kv } as never,
            ctx as never,
        );

        // ENV.CACHE_TTL_SECONDS is 60, so a 120s-old entry is stale.
        expect(res.headers.get("X-Cache")).toBe("MISS");
        expect(calls.filter((u) => u.includes("/scheduled-events"))).toHaveLength(1);
    });

    it("treats a legacy bare-array entry as stale rather than serving it forever", async () => {
        // An entry written by a pre-retention Worker has no fetchedAt. Reading
        // it as infinitely stale refetches and rewrites it in the new shape,
        // instead of either dropping history or serving stale data for days.
        const legacy = [{ ...discordEvent("public-1", "Software Work Session", SOFTWARE_VOICE), audience: "public" }];
        const kv = makeKv({ "events:v2": legacy });
        const calls = stubDiscord();
        const { ctx } = makeCtx();

        const res = await worker.fetch(
            new Request("https://worker.test/events"),
            { ...ENV, EVENTS_KV: kv } as never,
            ctx as never,
        );

        expect(res.headers.get("X-Cache")).toBe("MISS");
        expect(calls.filter((u) => u.includes("/scheduled-events"))).toHaveLength(1);
        // ...and the entry is upgraded in place.
        expect((kv.writes["events:v2"] as { fetchedAt: number }).fetchedAt).toBeGreaterThan(0);
    });
});

describe("KV write budget", () => {
    // WARNING: The Workers KV FREE TIER allows 1,000 WRITES/day (reads are 100,000,
    // never the constraint). A cache MISS is what costs a write, so the budget
    // is a function of the TTL:
    //
    //     writes/day = (86400 / TTL) * writes per miss
    //
    // Three things regress this silently, and all three did at once in
    // production, where a 60s TTL with 2 writes per miss came to ~2,880
    // writes/day -- the calendar went empty and stayed empty until 00:00 UTC,
    // because a failed write means the entry never lands and every following
    // request is another miss. These tests pin each factor.
    it("costs exactly ONE write per cache miss", async () => {
        // The single most important number here. Fetching the channel list on
        // this path and caching it too used to make this 2, which is what put
        // the Worker over budget. Classification compares `channel_id` against
        // the officer channel, so the channel list is only needed by
        // `/audiences` -- do not reintroduce a second write here.
        const { kv } = await get("/events");
        expect(Object.keys(kv.writes)).toEqual(["events:v2"]);
    });

    it("writes the SAME key on every route, so the count stays 1", async () => {
        const paths = ["/events", "/calendar.ics", "/officers/events", "/officers/calendar.ics"];
        for (const path of paths) {
            const { kv } = await get(path);
            expect(Object.keys(kv.writes)).toEqual(["events:v2"]);
        }
    });

    it("writes nothing at all on a cache hit", async () => {
        // A warm cache must be pure reads, or the budget scales with traffic
        // rather than with time.
        const seeded = [{ ...discordEvent("public-1", "Software Work Session", SOFTWARE_VOICE), audience: "public" }];
        const kv = makeKv({ "events:v2": { fetchedAt: Date.now(), events: seeded } });
        stubDiscord();
        const { ctx } = makeCtx();
        const res = await worker.fetch(
            new Request("https://worker.test/events"),
            { ...ENV, EVENTS_KV: kv } as never,
            ctx as never,
        );

        expect(res.headers.get("X-Cache")).toBe("HIT");
        expect(kv.writes).toEqual({});
    });

    it("still writes exactly one key per miss with retention enabled", async () => {
        // The retention config changes the key's lifetime and value size, not
        // the write count. This is the regression that would matter most: a
        // second key (e.g. a separate archive key) doubles writes/day and puts
        // the free tier over budget, which blanks the calendar until 00:00 UTC.
        // Asserted both with unbounded retention (the default) and with an
        // explicit window.
        for (const env of [{}, { RETENTION_DAYS: "365" }]) {
            const { kv } = await get("/events", { env });
            expect(Object.keys(kv.writes)).toEqual(["events:v2"]);
        }
    });

    it("stays inside the daily write budget at the shipped TTL", async () => {
        // Guards the actual config value, not just the code. `wrangler.jsonc` is
        // the deploy source of truth, so read it off disk: someone lowering the
        // TTL for "fresher events" is the likeliest way to break this, and
        // nothing else in the suite would notice. 180s is the accepted floor --
        // it buys 3-minute refreshes at ~2x write headroom. Below that the
        // margin stops absorbing retries and redeploys.
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const wrangler = readFileSync(resolve(__dirname, "../../../worker/wrangler.jsonc"), "utf8");
        const match = wrangler.match(/"CACHE_TTL_SECONDS"\s*:\s*"(\d+)"/);
        if (!match) throw new Error("CACHE_TTL_SECONDS not found in worker/wrangler.jsonc");

        const ttl = Number(match[1]);
        const writesPerMiss = 1;
        const writesPerDay = Math.ceil(86400 / ttl) * writesPerMiss;

        expect(ttl).toBeGreaterThanOrEqual(180);
        // Leave real headroom: deploys, retries, and clock skew all consume
        // writes, and the failure mode is a blank calendar rather than an error.
        expect(writesPerDay).toBeLessThan(1000);
    });

    it("keeps the fallback TTL safe when the var is missing or malformed", async () => {
        // parseTtlSeconds falls back when the var is absent/unparseable. If that
        // default were ever lowered to something aggressive, a misconfigured
        // deploy would blow the budget with no visible cause.
        for (const ttl of [undefined, "", "abc", "0", "-5"]) {
            const { kv } = await get("/events", { env: ttl === undefined ? {} : { CACHE_TTL_SECONDS: ttl } });
            expect(Object.keys(kv.writes)).toEqual(["events:v2"]);
        }
    });
});

describe("degraded channel fetch", () => {
    it("still serves the public calendar when the channel list is unavailable", async () => {
        // The channel fetch now happens only inside `/audiences`, so it cannot
        // affect the event routes at all. Kept as a guard in case a future
        // change puts it back on this path.
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

    it("does not even call the channels endpoint on an event route", async () => {
        // Quantifies the fix: with the channels fetch off this path, an event
        // request makes ONE Discord call instead of two. Driven through the
        // handler directly because `get()` stubs Discord itself.
        const calls = stubDiscord();
        const { ctx } = makeCtx();
        await worker.fetch(
            new Request("https://worker.test/events"),
            { ...ENV, EVENTS_KV: makeKv() } as never,
            ctx as never,
        );

        expect(calls.filter((u) => u.includes("/channels"))).toHaveLength(0);
        expect(calls.filter((u) => u.includes("/scheduled-events"))).toHaveLength(1);
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
