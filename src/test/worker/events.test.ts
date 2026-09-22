import { rrulestr } from "rrule";
import { type DiscordGuildScheduledEvent, normalizeEvents } from "../../../worker/src/events";
import { buildCalendar } from "../../../worker/src/ics";
import { type CalendarEvent, describeRecurrence } from "../../lib/discord";

/**
 * Integration tests for the full Discord-payload -> calendar-feed path.
 *
 * The other Worker suites test their units in isolation: `recurrence.test.ts`
 * feeds `formatRecurrenceRule` hand-built rule objects, and `ics.test.ts`
 * feeds `buildCalendar` already-normalized events with a hand-written
 * `recurrenceRule` string. Neither would catch a break in the seam between
 * them -- e.g. the original bug where `index.ts` read Discord's
 * `recurrence_rule` object as a string, which the isolated tests could not
 * observe because they never passed a raw Discord payload through.
 *
 * These fixtures use the documented Discord wire shapes (snake_case fields,
 * numeric status/frequency, nested `entity_metadata`) and assert on the
 * emitted RFC 5545 output.
 */

const GUILD_ID = "1017960606403416085";
const NOW = new Date("2026-09-20T12:00:00.000Z");

/** A raw Discord scheduled event, with the documented field names. */
function discordEvent(partial: Partial<DiscordGuildScheduledEvent> = {}): DiscordGuildScheduledEvent {
    return {
        id: "1000000000000000001",
        guild_id: GUILD_ID,
        channel_id: "2000000000000000002",
        name: "Weekly Team Meeting",
        description: "Standing sync",
        scheduled_start_time: "2026-10-01T19:00:00.000Z",
        scheduled_end_time: "2026-10-01T20:00:00.000Z",
        privacy_level: 2,
        status: 1,
        entity_type: 2,
        entity_metadata: null,
        user_count: 12,
        image: null,
        recurrence_rule: null,
        ...partial,
    };
}

/** Raw payload -> normalized events -> .ics feed, as the Worker does it. */
function feedFrom(raw: DiscordGuildScheduledEvent[]): string[] {
    const normalized = normalizeEvents(raw);
    const ics = buildCalendar(normalized, {
        calendarName: "AutoBoat at Virginia Tech",
        guildId: GUILD_ID,
        refreshIntervalSeconds: 300,
        now: NOW,
    });
    return ics
        .replace(/\r\n[ \t]/g, "") // unfold continuation lines
        .split("\r\n")
        .filter(Boolean);
}

describe("Discord payload -> .ics feed", () => {
    it("emits RRULE: for a recurring event (the regression this guards)", () => {
        // Weekly on Wednesday, per Discord's documented rule object.
        const lines = feedFrom([
            discordEvent({
                recurrence_rule: {
                    start: "2026-10-01T19:00:00.000Z",
                    frequency: 2, // WEEKLY
                    interval: 1,
                    by_weekday: [2], // WEDNESDAY
                },
            }),
        ]);

        expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE");
        expect(lines).toContain("SUMMARY:Weekly Team Meeting");
        // One VEVENT carrying the rule -- clients expand it, we do not.
        expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    });

    it("does not emit RRULE: for a one-off event", () => {
        const lines = feedFrom([discordEvent()]);
        expect(lines.some((l) => l.startsWith("RRULE"))).toBe(false);
        expect(lines).toContain("SUMMARY:Weekly Team Meeting");
    });

    it("keeps the JSON and .ics representations consistent about recurrence", () => {
        const raw = discordEvent({
            recurrence_rule: {
                start: "2026-10-01T19:00:00.000Z",
                frequency: 3,
                interval: 1,
                by_weekday: [0, 1, 2, 3, 4],
            },
        });

        const [event] = normalizeEvents([raw]);
        const lines = feedFrom([raw]);

        // The flag the month grid keys off and the RRULE the feed emits must
        // agree; a mismatch is exactly the original bug.
        expect(event?.isRecurring).toBe(true);
        expect(event?.recurrenceRule).toBe("FREQ=DAILY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR");
        expect(lines).toContain(`RRULE:${event?.recurrenceRule}`);
    });

    it("produces an RRULE that expands to real occurrences", () => {
        const [event] = normalizeEvents([
            discordEvent({
                scheduled_start_time: "2026-10-02T19:00:00.000Z",
                scheduled_end_time: "2026-10-02T20:00:00.000Z",
                recurrence_rule: {
                    start: "2026-10-02T19:00:00.000Z",
                    frequency: 2,
                    interval: 1,
                    by_weekday: [4], // FRIDAY
                },
            }),
        ]);
        expect(event?.recurrenceRule).not.toBeNull();

        // This is what the website's expandRecurrences does with the value.
        const rule = rrulestr(`RRULE:${event?.recurrenceRule}`, { dtstart: new Date("2026-10-02T19:00:00.000Z") });
        const dates = rule
            .between(new Date("2026-10-01T00:00:00.000Z"), new Date("2026-10-31T23:59:59.000Z"), true)
            .map((d) => d.getUTCDate());

        expect(dates).toEqual([2, 9, 16, 23, 30]); // every Friday in Oct 2026
    });

    it("degrades to a single non-recurring event when the rule is unusable", () => {
        const lines = feedFrom([
            discordEvent({ recurrence_rule: { start: "2026-10-01T19:00:00.000Z", frequency: 99, interval: 1 } }),
        ]);
        expect(lines.some((l) => l.startsWith("RRULE"))).toBe(false);
        // The event still appears rather than being dropped.
        expect(lines).toContain("SUMMARY:Weekly Team Meeting");
    });

    it("normalizes the documented Discord field shapes", () => {
        const [event] = normalizeEvents([
            discordEvent({
                status: 4, // CANCELED
                entity_metadata: { location: "Squires 204" },
                user_count: 7,
                scheduled_end_time: null,
                image: "abc123",
            }),
        ]);

        expect(event).toEqual({
            id: "1000000000000000001",
            name: "Weekly Team Meeting",
            description: "Standing sync",
            start: "2026-10-01T19:00:00.000Z",
            end: null,
            status: "canceled",
            location: "Squires 204",
            userCount: 7,
            isRecurring: false,
            image: `https://cdn.discordapp.com/guild-events/1000000000000000001/abc123.png?size=512`,
            recurrenceRule: null,
            cancelledDates: [],
        });
    });

    it("marks a canceled recurring event CANCELLED while keeping its RRULE", () => {
        const lines = feedFrom([
            discordEvent({
                status: 4,
                recurrence_rule: { start: "2026-10-01T19:00:00.000Z", frequency: 2, interval: 1, by_weekday: [2] },
            }),
        ]);
        expect(lines).toContain("STATUS:CANCELLED");
        expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE");
    });

    it("defaults missing optional Discord fields instead of emitting null", () => {
        const lines = feedFrom([
            discordEvent({ description: null, entity_metadata: null, user_count: undefined, scheduled_end_time: null }),
        ]);
        expect(lines).toContain("SUMMARY:Weekly Team Meeting");
        expect(lines.some((l) => l.startsWith("DESCRIPTION"))).toBe(false);
        expect(lines).toContain("DTSTART:20261001T190000Z");
    });

    it("handles a mixed payload of recurring and one-off events", () => {
        const lines = feedFrom([
            discordEvent({
                id: "1",
                name: "Recurring",
                recurrence_rule: { start: "2026-10-01T19:00:00.000Z", frequency: 2, interval: 1, by_weekday: [2] },
            }),
            discordEvent({ id: "2", name: "One-off" }),
        ]);
        expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
        expect(lines.filter((l) => l.startsWith("RRULE"))).toHaveLength(1);
        expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE");
    });

    it("bounds a series that ends, via UNTIL from the rule's end date", () => {
        const lines = feedFrom([
            discordEvent({
                recurrence_rule: {
                    start: "2026-10-06T19:00:00.000Z",
                    end: "2026-11-03T19:00:00.000Z",
                    frequency: 2, // WEEKLY
                    interval: 1,
                    by_weekday: [1], // TUESDAY
                },
            }),
        ]);
        expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;UNTIL=20261103T190000Z");
    });

    it("leaves a series without an end date unbounded", () => {
        const lines = feedFrom([
            discordEvent({
                recurrence_rule: { start: "2026-10-06T19:00:00.000Z", frequency: 2, interval: 1, by_weekday: [1] },
            }),
        ]);
        const rrule = lines.find((l) => l.startsWith("RRULE"));
        expect(rrule).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU");
        expect(rrule).not.toContain("UNTIL");
    });

    it("reports the ending series in the recurrence description", () => {
        const [event] = normalizeEvents([
            discordEvent({
                recurrence_rule: {
                    start: "2026-10-06T19:00:00.000Z",
                    end: "2026-11-03T19:00:00.000Z",
                    frequency: 2,
                    interval: 1,
                    by_weekday: [1],
                },
            }),
        ]);
        // describeRecurrence (client-side) renders this; assert the converted
        // body is what feeds it.
        expect(event?.recurrenceRule).toContain("UNTIL=20261103T190000Z");
        expect(describeRecurrence(event as CalendarEvent)).toContain("until November 3, 2026");
    });

    // Discord has no per-occurrence exception mechanism; the team writes
    // skipped dates into the description. These cover the whole path:
    // description text -> parsed cancelledDates -> EXDATE in the feed.
    describe("cancellation notes in the description", () => {
        const recurringTuesday = (description: string) =>
            discordEvent({
                description,
                scheduled_start_time: "2026-10-06T19:00:00.000Z", // a Tuesday
                recurrence_rule: {
                    start: "2026-10-06T19:00:00.000Z",
                    frequency: 2, // WEEKLY
                    interval: 1,
                    by_weekday: [1], // TUESDAY
                },
            });

        it("emits EXDATE for a Cancelled: line, at the event's own time of day", () => {
            const lines = feedFrom([recurringTuesday("Location: **Lavery Hall 335**\nCancelled: October 11th 2026")]);

            expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU");
            // 19:00Z, matching DTSTART -- a midnight EXDATE would not exclude
            // an evening meeting.
            expect(lines).toContain("EXDATE:20261011T190000Z");
            expect(lines).toContain("DTSTART:20261006T190000Z");
        });

        it("emits several EXDATEs as one comma-separated property", () => {
            const note = "Cancelled: October 13th 2026, November 10th 2026";
            const lines = feedFrom([recurringTuesday(note)]);

            expect(lines).toContain("EXDATE:20261013T190000Z,20261110T190000Z");
            expect(lines.filter((l) => l.startsWith("EXDATE"))).toHaveLength(1);
        });

        it("emits a comma-before-year list as one EXDATE property", () => {
            // The team's real writing style mixes a bare year with a
            // comma-before-year in the same list.
            const note = "Location: **Lavery Hall 335**\nCancelled: October 13th 2026, November 10th, 2026";
            const lines = feedFrom([recurringTuesday(note)]);

            expect(lines).toContain("EXDATE:20261013T190000Z,20261110T190000Z");
            expect(lines.filter((l) => l.startsWith("EXDATE"))).toHaveLength(1);
        });

        it("emits a long list sorted, as one EXDATE property", () => {
            // Sorted because the parser sorts, and clients do not care about
            // order -- but a stable order keeps the feed byte-identical
            // between polls, which matters for KV caching and diffing.
            const note = "Cancelled: December 8th 2026, October 13th, 2026, November 10th 2026";
            const lines = feedFrom([recurringTuesday(note)]);

            expect(lines).toContain("EXDATE:20261013T190000Z,20261110T190000Z,20261208T190000Z");
        });

        it("omits EXDATE when the description has no cancellation note", () => {
            const lines = feedFrom([recurringTuesday("Just a normal sync.")]);
            expect(lines.some((l) => l.startsWith("EXDATE"))).toBe(false);
        });

        it("omits EXDATE on a one-off event even if a note is present", () => {
            // There is no RRULE, so there are no generated occurrences to
            // exclude; emitting EXDATE alone would be meaningless.
            const lines = feedFrom([
                discordEvent({
                    description: "Cancelled: October 11th 2026",
                    recurrence_rule: null,
                }),
            ]);
            expect(lines.some((l) => l.startsWith("RRULE"))).toBe(false);
            expect(lines.some((l) => l.startsWith("EXDATE"))).toBe(false);
        });

        it("does not emit EXDATE for a malformed cancellation date", () => {
            const lines = feedFrom([recurringTuesday("Cancelled: February 30th 2026")]);
            expect(lines.some((l) => l.startsWith("EXDATE"))).toBe(false);
        });

        it("exposes cancelledDates on the normalized event", () => {
            const [event] = normalizeEvents([
                recurringTuesday("Location: **Lavery Hall 335**\nCancelled: October 11th 2026"),
            ]);
            expect(event?.cancelledDates).toEqual(["2026-10-11"]);
        });

        // The dates surface as chips on the calendar, so the raw convention
        // must not reach the modal body.
        it("strips the Cancelled: line from the description", () => {
            const [event] = normalizeEvents([
                recurringTuesday("Location: **Lavery Hall 335**\nCancelled: October 11th 2026"),
            ]);
            expect(event?.description).toBe("Location: **Lavery Hall 335**");
            expect(event?.description).not.toContain("Cancelled");
        });

        it("strips a list-style note, leaving the rest of the description", () => {
            const [event] = normalizeEvents([
                recurringTuesday("Agenda: bring laptops.\nCancelled: October 13th 2026, November 10th, 2026"),
            ]);
            expect(event?.description).toBe("Agenda: bring laptops.");
        });

        it("nulls the description when the note was its only content", () => {
            const [event] = normalizeEvents([recurringTuesday("Cancelled: October 11th 2026")]);
            expect(event?.description).toBeNull();
        });

        it("leaves a description with no note untouched", () => {
            const [event] = normalizeEvents([recurringTuesday("Standing sync.")]);
            expect(event?.description).toBe("Standing sync.");
        });

        it("defaults cancelledDates to an empty array with no note", () => {
            const [event] = normalizeEvents([discordEvent({ description: "Nothing here" })]);
            expect(event?.cancelledDates).toEqual([]);
        });

        it("produces an EXDATE that actually excludes the occurrence from the RRULE", () => {
            // The EXDATE is only correct if it collides with a generated
            // occurrence; assert against the expansion rather than the text.
            const [event] = normalizeEvents([
                recurringTuesday("Location: **Lavery Hall 335**\nCancelled: October 13th 2026"),
            ]);
            const rule = rrulestr(`RRULE:${event?.recurrenceRule}`, {
                dtstart: new Date(event?.start as string),
            });
            const generated = rule
                .between(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-31T00:00:00Z"), true)
                .map((d) => d.toISOString().slice(0, 10));
            expect(generated).toContain("2026-10-13");
            expect(event?.cancelledDates).toContain("2026-10-13");
        });
    });
});
