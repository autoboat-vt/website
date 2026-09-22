import { rrulestr } from "rrule";
import { type DiscordRecurrenceRule, formatRecurrenceRule } from "../../../worker/src/recurrence";

/**
 * Tests for the Worker's Discord-recurrence -> RFC 5545 RRULE conversion.
 * The module lives in `worker/src/` (outside `src/`), so it is imported by
 * relative path -- same pattern as `ics.test.ts`.
 */

function rule(partial: Partial<DiscordRecurrenceRule>): DiscordRecurrenceRule {
    return {
        start: "2026-10-01T19:00:00.000Z",
        frequency: 2, // WEEKLY
        interval: 1,
        ...partial,
    };
}

describe("formatRecurrenceRule", () => {
    it("converts a weekly rule with a weekday", () => {
        expect(formatRecurrenceRule(rule({ frequency: 2, interval: 1, by_weekday: [2] }))).toBe(
            "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE",
        );
    });

    it("converts an every-other-week rule", () => {
        expect(formatRecurrenceRule(rule({ frequency: 2, interval: 2, by_weekday: [2] }))).toBe(
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
        );
    });

    it("converts a daily rule covering weekdays", () => {
        expect(formatRecurrenceRule(rule({ frequency: 3, interval: 1, by_weekday: [0, 1, 2, 3, 4] }))).toBe(
            "FREQ=DAILY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR",
        );
    });

    it("converts a monthly Nth-weekday rule into an ordinal BYDAY", () => {
        // {n: 4, day: 2} == 4th Wednesday == BYDAY=4WE
        expect(formatRecurrenceRule(rule({ frequency: 1, interval: 1, by_n_weekday: [{ n: 4, day: 2 }] }))).toBe(
            "FREQ=MONTHLY;INTERVAL=1;BYDAY=4WE",
        );
    });

    it("converts a yearly rule with by_month and by_month_day", () => {
        expect(formatRecurrenceRule(rule({ frequency: 0, interval: 1, by_month: [7], by_month_day: [24] }))).toBe(
            "FREQ=YEARLY;INTERVAL=1;BYMONTH=7;BYMONTHDAY=24",
        );
    });

    it("maps every documented frequency code", () => {
        expect(formatRecurrenceRule(rule({ frequency: 0 }))).toContain("FREQ=YEARLY");
        expect(formatRecurrenceRule(rule({ frequency: 1 }))).toContain("FREQ=MONTHLY");
        expect(formatRecurrenceRule(rule({ frequency: 2 }))).toContain("FREQ=WEEKLY");
        expect(formatRecurrenceRule(rule({ frequency: 3 }))).toContain("FREQ=DAILY");
    });

    it("returns null for a missing rule", () => {
        expect(formatRecurrenceRule(null)).toBeNull();
        expect(formatRecurrenceRule(undefined)).toBeNull();
    });

    it("returns null for an unknown frequency rather than emitting a bad rule", () => {
        expect(formatRecurrenceRule(rule({ frequency: 99 }))).toBeNull();
    });

    it("omits INTERVAL when it is missing or non-positive but keeps the rest", () => {
        expect(formatRecurrenceRule(rule({ interval: 0 }))).toBe("FREQ=WEEKLY");
        expect(formatRecurrenceRule(rule({ interval: -3 }))).toBe("FREQ=WEEKLY");
    });

    it("drops out-of-range days instead of emitting an invalid BYDAY", () => {
        // 9 is not a weekday code; only the valid 2 (WE) survives.
        expect(formatRecurrenceRule(rule({ by_weekday: [9, 2] }))).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=WE");
        // An all-invalid list drops BYDAY entirely.
        expect(formatRecurrenceRule(rule({ by_weekday: [42] }))).toBe("FREQ=WEEKLY;INTERVAL=1");
    });

    it("drops out-of-range months and month days", () => {
        expect(formatRecurrenceRule(rule({ frequency: 0, by_month: [0, 13], by_month_day: [32] }))).toBe(
            "FREQ=YEARLY;INTERVAL=1",
        );
    });

    it("prefers by_weekday when both by_day fields are present", () => {
        expect(formatRecurrenceRule(rule({ by_weekday: [1], by_n_weekday: [{ n: 4, day: 2 }] }))).toBe(
            "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU",
        );
    });

    it("converts the rule's end date into a UTC UNTIL", () => {
        expect(formatRecurrenceRule(rule({ by_weekday: [1], end: "2026-11-03T19:00:00.000Z" }))).toBe(
            "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;UNTIL=20261103T190000Z",
        );
    });

    it("places UNTIL last so it terminates the rule", () => {
        const body = formatRecurrenceRule(
            rule({ frequency: 0, interval: 1, by_month: [7], by_month_day: [24], end: "2027-07-24T19:00:00.000Z" }),
        );
        expect(body?.endsWith(";UNTIL=20270724T190000Z")).toBe(true);
        // Exactly one UNTIL, at the end.
        expect(body?.match(/UNTIL=/g)).toHaveLength(1);
    });

    it("omits UNTIL when there is no end date", () => {
        expect(formatRecurrenceRule(rule({ by_weekday: [1] }))).not.toContain("UNTIL");
        expect(formatRecurrenceRule(rule({ by_weekday: [1], end: null }))).not.toContain("UNTIL");
    });

    it("drops an unparseable end date rather than emitting a bad UNTIL", () => {
        // An unbounded rule is a better failure than a malformed UNTIL that
        // makes clients reject the entire RRULE.
        expect(formatRecurrenceRule(rule({ by_weekday: [1], end: "not-a-date" }))).toBe(
            "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU",
        );
    });

    it("bounds expansion at UNTIL", () => {
        const body = formatRecurrenceRule(rule({ by_weekday: [4], end: "2026-10-16T19:00:00.000Z" }));
        const parsed = rrulestr(`RRULE:${body}`, { dtstart: new Date("2026-10-02T19:00:00.000Z") });
        const dates = parsed
            .between(new Date("2026-10-01T00:00:00.000Z"), new Date("2027-10-01T00:00:00.000Z"), true)
            .map((d) => d.getUTCDate());
        // Fridays Oct 2, 9, 16 -- then stop. Unbounded would run for a year.
        expect(dates).toEqual([2, 9, 16]);
    });

    it("produces rules the rrule package can parse and expand", () => {
        // The real contract: both consumers feed the result to rrulestr, so
        // an emitted body must be a valid RRULE rather than merely look right.
        const body = formatRecurrenceRule(rule({ frequency: 2, interval: 1, by_weekday: [4] }));
        expect(body).not.toBeNull();

        const parsed = rrulestr(`RRULE:${body}`, { dtstart: new Date("2026-10-02T19:00:00.000Z") });
        const occurrences = parsed.between(
            new Date("2026-10-01T00:00:00.000Z"),
            new Date("2026-10-31T23:59:59.000Z"),
            true,
        );
        // Every Friday in October 2026: the 2nd, 9th, 16th, 23rd, and 30th.
        expect(occurrences.map((d) => d.getUTCDate())).toEqual([2, 9, 16, 23, 30]);
    });
});
