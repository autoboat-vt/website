import { type AudienceConfig, GUILD_CATEGORY } from "../../../worker/src/audience";
import { type CalendarEvent, normalizeEvents, publicEvents } from "../../../worker/src/events";

/**
 * Tests for audience filtering through the normalize step, plus the invariant
 * the route handlers depend on (`publicEvents` keeps only public events).
 *
 * These exercise real Discord wire shapes, including `channel_id` on voice
 * events -- the field the classification actually keys off.
 *
 * WARNING: The fixture uses ONE shared event category for officer and public
 * channels, matching the real guild. Classification keys off the channel id.
 */

const EVENTS_CATEGORY = "1000";
const OFFICER_VOICE = "1002";
const SOFTWARE_VOICE = "2001";

const CHANNELS = [
    { id: EVENTS_CATEGORY, name: "Events", type: GUILD_CATEGORY, parent_id: null },
    { id: "1001", name: "Officers", type: GUILD_CATEGORY, parent_id: null },
    // Same parent category, opposite audience: only the id can separate them.
    { id: OFFICER_VOICE, name: "Officer Voice", type: 2, parent_id: EVENTS_CATEGORY },
    { id: SOFTWARE_VOICE, name: "Software Voice", type: 2, parent_id: EVENTS_CATEGORY },
];

const CONFIG: AudienceConfig = {
    officersChannelId: OFFICER_VOICE,
};

/** A raw Discord voice event -- entity_metadata is null for voice events. */
function discordEvent(partial: Record<string, unknown> = {}) {
    return {
        id: "1",
        guild_id: "999",
        channel_id: "2001",
        name: "Weekly Team Meeting",
        description: null,
        scheduled_start_time: "2026-10-01T19:00:00.000Z",
        scheduled_end_time: "2026-10-01T20:00:00.000Z",
        privacy_level: 2,
        status: 1,
        entity_type: 2,
        entity_metadata: null,
        user_count: 5,
        image: null,
        recurrence_rule: null,
        ...partial,
    } as never;
}

describe("normalizeEvents with channels", () => {
    it("carries channel_id through to the normalized event", () => {
        // The classification needs this field, so dropping it silently would
        // make every event public.
        const [event] = normalizeEvents([discordEvent()], { channels: CHANNELS, audienceConfig: CONFIG });
        expect(event?.channelId).toBe("2001");
    });

    it("marks a subteam event public", () => {
        const [event] = normalizeEvents([discordEvent({ channel_id: "2001" })], {
            channels: CHANNELS,
            audienceConfig: CONFIG,
        });
        expect(event?.audience).toBe("public");
    });

    it("marks an officer event officer", () => {
        const [event] = normalizeEvents([discordEvent({ channel_id: "1002" })], {
            channels: CHANNELS,
            audienceConfig: CONFIG,
        });
        expect(event?.audience).toBe("officer");
    });

    it("defaults to public when no channels are supplied", () => {
        // The fail-open default, matching audience.ts. Note this is about the
        // omitted *config*, not the channel list -- an explicit officer channel
        // stays officer even with no channel data (see audience.test.ts).
        const [event] = normalizeEvents([discordEvent({ channel_id: "1002" })]);
        expect(event?.audience).toBe("public");
    });

    it("marks an officer event officer even with no channel list", () => {
        // Guards the degraded mode: classification by channel id needs no
        // lookup, so a Discord hiccup on the channel fetch cannot leak.
        const [event] = normalizeEvents([discordEvent({ channel_id: OFFICER_VOICE })], {
            channels: [],
            audienceConfig: CONFIG,
        });
        expect(event?.audience).toBe("officer");
    });

    it("classifies each event independently within one payload", () => {
        const events = normalizeEvents(
            [
                discordEvent({ id: "a", channel_id: "1002", name: "Officer Sync" }),
                discordEvent({ id: "b", channel_id: "2001", name: "Software Work Session" }),
                discordEvent({ id: "c", channel_id: null, name: "Channel-less" }),
            ],
            { channels: CHANNELS, audienceConfig: CONFIG },
        );

        expect(events.map((e) => [e.name, e.audience])).toEqual([
            ["Officer Sync", "officer"],
            ["Software Work Session", "public"],
            ["Channel-less", "public"],
        ]);
    });

    it("combines audience classification with the other normalizations", () => {
        // Guards the seam: adding classification must not disturb cancellation
        // parsing or recurrence conversion.
        const [event] = normalizeEvents(
            [
                discordEvent({
                    channel_id: "1002",
                    description: "Plan the term.\nCancelled: October 11th 2026",
                    recurrence_rule: { start: "2026-10-01T19:00:00.000Z", frequency: 2, interval: 1, by_weekday: [2] },
                }),
            ],
            { channels: CHANNELS, audienceConfig: CONFIG },
        );

        expect(event?.audience).toBe("officer");
        expect(event?.isRecurring).toBe(true);
        expect(event?.recurrenceRule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=WE");
        expect(event?.cancelledDates).toEqual(["2026-10-11"]);
        expect(event?.description).toBe("Plan the term.");
    });
});

describe("publicEvents", () => {
    it("drops officer events and keeps everything else", () => {
        const events = [
            { id: "a", audience: "public" },
            { id: "b", audience: "officer" },
            { id: "c", audience: "public" },
        ] as CalendarEvent[];

        expect(publicEvents(events).map((e) => e.id)).toEqual(["a", "c"]);
    });

    it("returns an empty array for an all-officer set", () => {
        const events = [{ id: "a", audience: "officer" }] as CalendarEvent[];
        expect(publicEvents(events)).toEqual([]);
    });

    it("preserves order", () => {
        const events = [
            { id: "z", audience: "public" },
            { id: "a", audience: "public" },
        ] as CalendarEvent[];
        expect(publicEvents(events).map((e) => e.id)).toEqual(["z", "a"]);
    });
});
