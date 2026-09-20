import { buildCalendar, type IcsEvent } from "../../../worker/src/ics";

/**
 * Tests for the Worker's iCalendar serializer. The module lives in
 * `worker/src/` (outside `src/`), so it is imported by relative path -- Jest's
 * transform and `TextEncoder` polyfill still apply to it.
 */

const NOW = new Date("2026-09-20T12:00:00.000Z");

function sampleEvent(partial: Partial<IcsEvent> & Pick<IcsEvent, "id" | "name" | "start">): IcsEvent {
    return {
        description: null,
        end: null,
        status: "scheduled",
        location: null,
        isRecurring: false,
        recurrenceRule: null,
        ...partial,
    };
}

function build(events: IcsEvent[], overrides: Partial<{ calendarName: string; guildId: string }> = {}) {
    return buildCalendar(events, {
        calendarName: overrides.calendarName ?? "AutoBoat at Virginia Tech",
        guildId: overrides.guildId ?? "1017960606403416085",
        refreshIntervalSeconds: 60,
        now: NOW,
    });
}

/** Split a CRLF feed into unfolding logical lines for easier assertions. */
function unfold(ics: string): string[] {
    return ics
        .replace(/\r\n[ \t]/g, "")
        .split("\r\n")
        .filter(Boolean);
}

describe("buildCalendar", () => {
    it("emits a well-formed VCALENDAR envelope with CRLF line endings", () => {
        const ics = build([]);
        expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
        expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
        // RFC 5545 requires CRLF; a bare LF breaks strict parsers.
        expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
        expect(ics).toContain("VERSION:2.0");
        expect(ics).toContain("CALSCALE:GREGORIAN");
        expect(ics).toContain("METHOD:PUBLISH");
        expect(ics).toContain("PRODID:-//AutoBoat at Virginia Tech//Events//EN");
    });

    it("advertises the calendar name and refresh interval", () => {
        const lines = unfold(build([]));
        expect(lines).toContain("X-WR-CALNAME:AutoBoat at Virginia Tech");
        expect(lines).toContain("X-WR-TIMEZONE:UTC");
        expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT60S");
        expect(lines).toContain("X-PUBLISHED-TTL:PT60S");
    });

    it("serializes an event to UTC timestamps with a stable UID and Discord URL", () => {
        const lines = unfold(
            build([
                sampleEvent({
                    id: "12345",
                    name: "General Body Meeting",
                    start: "2026-10-01T19:00:00.000Z",
                    end: "2026-10-01T20:00:00.000Z",
                }),
            ]),
        );

        expect(lines).toContain("DTSTART:20261001T190000Z");
        expect(lines).toContain("DTEND:20261001T200000Z");
        expect(lines).toContain("DTSTAMP:20260920T120000Z");
        expect(lines).toContain("UID:discord-12345@autoboat.aoe.vt.edu");
        expect(lines).toContain("SUMMARY:General Body Meeting");
        expect(lines).toContain("URL:https://discord.com/channels/1017960606403416085/12345");
        expect(lines).toContain("STATUS:CONFIRMED");
    });

    it("honours end times that include a non-UTC offset", () => {
        const lines = unfold(
            build([
                sampleEvent({
                    id: "tz",
                    name: "Offset event",
                    start: "2026-10-01T15:00:00-04:00",
                    end: "2026-10-01T16:00:00-04:00",
                }),
            ]),
        );
        expect(lines).toContain("DTSTART:20261001T190000Z");
        expect(lines).toContain("DTEND:20261001T200000Z");
    });

    it("gives zero-duration events a one-hour block (DTEND must exceed DTSTART)", () => {
        const lines = unfold(
            build([
                sampleEvent({
                    id: "zero",
                    name: "Announcement",
                    start: "2026-10-01T19:00:00.000Z",
                    end: "2026-10-01T19:00:00.000Z",
                }),
            ]),
        );
        // RFC 5545 forbids DTEND == DTSTART; some clients reject the feed.
        expect(lines).toContain("DTSTART:20261001T190000Z");
        expect(lines).toContain("DTEND:20261001T200000Z");
    });

    it("treats a null end time as a one-hour default block", () => {
        const lines = unfold(
            build([sampleEvent({ id: "noend", name: "No end", start: "2026-10-01T19:00:00.000Z", end: null })]),
        );
        expect(lines).toContain("DTEND:20261001T200000Z");
    });

    it("maps canceled events to STATUS:CANCELLED and keeps them in the feed", () => {
        const lines = unfold(
            build([
                sampleEvent({
                    id: "canceled",
                    name: "Canceled practice",
                    start: "2026-10-01T19:00:00.000Z",
                    status: "canceled",
                }),
            ]),
        );
        expect(lines).toContain("STATUS:CANCELLED");
        // The event still appears -- subscribers should see the cancellation.
        expect(lines).toContain("SUMMARY:Canceled practice");
    });

    it("escapes TEXT values and folds them onto single logical lines", () => {
        const lines = unfold(
            build([
                sampleEvent({
                    id: "escape",
                    name: "Sparks, Semicolons; and \\slashes",
                    description: "Line one\nLine two",
                    location: "Holden Hall, Room 101; Blacksburg",
                    start: "2026-10-01T19:00:00.000Z",
                }),
            ]),
        );
        // Commas, semicolons, and backslashes are escaped; newlines become \n.
        expect(lines).toContain("SUMMARY:Sparks\\, Semicolons\\; and \\\\slashes");
        expect(lines).toContain("DESCRIPTION:Line one\\nLine two");
        expect(lines).toContain("LOCATION:Holden Hall\\, Room 101\\; Blacksburg");
    });

    it("folds long lines to 75 octets with a leading-space continuation", () => {
        const longName = "A".repeat(200);
        const ics = build([sampleEvent({ id: "fold", name: longName, start: "2026-10-01T19:00:00.000Z" })]);
        // Raw (folded) lines must each be <= 75 octets.
        for (const raw of ics.split("\r\n")) {
            expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(75);
        }
        // Unfolding restores the original value intact.
        expect(unfold(ics)).toContain(`SUMMARY:${longName}`);
    });

    it("folds multi-byte characters without splitting a code point", () => {
        // Each of these is 3 UTF-8 bytes; naive slicing at 75 chars would
        // corrupt the sequence and produce invalid UTF-8.
        const emojiTitle = "\u{1F6A4}".repeat(40);
        const ics = build([sampleEvent({ id: "utf8", name: emojiTitle, start: "2026-10-01T19:00:00.000Z" })]);
        for (const raw of ics.split("\r\n")) {
            expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(75);
        }
        expect(unfold(ics)).toContain(`SUMMARY:${emojiTitle}`);
    });

    it("emits an RRULE for recurring events instead of expanding occurrences", () => {
        const lines = unfold(
            build([
                sampleEvent({
                    id: "rec",
                    name: "Weekly standup",
                    start: "2026-10-01T19:00:00.000Z",
                    isRecurring: true,
                    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TH",
                }),
            ]),
        );
        expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TH");
        // A single VEVENT carries the rule; clients expand it themselves.
        expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
        expect(lines.filter((l) => l === "END:VEVENT")).toHaveLength(1);
    });

    it("drops a malformed recurrence rule rather than emitting it", () => {
        const lines = unfold(
            build([
                sampleEvent({
                    id: "badrule",
                    name: "Bad rule",
                    start: "2026-10-01T19:00:00.000Z",
                    isRecurring: true,
                    recurrenceRule: "not-a-rule",
                }),
            ]),
        );
        expect(lines.some((l) => l.startsWith("RRULE"))).toBe(false);
        // The event itself still serializes as a single occurrence.
        expect(lines).toContain("SUMMARY:Bad rule");
    });

    it("skips events with unparseable dates without breaking the feed", () => {
        const lines = unfold(
            build([
                sampleEvent({ id: "bad", name: "Broken", start: "not-a-date" }),
                sampleEvent({ id: "good", name: "Fine", start: "2026-10-01T19:00:00.000Z" }),
            ]),
        );
        expect(lines).toContain("SUMMARY:Fine");
        expect(lines).not.toContain("SUMMARY:Broken");
        expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    });

    it("omits optional properties when the source event has none", () => {
        const lines = unfold(build([sampleEvent({ id: "bare", name: "Bare", start: "2026-10-01T19:00:00.000Z" })]));
        expect(lines.some((l) => l.startsWith("DESCRIPTION"))).toBe(false);
        expect(lines.some((l) => l.startsWith("LOCATION"))).toBe(false);
    });

    it("serializes multiple events into separate VEVENT blocks", () => {
        const ics = build([
            sampleEvent({ id: "a", name: "First", start: "2026-10-01T19:00:00.000Z" }),
            sampleEvent({ id: "b", name: "Second", start: "2026-10-02T19:00:00.000Z" }),
        ]);
        expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
        expect(ics.match(/END:VEVENT/g)).toHaveLength(2);
    });
});
