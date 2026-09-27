/**
 * @jest-environment node
 *
 * WARNING: Node environment, not jsdom. This suite drives the Worker's real
 * `fetch` handler, which needs global `Request`/`Response` -- jsdom does not
 * provide them, so under jsdom every test fails with
 * `ReferenceError: Request is not defined`.
 */

import { GUILD_CATEGORY } from "../../../worker/src/audience";
import worker, { filterByChannels, parseChannelFilter } from "../../../worker/src/index";

/**
 * Tests for the `?channels=` filter on the Worker's event routes.
 *
 * This is the server half of the calendar's channel filter: the website
 * generates `?channels=<id>,<id>` so a user can subscribe to just their
 * subteam. Two properties are worth more than the rest and are pinned here:
 *
 *  1. An ABSENT or blank filter means "everything", never "nothing" -- a
 *     malformed query must never be able to blank a subscription.
 *  2. Filtering must NOT multiply KV writes. The cached value is always the
 *     full set, so any filter reuses the same one-write-per-miss path.
 */

const EVENTS_CATEGORY = "1000";
const OFFICER_VOICE = "1002";
const SOFTWARE_VOICE = "2001";
const MECHANICAL_VOICE = "2002";

const CHANNELS = [
    { id: EVENTS_CATEGORY, name: "Events", type: GUILD_CATEGORY, parent_id: null },
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
    discordEvent("software-1", "Software Work Session", SOFTWARE_VOICE),
    discordEvent("mech-1", "Mechanical Build Night", MECHANICAL_VOICE),
    // No channel: an EXTERNAL-style event. Must not appear in any filtered view.
    discordEvent("no-channel-1", "Virtual Info Session", null),
];

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
    CACHE_TTL_SECONDS: "180",
    OFFICERS_CHANNEL_ID: OFFICER_VOICE,
};

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

function stubDiscord() {
    global.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/channels")) {
            return new Response(JSON.stringify(CHANNELS), { status: 200 });
        }
        if (url.includes("/scheduled-events")) {
            return new Response(JSON.stringify(RAW_EVENTS), { status: 200 });
        }
        return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;
}

const realFetch = global.fetch;

afterEach(() => {
    global.fetch = realFetch;
});

async function get(path: string, kv = makeKv()) {
    stubDiscord();
    const { ctx, promises } = makeCtx();
    const res = await worker.fetch(
        new Request(`https://worker.test${path}`),
        { ...ENV, EVENTS_KV: kv } as never,
        ctx as never,
    );
    await Promise.all(promises);
    return { res, kv };
}

async function idsFor(path: string): Promise<string[]> {
    const { res } = await get(path);
    const body = (await res.json()) as { id: string }[];
    return body.map((e) => e.id).sort();
}

describe("parseChannelFilter", () => {
    it("parses a comma-separated id list", () => {
        const params = new URLSearchParams("channels=a,b,c");
        expect([...parseChannelFilter(params)].sort()).toEqual(["a", "b", "c"]);
    });

    it("merges a repeated parameter", () => {
        // Query builders differ on which form they emit; accepting both avoids
        // a filter silently applying only its first value.
        const params = new URLSearchParams("channels=a&channels=b");
        expect([...parseChannelFilter(params)].sort()).toEqual(["a", "b"]);
    });

    it("tolerates whitespace and empty entries", () => {
        const params = new URLSearchParams("channels= a , ,b ");
        expect([...parseChannelFilter(params)].sort()).toEqual(["a", "b"]);
    });

    it("returns an empty set when the parameter is absent", () => {
        expect(parseChannelFilter(new URLSearchParams("")).size).toBe(0);
    });

    it("returns an empty set for a blank value", () => {
        expect(parseChannelFilter(new URLSearchParams("channels=")).size).toBe(0);
        expect(parseChannelFilter(new URLSearchParams("channels=  ,  ")).size).toBe(0);
    });
});

describe("filterByChannels", () => {
    const events = [{ channelId: SOFTWARE_VOICE }, { channelId: OFFICER_VOICE }, { channelId: null }] as never[];

    it("returns every event unchanged for an empty filter", () => {
        // The failure this prevents: a blank `?channels=` blanking a feed.
        expect(filterByChannels(events, new Set())).toBe(events);
    });

    it("keeps only the matching channel", () => {
        expect(filterByChannels(events, new Set([SOFTWARE_VOICE]))).toEqual([{ channelId: SOFTWARE_VOICE }]);
    });

    it("never matches a channel-less event", () => {
        expect(filterByChannels(events, new Set([SOFTWARE_VOICE, OFFICER_VOICE]))).toHaveLength(2);
    });
});

describe("?channels= on the JSON route", () => {
    it("returns everything when the filter is absent", async () => {
        // The channel-less event is included here on purpose: with no filter,
        // every public event is served. It is only a filtered view that keeps
        // it out.
        expect(await idsFor("/events")).toEqual(["mech-1", "no-channel-1", "software-1"]);
    });

    it("narrows to the selected channel", async () => {
        expect(await idsFor(`/events?channels=${SOFTWARE_VOICE}`)).toEqual(["software-1"]);
    });

    it("accepts several channels", async () => {
        expect(await idsFor(`/events?channels=${SOFTWARE_VOICE},${MECHANICAL_VOICE}`)).toEqual([
            "mech-1",
            "software-1",
        ]);
    });

    it("excludes an event with no channel even when other groups are selected", async () => {
        const ids = await idsFor(`/events?channels=${SOFTWARE_VOICE},${MECHANICAL_VOICE}`);
        expect(ids).not.toContain("no-channel-1");
    });

    it("returns an empty list for a channel with no events", async () => {
        expect(await idsFor("/events?channels=000000000000000000")).toEqual([]);
    });

    it("cannot be used to reveal officer events through the public route", async () => {
        // The audience filter still runs first, so naming the officer channel
        // explicitly must not leak it.
        expect(await idsFor(`/events?channels=${OFFICER_VOICE}`)).toEqual([]);
    });

    it("can select the officer channel once the audience allows it", async () => {
        expect(await idsFor(`/officers/events?channels=${OFFICER_VOICE}`)).toEqual(["officer-1"]);
    });

    it("ignores an unknown query parameter", async () => {
        expect(await idsFor("/events?bogus=1")).toEqual(["mech-1", "no-channel-1", "software-1"]);
    });
});

describe("?channels= on the .ics route", () => {
    it("includes only the selected channel's events", async () => {
        const { res } = await get(`/calendar.ics?channels=${SOFTWARE_VOICE}`);
        const body = await res.text();
        expect(body).toContain("Software Work Session");
        expect(body).not.toContain("Mechanical Build Night");
    });

    it("still emits a valid calendar envelope when the filter matches nothing", async () => {
        const { res } = await get("/calendar.ics?channels=000000000000000000");
        const body = await res.text();
        expect(body).toContain("BEGIN:VCALENDAR");
        expect(body).not.toContain("BEGIN:VEVENT");
    });
});

describe("?channels= and the KV write budget", () => {
    it("costs exactly one write, on the same key, regardless of the filter", async () => {
        // A filtered view is served from the SAME cache entry; the filter runs
        // after the cache read. If this ever became a second key (e.g. caching
        // per-filter), the free tier's 1,000 writes/day would be blown and the
        // calendar would blank until 00:00 UTC.
        for (const path of ["/events", `/events?channels=${SOFTWARE_VOICE}`, "/officers/events?channels=x"]) {
            const { kv } = await get(path);
            expect(Object.keys(kv.writes)).toEqual(["events:v2"]);
        }
    });

    it("filters from a warm cache without any Discord traffic", async () => {
        // The stored side is the NORMALIZED `CalendarEvent` the Worker writes
        // (note `channelId`, not Discord's `channel_id`) -- seeding a raw
        // payload here would exercise a shape the Worker never stores.
        const seeded = [
            {
                ...discordEvent("software-1", "Software Work Session", SOFTWARE_VOICE),
                channelId: SOFTWARE_VOICE,
                audience: "public",
            },
            {
                ...discordEvent("mech-1", "Mechanical Build Night", MECHANICAL_VOICE),
                channelId: MECHANICAL_VOICE,
                audience: "public",
            },
        ];
        const kv = makeKv({ "events:v2": { fetchedAt: Date.now(), events: seeded } });
        const calls: string[] = [];
        global.fetch = (async (input: RequestInfo | URL) => {
            calls.push(String(input));
            return new Response("unexpected", { status: 404 });
        }) as unknown as typeof fetch;
        const { ctx } = makeCtx();

        const res = await worker.fetch(
            new Request(`https://worker.test/events?channels=${SOFTWARE_VOICE}`),
            { ...ENV, EVENTS_KV: kv } as never,
            ctx as never,
        );
        const body = (await res.json()) as { id: string }[];

        expect(res.headers.get("X-Cache")).toBe("HIT");
        expect(body.map((e) => e.id)).toEqual(["software-1"]);
        expect(calls).toHaveLength(0);
    });
});
