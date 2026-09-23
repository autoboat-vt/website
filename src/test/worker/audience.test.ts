import {
    type AudienceConfig,
    audienceConfigFromEnv,
    audienceForChannel,
    audienceIsConfigured,
    DEFAULT_OFFICERS_CHANNEL_ID,
    type DiscordChannel,
    GUILD_CATEGORY,
    isOfficerEvent,
    listCategories,
    listChannels,
    parseChannelIds,
} from "../../../worker/src/audience";

/**
 * Tests for audience classification -- the module that decides which events
 * reach the public calendar.
 *
 * This is the security-relevant surface: a bug here publishes officer events
 * rather than throwing, so the assertions are deliberately explicit about the
 * fail-open direction rather than only testing the happy path.
 *
 * WARNING: The fixture models the REAL guild layout: every event voice channel --
 * officer, subteam, and general member -- sits under ONE shared category. That
 * is what makes the category useless as a signal and the channel id the real
 * one. A fixture with a dedicated officers category would test a layout that
 * does not exist and would pass while the real site leaked.
 */

// One category for every event channel. Shared on purpose.
const EVENTS_CATEGORY = "1000";

const OFFICER_VOICE = "1100";
const SOFTWARE_VOICE = "1101";
const GENERAL_VOICE = "1102";

const CHANNELS: DiscordChannel[] = [
    { id: EVENTS_CATEGORY, name: "Events", type: GUILD_CATEGORY, parent_id: null },
    { id: "1001", name: "Officers", type: GUILD_CATEGORY, parent_id: null },
    // Officer-permission voice channel in the SAME category as the public ones.
    // Its parent is identical to theirs, which is why only the channel id can
    // separate them.
    { id: OFFICER_VOICE, name: "Officer Voice", type: 2, parent_id: EVENTS_CATEGORY },
    { id: SOFTWARE_VOICE, name: "Software Voice", type: 2, parent_id: EVENTS_CATEGORY },
    { id: GENERAL_VOICE, name: "General Voice", type: 2, parent_id: EVENTS_CATEGORY },
    // A voice channel with NO parent (top-level in the guild).
    { id: "9001", name: "Lobby", type: 2, parent_id: null },
];

const CONFIG: AudienceConfig = {
    officersChannelId: OFFICER_VOICE,
    publicCategoryIds: [EVENTS_CATEGORY],
};

describe("parseChannelIds", () => {
    it.each([
        ["100,200", ["100", "200"]],
        ["100, 200", ["100", "200"]],
        ["100,200,", ["100", "200"]], // trailing comma, the common habit
        [" 100\n200 ", ["100", "200"]], // newline + indentation from JSONC
        ["100", ["100"]],
    ])("parses %j", (raw, expected) => {
        expect(parseChannelIds(raw)).toEqual(expected);
    });

    it.each([undefined, "", "   ", ",,"])("returns [] for %j", (raw) => {
        expect(parseChannelIds(raw)).toEqual([]);
    });
});

describe("audienceConfigFromEnv", () => {
    it("defaults to the real officer channel", () => {
        // The committed default is the verified officer voice channel, so a
        // deploy that forgets the env var still hides officer events rather
        // than publishing them.
        const config = audienceConfigFromEnv({});
        expect(config.officersChannelId).toBe(DEFAULT_OFFICERS_CHANNEL_ID);
        expect(DEFAULT_OFFICERS_CHANNEL_ID).toBe("1550594891766308997");
        expect(audienceIsConfigured(config)).toBe(true);
    });

    it("reports UNCONFIGURED when the channel is blanked out", () => {
        // A blank override means "no officer channel". It must never fall back
        // to the default -- an operator who cleared it would find events still
        // hidden -- and must never silently look configured either.
        for (const blank of ["", "   ", ","]) {
            const config = audienceConfigFromEnv({ OFFICERS_CHANNEL_ID: blank });
            expect(config.officersChannelId).toBeNull();
            expect(audienceIsConfigured(config)).toBe(false);
        }
    });

    it("does not fall back to the default after being blanked", () => {
        // Stated separately because it is the specific regression that a naive
        // `?? default` would introduce.
        expect(audienceConfigFromEnv({ OFFICERS_CHANNEL_ID: "" }).officersChannelId).not.toBe(
            DEFAULT_OFFICERS_CHANNEL_ID,
        );
    });

    it("honours an explicit override", () => {
        const config = audienceConfigFromEnv({ OFFICERS_CHANNEL_ID: "4242" });
        expect(config.officersChannelId).toBe("4242");
        expect(audienceIsConfigured(config)).toBe(true);
    });

    it("uses the first id when several are provided", () => {
        // There is exactly one officer channel. Taking the first keeps a
        // mistaken list from silently hiding events in extra channels.
        expect(audienceConfigFromEnv({ OFFICERS_CHANNEL_ID: "4242,9999" }).officersChannelId).toBe("4242");
    });

    it("falls back to the documented public list when unset", () => {
        expect(audienceConfigFromEnv({}).publicCategoryIds.length).toBeGreaterThan(0);
    });

    it("gives the officer id a snowflake shape", () => {
        // Guards a hand-copied id: a typo or truncated id would classify nothing
        // as officer, publishing the officer calendar. Discord snowflakes are
        // 17-20 digits.
        expect(DEFAULT_OFFICERS_CHANNEL_ID).toMatch(/^\d{17,20}$/);
    });

    it("gives every documented public id a snowflake shape", () => {
        for (const id of audienceConfigFromEnv({}).publicCategoryIds) {
            expect(id).toMatch(/^\d{17,20}$/);
        }
    });
});

describe("audienceForChannel", () => {
    it("classifies the officer voice channel as officer", () => {
        expect(audienceForChannel(OFFICER_VOICE, CONFIG, CHANNELS)).toBe("officer");
    });

    it("hides an officer event even though its category is the shared one", () => {
        // The core assertion of the design, stated without relying on the
        // fixture's naming: same parent category, opposite audience.
        const officer = audienceForChannel(OFFICER_VOICE, CONFIG, CHANNELS);
        const member = audienceForChannel(GENERAL_VOICE, CONFIG, CHANNELS);
        const parentOf = (id: string) => CHANNELS.find((c) => c.id === id)?.parent_id;
        expect(parentOf(OFFICER_VOICE)).toBe(parentOf(GENERAL_VOICE));
        expect(officer).toBe("officer");
        expect(member).toBe("public");
    });

    it.each([
        [SOFTWARE_VOICE, "software voice"],
        [GENERAL_VOICE, "general member voice"],
        ["9001", "a channel with no parent"],
        ["unknown", "an unrecognised channel"],
    ])("classifies %s (%s) as public", (channelId) => {
        expect(audienceForChannel(channelId, CONFIG, CHANNELS)).toBe("public");
    });

    it("classifies an unknown channel as public (fail-open, as specified)", () => {
        // The team asked for subteam + general member events to be public and
        // only officer events hidden, so anything that is not the one officer
        // channel is public. The trade-off is documented in audience.ts: a
        // second officer channel would leak until its id is configured.
        expect(audienceForChannel("unknown", CONFIG, CHANNELS)).toBe("public");
    });

    it("classifies an event with no channel as public", () => {
        expect(audienceForChannel(null, CONFIG, CHANNELS)).toBe("public");
    });

    it("does not treat a channel that merely contains the id as officer", () => {
        // Guards a substring/prefix comparison creeping in: ids are opaque
        // strings, so 1100 and 11001 are unrelated channels.
        expect(audienceForChannel("11001", CONFIG, CHANNELS)).toBe("public");
        expect(audienceForChannel("1", CONFIG, CHANNELS)).toBe("public");
    });

    it("still hides officer events when the channel LIST is unavailable", () => {
        // WARNING: Regression guard. The earlier category-based rule needed the
        // channel list to resolve a parent, so a Discord hiccup on that
        // secondary call degraded to publishing officer events. Classification
        // is now a string comparison needing no lookup, so it cannot degrade.
        expect(audienceForChannel(OFFICER_VOICE, CONFIG, [])).toBe("officer");
    });

    it("keeps officer and public events distinct with an empty channel list", () => {
        expect(audienceForChannel(OFFICER_VOICE, CONFIG, [])).toBe("officer");
        expect(audienceForChannel(SOFTWARE_VOICE, CONFIG, [])).toBe("public");
    });

    it("treats every channel as public when unconfigured", () => {
        // The fail-open default of the pure function. Note the ROUTE layer
        // refuses to serve anything in this state (eventsForRoute), so this is
        // not reachable as a leak through the public calendar.
        const unconfigured: AudienceConfig = { officersChannelId: null, publicCategoryIds: [] };
        expect(audienceForChannel(OFFICER_VOICE, unconfigured, CHANNELS)).toBe("public");
    });
});

describe("isOfficerEvent", () => {
    it("flags an event in the officer voice channel", () => {
        expect(isOfficerEvent({ channelId: OFFICER_VOICE }, CONFIG, CHANNELS)).toBe(true);
    });

    it("does not flag a subteam event", () => {
        expect(isOfficerEvent({ channelId: SOFTWARE_VOICE }, CONFIG, CHANNELS)).toBe(false);
    });

    it("does not flag a general member event", () => {
        expect(isOfficerEvent({ channelId: GENERAL_VOICE }, CONFIG, CHANNELS)).toBe(false);
    });

    it("does not flag an event with no channel", () => {
        expect(isOfficerEvent({ channelId: null }, CONFIG, CHANNELS)).toBe(false);
    });
});

describe("listChannels", () => {
    it("returns non-category channels with their category", () => {
        // This is the list an operator reads a channel id off of.
        const list = listChannels(CHANNELS);
        expect(list.map((c) => c.id)).not.toContain(EVENTS_CATEGORY);
        expect(list.find((c) => c.id === OFFICER_VOICE)).toEqual({
            id: OFFICER_VOICE,
            name: "Officer Voice",
            categoryId: EVENTS_CATEGORY,
        });
    });
});

describe("listCategories", () => {
    it("returns only categories, sorted by name", () => {
        const categories = listCategories(CHANNELS);
        expect(categories.map((c) => c.name)).toEqual(["Events", "Officers"]);
        // Voice channels must not appear.
        expect(categories.map((c) => c.id)).not.toContain(SOFTWARE_VOICE);
    });
});
