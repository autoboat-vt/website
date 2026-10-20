/**
 * @jest-environment node
 *
 * Validation + Discord-payload construction. Pure, so no Worker runtime needed.
 */

import {
    ENTITY_EXTERNAL,
    ENTITY_VOICE,
    MAX_DESCRIPTION_LENGTH,
    MAX_NAME_LENGTH,
    PRIVACY_GUILD_ONLY,
    validateCreateEvent,
    validateRecurrence,
    withLocationLine,
} from "../../../worker/src/eventCreate";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const FUTURE = "2026-11-05T19:00:00.000Z";
const FUTURE_END = "2026-11-05T20:00:00.000Z";
const CHANNEL = "1550592611859955862";
const OFFICER_CHANNEL = "1550594891766308997";

function create(overrides: Record<string, unknown> = {}, officersChannelId: string | null = OFFICER_CHANNEL) {
    return validateCreateEvent(
        { name: "Software Meeting", start: FUTURE, channelId: CHANNEL, ...overrides },
        officersChannelId,
        NOW,
    );
}

/** Assert success and narrow the union. */
function expectOk(result: ReturnType<typeof validateCreateEvent>) {
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    return result.value;
}

describe("validateCreateEvent -- happy paths", () => {
    it("builds a VOICE event for a channel", () => {
        const value = expectOk(create());
        expect(value.body).toEqual({
            name: "Software Meeting",
            description: null,
            scheduled_start_time: FUTURE,
            entity_type: ENTITY_VOICE,
            privacy_level: PRIVACY_GUILD_ONLY,
            channel_id: CHANNEL,
        });
        // Discord requires entity_metadata to be ABSENT/null for VOICE.
        expect(value.body.entity_metadata).toBeUndefined();
    });

    it("includes an end time when given", () => {
        const value = expectOk(create({ end: FUTURE_END }));
        expect(value.body.scheduled_end_time).toBe(FUTURE_END);
    });

    it("builds an EXTERNAL event with a location and no channel", () => {
        const value = expectOk(create({ channelId: null, location: "Lavery Hall 335", end: FUTURE_END }));
        expect(value.body).toEqual({
            name: "Software Meeting",
            description: null,
            scheduled_start_time: FUTURE,
            scheduled_end_time: FUTURE_END,
            entity_type: ENTITY_EXTERNAL,
            privacy_level: PRIVACY_GUILD_ONLY,
            entity_metadata: { location: "Lavery Hall 335" },
        });
        expect(value.body.channel_id).toBeUndefined();
    });

    it("reports officerOnly for the officer channel", () => {
        expect(expectOk(create({ channelId: OFFICER_CHANNEL })).officerOnly).toBe(true);
        expect(expectOk(create({ channelId: CHANNEL })).officerOnly).toBe(false);
    });

    it("reports officerOnly false for an EXTERNAL event", () => {
        const value = expectOk(create({ channelId: null, location: "Zoom", end: FUTURE_END }));
        expect(value.officerOnly).toBe(false);
    });

    it("trims the name and description", () => {
        const value = expectOk(create({ name: "  Spaced  ", description: "  hello  " }));
        expect(value.body.name).toBe("Spaced");
        expect(value.body.description).toBe("hello");
    });

    it("accepts a start time up to 5 minutes in the past (grace for form fill time)", () => {
        const justPast = new Date(NOW.getTime() - 4 * 60 * 1000).toISOString();
        expectOk(create({ start: justPast }));
    });
});

describe("validateCreateEvent -- rejections", () => {
    it.each([
        ["a non-object", 42, "Expected a JSON object."],
        ["null", null, "Expected a JSON object."],
        ["an array", [], "Expected a JSON object."],
    ])("rejects %s", (_label, input, error) => {
        expect(validateCreateEvent(input, OFFICER_CHANNEL, NOW)).toEqual({ ok: false, error });
    });

    it("requires a name", () => {
        expect(create({ name: "   " })).toEqual({ ok: false, error: "Event name is required." });
        expect(create({ name: undefined })).toEqual({ ok: false, error: "Event name is required." });
    });

    it("enforces the name length limit", () => {
        expect(create({ name: "a".repeat(MAX_NAME_LENGTH + 1) })).toEqual({
            ok: false,
            error: `Event name must be ${MAX_NAME_LENGTH} characters or fewer.`,
        });
        expectOk(create({ name: "a".repeat(MAX_NAME_LENGTH) }));
    });

    it("enforces the description length limit", () => {
        expect(create({ description: "a".repeat(MAX_DESCRIPTION_LENGTH + 1) }).ok).toBe(false);
        expectOk(create({ description: "a".repeat(MAX_DESCRIPTION_LENGTH) }));
    });

    it("rejects an invalid start time", () => {
        expect(create({ start: "not-a-date" }).ok).toBe(false);
        expect(create({ start: "" }).ok).toBe(false);
        expect(create({ start: undefined }).ok).toBe(false);
    });

    it("rejects a start time well in the past", () => {
        const past = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
        expect(create({ start: past })).toEqual({ ok: false, error: "Start time must not be in the past." });
    });

    it("rejects an end time before the start", () => {
        expect(create({ end: "2026-11-05T18:00:00.000Z" })).toEqual({
            ok: false,
            error: "End time must be after the start time.",
        });
    });

    it("rejects an end time equal to the start", () => {
        expect(create({ end: FUTURE }).ok).toBe(false);
    });

    it("rejects a malformed end time", () => {
        expect(create({ end: "tomorrow" })).toEqual({
            ok: false,
            error: "End time must be a valid date and time.",
        });
    });

    it("requires a location for an EXTERNAL event", () => {
        expect(create({ channelId: null, end: FUTURE_END })).toEqual({
            ok: false,
            error: "An event without a Discord channel needs a location.",
        });
    });

    it("requires an end time for an EXTERNAL event", () => {
        expect(create({ channelId: null, location: "Lavery Hall 335" })).toEqual({
            ok: false,
            error: "An event without a Discord channel needs an end time.",
        });
    });

    it("enforces the location length limit", () => {
        expect(create({ location: "a".repeat(101) }).ok).toBe(false);
    });

    it.each(["abc", "12", "1".repeat(30)])("rejects a non-snowflake channel id %p", (channelId) => {
        expect(create({ channelId })).toEqual({ ok: false, error: "Discord channel id is invalid." });
    });
});

describe("withLocationLine", () => {
    it("adds a Location line to an empty description", () => {
        expect(withLocationLine(null, "Lavery Hall 335")).toBe("Location: Lavery Hall 335");
    });

    it("appends to an existing description, separated by a blank line", () => {
        expect(withLocationLine("Bring your laptop.", "Lavery Hall 335")).toBe(
            "Bring your laptop.\n\nLocation: Lavery Hall 335",
        );
    });

    it("does NOT duplicate an existing Location line", () => {
        const description = "Agenda: budget\nLocation: Lavery Hall 335";
        expect(withLocationLine(description, "Newman Library")).toBe(description);
    });

    it("does not duplicate a Where line either", () => {
        const description = "Where: Lavery Hall 335";
        expect(withLocationLine(description, "Newman Library")).toBe(description);
    });

    it("returns the description unchanged when there is no location", () => {
        expect(withLocationLine("Agenda", null)).toBe("Agenda");
        expect(withLocationLine(null, null)).toBeNull();
    });
});

describe("validateRecurrence", () => {
    const start = new Date(FUTURE);

    function ok(input: Parameters<typeof validateRecurrence>[0]) {
        const result = validateRecurrence(input, start);
        if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
        return result.rule;
    }

    it("converts a weekly rule", () => {
        expect(ok({ frequency: "WEEKLY", byWeekday: [2] })).toEqual({
            start: FUTURE,
            frequency: 2,
            interval: 1,
            by_weekday: [2],
        });
    });

    it("defaults the interval to 1", () => {
        expect(ok({ frequency: "WEEKLY", byWeekday: [2] }).interval).toBe(1);
    });

    it("allows every-other-week for WEEKLY", () => {
        expect(ok({ frequency: "WEEKLY", interval: 2, byWeekday: [4] }).interval).toBe(2);
    });

    it("converts a monthly Nth-weekday rule", () => {
        expect(ok({ frequency: "MONTHLY", byNWeekday: [{ n: 4, day: 2 }] })).toEqual({
            start: FUTURE,
            frequency: 1,
            interval: 1,
            by_n_weekday: [{ n: 4, day: 2 }],
        });
    });

    it("converts a yearly month+day rule", () => {
        expect(ok({ frequency: "YEARLY", byMonth: [7], byMonthDay: [24] })).toEqual({
            start: FUTURE,
            frequency: 0,
            interval: 1,
            by_month: [7],
            by_month_day: [24],
        });
    });

    it("converts an every-weekday daily rule", () => {
        expect(ok({ frequency: "DAILY", byWeekday: [0, 1, 2, 3, 4] }).by_weekday).toEqual([0, 1, 2, 3, 4]);
    });

    it("rejects an interval greater than 1 for non-weekly frequencies", () => {
        expect(validateRecurrence({ frequency: "DAILY", interval: 2 }, start)).toEqual({
            ok: false,
            error: "Discord only supports an interval greater than 1 for weekly events.",
        });
    });

    it("rejects an interval above 2", () => {
        expect(validateRecurrence({ frequency: "WEEKLY", interval: 3 }, start).ok).toBe(false);
    });

    it("rejects more than one weekday for a weekly event", () => {
        expect(validateRecurrence({ frequency: "WEEKLY", byWeekday: [1, 3] }, start)).toEqual({
            ok: false,
            error: "A weekly event repeats on exactly one day. Use daily for several days a week.",
        });
    });

    it("rejects mixing pattern families", () => {
        expect(
            validateRecurrence({ frequency: "MONTHLY", byWeekday: [1], byNWeekday: [{ n: 1, day: 1 }] }, start),
        ).toEqual({
            ok: false,
            error: "Pick one repeat pattern: days of the week, a week of the month, or a calendar date.",
        });
    });

    it("rejects an out-of-range weekday", () => {
        expect(validateRecurrence({ frequency: "WEEKLY", byWeekday: [7] }, start).ok).toBe(false);
        expect(validateRecurrence({ frequency: "WEEKLY", byWeekday: [-1] }, start).ok).toBe(false);
    });

    it("rejects an unsupported daily weekday set", () => {
        expect(validateRecurrence({ frequency: "DAILY", byWeekday: [0, 2, 4] }, start).ok).toBe(false);
    });

    it("rejects Nth-weekday on a non-monthly frequency", () => {
        expect(validateRecurrence({ frequency: "WEEKLY", byNWeekday: [{ n: 1, day: 1 }] }, start)).toEqual({
            ok: false,
            error: "A week-of-month pattern is only valid for monthly events.",
        });
    });

    it("rejects an out-of-range Nth-weekday week", () => {
        expect(validateRecurrence({ frequency: "MONTHLY", byNWeekday: [{ n: 6, day: 1 }] }, start).ok).toBe(false);
    });

    it("requires both month and day for a yearly rule", () => {
        expect(validateRecurrence({ frequency: "YEARLY", byMonth: [7] }, start)).toEqual({
            ok: false,
            error: "Discord supports one calendar date per yearly event.",
        });
    });

    it("rejects a calendar date on a non-yearly frequency", () => {
        expect(validateRecurrence({ frequency: "MONTHLY", byMonth: [7], byMonthDay: [24] }, start)).toEqual({
            ok: false,
            error: "A calendar date (month and day) is only valid for yearly events.",
        });
    });

    it("NEVER emits end or count -- Discord cannot accept them", () => {
        const rule = ok({ frequency: "WEEKLY", byWeekday: [2] });
        expect(rule).not.toHaveProperty("end");
        expect(rule).not.toHaveProperty("count");
    });

    it("carries the rule start from the event start", () => {
        // `start` is required by Discord even though the event has its own.
        expect(ok({ frequency: "DAILY" }).start).toBe(FUTURE);
    });
});

describe("validateCreateEvent -- recurrence integration", () => {
    it("attaches a validated rule to the Discord body", () => {
        const value = expectOk(create({ recurrence: { frequency: "WEEKLY", byWeekday: [2] } }));
        expect(value.body.recurrence_rule).toEqual({
            start: FUTURE,
            frequency: 2,
            interval: 1,
            by_weekday: [2],
        });
    });

    it("omits recurrence_rule entirely when there is none", () => {
        expect(expectOk(create()).body).not.toHaveProperty("recurrence_rule");
    });

    it("surfaces a recurrence error", () => {
        expect(create({ recurrence: { frequency: "WEEKLY", byWeekday: [1, 2] } })).toEqual({
            ok: false,
            error: "A weekly event repeats on exactly one day. Use daily for several days a week.",
        });
    });
});
