import { parseCancelledDates, stripCancelledNote, toExdateValue } from "../../../worker/src/cancellations";

/**
 * Tests for the in-description cancellation convention:
 *
 *     Location: **Lavery Hall 335**
 *     Cancelled: October 11th 2026
 *
 * Discord's API cannot express a per-occurrence exception (no
 * `EXDATE`-equivalent field on the recurrence rule object), so the team writes
 * skipped dates into the description. This parser is the only thing that turns
 * that prose into data, so its accepted shapes are pinned here.
 *
 * Imports `worker/src/cancellations.ts` by relative path -- Jest's `testMatch`
 * only covers `src/**`, so a Worker-module test must live here to run (same
 * pattern as `ics.test.ts` / `recurrence.test.ts`).
 */
describe("parseCancelledDates", () => {
    const YEAR = 2026;

    describe("the documented convention", () => {
        it("parses the canonical two-line example", () => {
            const desc = "Location: **Lavery Hall 335**\nCancelled: October 11th 2026";
            expect(parseCancelledDates(desc, YEAR)).toEqual(["2026-10-11"]);
        });

        it("parses a bare label with no other lines", () => {
            expect(parseCancelledDates("Cancelled: October 11th 2026", YEAR)).toEqual(["2026-10-11"]);
        });

        it("parses dates without the ordinal suffix", () => {
            expect(parseCancelledDates("Cancelled: October 11 2026", YEAR)).toEqual(["2026-10-11"]);
        });

        it("parses a comma before the year", () => {
            expect(parseCancelledDates("Cancelled: Oct 11, 2026", YEAR)).toEqual(["2026-10-11"]);
        });

        it("parses the ISO form", () => {
            expect(parseCancelledDates("Cancelled: 2026-10-11", YEAR)).toEqual(["2026-10-11"]);
        });
    });

    describe("label variants", () => {
        it.each([
            ["Cancelled", "Cancelled: October 11th 2026"],
            ["Canceled (US spelling)", "Canceled: October 11th 2026"],
            ["Skipped", "Skipped: October 11th 2026"],
            ["No meeting", "No meeting: October 11th 2026"],
            ["lowercase", "cancelled: october 11th 2026"],
            ["ALL CAPS", "CANCELLED: OCTOBER 11TH 2026"],
            ["en dash separator", "Cancelled - October 11th 2026"],
            ["leading whitespace", "   Cancelled: October 11th 2026"],
        ])("accepts the %s label", (_label, line) => {
            expect(parseCancelledDates(line, YEAR)).toEqual(["2026-10-11"]);
        });
    });

    describe("multiple dates", () => {
        it("parses several dates on one line", () => {
            const out = parseCancelledDates("Cancelled: October 11th 2026, November 8th 2026", YEAR);
            expect(out).toEqual(["2026-10-11", "2026-11-08"]);
        });

        // The team's actual writing style mixes a bare year with a
        // comma-before-year in the same list, so both must parse.
        it("parses the mixed comma style used in real notes", () => {
            const out = parseCancelledDates("Cancelled: October 11th 2026, November 3rd, 2026", YEAR);
            expect(out).toEqual(["2026-10-11", "2026-11-03"]);
        });

        it("parses a list where every item has a comma before the year", () => {
            const out = parseCancelledDates("Cancelled: October 11th, 2026, November 3rd, 2026", YEAR);
            expect(out).toEqual(["2026-10-11", "2026-11-03"]);
        });

        it("parses a list of three or more dates", () => {
            const out = parseCancelledDates(
                "Cancelled: October 11th 2026, November 3rd, 2026, December 1st 2026",
                YEAR,
            );
            expect(out).toEqual(["2026-10-11", "2026-11-03", "2026-12-01"]);
        });

        it("parses a comma-separated list with no year anywhere", () => {
            const out = parseCancelledDates("Cancelled: October 11th, November 3rd", YEAR);
            expect(out).toEqual(["2026-10-11", "2026-11-03"]);
        });

        it("parses a list mixing month-name and ISO forms", () => {
            const out = parseCancelledDates("Cancelled: October 11th 2026, 2026-11-03", YEAR);
            expect(out).toEqual(["2026-10-11", "2026-11-03"]);
        });

        it("parses a list separated by semicolons", () => {
            const out = parseCancelledDates("Cancelled: October 11th 2026; November 3rd, 2026", YEAR);
            expect(out).toEqual(["2026-10-11", "2026-11-03"]);
        });

        it("parses a list separated by 'and'", () => {
            const out = parseCancelledDates("Cancelled: October 11th 2026 and November 3rd, 2026", YEAR);
            expect(out).toEqual(["2026-10-11", "2026-11-03"]);
        });

        it("parses several Cancelled lines", () => {
            const desc = "Cancelled: October 11th 2026\nSome other note\nCancelled: November 8th 2026";
            expect(parseCancelledDates(desc, YEAR)).toEqual(["2026-10-11", "2026-11-08"]);
        });

        it("deduplicates a date listed twice", () => {
            const desc = "Cancelled: October 11th 2026\nCancelled: Oct 11 2026";
            expect(parseCancelledDates(desc, YEAR)).toEqual(["2026-10-11"]);
        });

        it("deduplicates within a single comma-separated list", () => {
            expect(parseCancelledDates("Cancelled: October 11th 2026, October 11th, 2026", YEAR)).toEqual([
                "2026-10-11",
            ]);
        });

        it("returns dates sorted for stable output", () => {
            const desc = "Cancelled: December 1st 2026\nCancelled: January 5th 2026";
            expect(parseCancelledDates(desc, YEAR)).toEqual(["2026-01-05", "2026-12-01"]);
        });

        it("sorts an unsorted comma-separated list", () => {
            const out = parseCancelledDates("Cancelled: November 3rd, 2026, October 11th 2026", YEAR);
            expect(out).toEqual(["2026-10-11", "2026-11-03"]);
        });

        it("handles a trailing comma", () => {
            expect(parseCancelledDates("Cancelled: October 11th 2026, November 3rd, 2026,", YEAR)).toEqual([
                "2026-10-11",
                "2026-11-03",
            ]);
        });

        it("keeps valid dates when one list item is malformed", () => {
            const out = parseCancelledDates("Cancelled: February 30th 2026, November 3rd, 2026", YEAR);
            expect(out).toEqual(["2026-11-03"]);
        });
    });

    describe("year resolution", () => {
        it("borrows the reference year when the year is omitted", () => {
            expect(parseCancelledDates("Cancelled: October 11th", 2027)).toEqual(["2027-10-11"]);
        });

        it("prefers an explicit year over the reference year", () => {
            expect(parseCancelledDates("Cancelled: October 11th 2028", YEAR)).toEqual(["2028-10-11"]);
        });

        // These pin the year actually being *read* rather than silently
        // falling back. With the reference year matching the written year,
        // a dropped year is invisible -- so these deliberately mismatch.
        it("reads an explicit year when it differs from the reference year", () => {
            expect(parseCancelledDates("Cancelled: October 11th 2028", 2025)).toEqual(["2028-10-11"]);
        });

        it("reads a comma-before-year that differs from the reference year", () => {
            // Guards the `,?` in MONTH_DAY_RE: without it the year is not
            // consumed and the date silently falls back to the reference
            // year, which only shows up when the two differ.
            expect(parseCancelledDates("Cancelled: November 3rd, 2028", 2025)).toEqual(["2028-11-03"]);
        });

        it("reads each explicit year in a mixed list, not just the first", () => {
            // The second item's year is the one most likely to be dropped:
            // it is separated from its month by a comma.
            const out = parseCancelledDates("Cancelled: October 11th 2028, November 3rd, 2029", 2025);
            expect(out).toEqual(["2028-10-11", "2029-11-03"]);
        });

        it("falls back to the reference year only for items without one", () => {
            // Item 1 has a year, item 2 does not -- each resolves independently.
            const out = parseCancelledDates("Cancelled: October 11th 2028, November 3rd", 2025);
            expect(out).toEqual(["2025-11-03", "2028-10-11"]);
        });

        it("still parses when no reference year is available", () => {
            // Falls back to the current year rather than dropping the date.
            const out = parseCancelledDates("Cancelled: October 11th", null);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatch(/^\d{4}-10-11$/);
        });
    });

    describe("malformed input is ignored, never thrown", () => {
        it("returns empty for null / undefined / empty", () => {
            expect(parseCancelledDates(null, YEAR)).toEqual([]);
            expect(parseCancelledDates(undefined, YEAR)).toEqual([]);
            expect(parseCancelledDates("", YEAR)).toEqual([]);
        });

        it("ignores prose that mentions a date without the label", () => {
            // A loose pattern would swallow this; the label is what makes the
            // convention unambiguous.
            const desc = "We cancelled the October 11th 2026 launch, new date TBD";
            expect(parseCancelledDates(desc, YEAR)).toEqual([]);
        });

        it("ignores a labelled line with no parseable date", () => {
            expect(parseCancelledDates("Cancelled: TBD", YEAR)).toEqual([]);
        });

        it("rejects impossible calendar dates", () => {
            expect(parseCancelledDates("Cancelled: February 30th 2026", YEAR)).toEqual([]);
            expect(parseCancelledDates("Cancelled: 2026-13-01", YEAR)).toEqual([]);
            expect(parseCancelledDates("Cancelled: 2026-10-32", YEAR)).toEqual([]);
        });

        it("accepts a real leap day but rejects a fake one", () => {
            expect(parseCancelledDates("Cancelled: February 29th 2028", YEAR)).toEqual(["2028-02-29"]);
            expect(parseCancelledDates("Cancelled: February 29th 2027", YEAR)).toEqual([]);
        });

        it("ignores a non-month word before the number", () => {
            expect(parseCancelledDates("Cancelled: week 11 2026", YEAR)).toEqual([]);
        });

        it("keeps the valid date when one of several is malformed", () => {
            const out = parseCancelledDates("Cancelled: February 30th 2026, October 11th 2026", YEAR);
            expect(out).toEqual(["2026-10-11"]);
        });
    });

    describe("month name coverage", () => {
        it.each([
            ["January", "01"],
            ["February", "02"],
            ["March", "03"],
            ["April", "04"],
            ["May", "05"],
            ["June", "06"],
            ["July", "07"],
            ["August", "08"],
            ["September", "09"],
            ["October", "10"],
            ["November", "11"],
            ["December", "12"],
        ])("parses %s", (name, month) => {
            expect(parseCancelledDates(`Cancelled: ${name} 3rd 2026`, YEAR)).toEqual([`2026-${month}-03`]);
        });

        it("accepts abbreviations and trailing periods", () => {
            expect(parseCancelledDates("Cancelled: Sept. 3rd 2026", YEAR)).toEqual(["2026-09-03"]);
            expect(parseCancelledDates("Cancelled: Dec 3rd 2026", YEAR)).toEqual(["2026-12-03"]);
        });
    });
});

describe("toExdateValue", () => {
    it("borrows the time of day from the event start", () => {
        // Clients match EXDATE against DTSTART by value, so an evening meeting
        // must not be excluded at midnight.
        expect(toExdateValue("2026-10-11", "2026-10-04T19:30:00.000Z")).toBe("20261011T193000Z");
    });

    it("drops milliseconds and keeps seconds", () => {
        expect(toExdateValue("2026-10-11", "2026-10-04T19:30:45.123Z")).toBe("20261011T193045Z");
    });

    it("falls back to midnight for an unparseable start instead of dropping the date", () => {
        expect(toExdateValue("2026-10-11", "not-a-date")).toBe("20261011T000000Z");
    });

    it("returns null for a malformed date", () => {
        expect(toExdateValue("not-a-date", "2026-10-04T19:30:00.000Z")).toBeNull();
    });

    it("produces an RFC 5545 UTC date-time shape", () => {
        const out = toExdateValue("2026-10-11", "2026-10-04T19:30:00.000Z");
        expect(out).toMatch(/^\d{8}T\d{6}Z$/);
    });
});

/**
 * The dates are surfaced as cancelled chips on the calendar, so the raw note
 * line is stripped from the description before it reaches the modal -- it
 * would otherwise render the convention verbatim to visitors.
 */
describe("stripCancelledNote", () => {
    it("removes the note line from the documented example", () => {
        const desc = "Location: **Lavery Hall 335**\nCancelled: October 11th 2026";
        expect(stripCancelledNote(desc)).toBe("Location: **Lavery Hall 335**");
    });

    it("removes a note line in the middle of a description", () => {
        const desc = "Agenda below.\nCancelled: October 11th 2026\nBring laptops.";
        expect(stripCancelledNote(desc)).toBe("Agenda below.\nBring laptops.");
    });

    it("removes several note lines", () => {
        const desc = "Cancelled: October 11th 2026\nReal content\nCancelled: November 3rd, 2026";
        expect(stripCancelledNote(desc)).toBe("Real content");
    });

    it("returns null when the note was the only content", () => {
        expect(stripCancelledNote("Cancelled: October 11th 2026")).toBeNull();
    });

    it("collapses the blank-line run left behind", () => {
        const desc = "Before\n\nCancelled: October 11th 2026\n\nAfter";
        expect(stripCancelledNote(desc)).toBe("Before\n\nAfter");
    });

    it("removes every label variant the parser accepts", () => {
        // The two must agree on what counts as a note, or a line could be
        // parsed as a cancellation and still be shown to users.
        for (const label of ["Cancelled", "Canceled", "Skipped", "No meeting", "cancelled", "CANCELLED"]) {
            expect(stripCancelledNote(`Real\n${label}: October 11th 2026`)).toBe("Real");
        }
    });

    it("leaves a description with no note untouched", () => {
        const desc = "Just a normal description.";
        expect(stripCancelledNote(desc)).toBe(desc);
    });

    it("leaves unlabelled prose mentioning a date untouched", () => {
        // Only labelled lines are stripped, so this must survive intact.
        const desc = "We cancelled the October 11th launch, new date TBD";
        expect(stripCancelledNote(desc)).toBe(desc);
    });

    it("handles null and undefined", () => {
        expect(stripCancelledNote(null)).toBeNull();
        expect(stripCancelledNote(undefined)).toBeNull();
        expect(stripCancelledNote("")).toBeNull();
    });

    it("trims trailing whitespace left on the surviving lines", () => {
        const desc = "Real content   \nCancelled: October 11th 2026";
        expect(stripCancelledNote(desc)).toBe("Real content");
    });
});
