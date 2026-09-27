/**
 * Tests for the filtered-feed URL helpers in `discord.ts`.
 *
 * These build the URL a user subscribes to, so the properties worth pinning are
 * the ones a user would notice: an unfiltered subscription must be byte-for-byte
 * the same URL as before this feature existed, and a filtered one must actually
 * carry the ids.
 */

import {
    EVENTS_ICS_URL,
    OFFICERS_ICS_URL,
    officersWebcalUrl,
    toWebcal,
    webcalUrl,
    withChannelFilter,
} from "../../lib/discord";

describe("toWebcal", () => {
    it("swaps https for webcals", () => {
        expect(toWebcal("https://example.test/calendar.ics")).toBe("webcals://example.test/calendar.ics");
    });

    it("is idempotent", () => {
        // Applied twice (e.g. a feed URL that already went through it) must not
        // produce `webcals://webcals://...`.
        expect(toWebcal("webcals://example.test/x.ics")).toBe("webcals://example.test/x.ics");
    });
});

describe("withChannelFilter", () => {
    it("returns the URL unchanged for an empty selection", () => {
        // The load-bearing case: "no filter" and "everything" must be the SAME
        // url, or clearing the filter would produce a different subscription.
        expect(withChannelFilter(EVENTS_ICS_URL, [])).toBe(EVENTS_ICS_URL);
        expect(withChannelFilter(EVENTS_ICS_URL, [])).not.toContain("?");
    });

    it("appends a comma-separated channel list", () => {
        expect(withChannelFilter(EVENTS_ICS_URL, ["1", "2"])).toBe(`${EVENTS_ICS_URL}?channels=1,2`);
    });

    it("preserves an existing query string shape for a single id", () => {
        expect(withChannelFilter(EVENTS_ICS_URL, ["1550592611859955862"])).toBe(
            `${EVENTS_ICS_URL}?channels=1550592611859955862`,
        );
    });

    it("works against the officer feed too", () => {
        expect(withChannelFilter(OFFICERS_ICS_URL, ["9"])).toBe(`${OFFICERS_ICS_URL}?channels=9`);
    });

    it("encodes ids rather than assuming they are numeric", () => {
        expect(withChannelFilter("https://x.test/calendar.ics", ["a b"])).toContain("channels=a%20b");
    });
});

describe("webcal helpers stay consistent with the https feeds", () => {
    it("derives the public webcal URL from the public feed", () => {
        expect(webcalUrl()).toBe(toWebcal(EVENTS_ICS_URL));
    });

    it("derives the officer webcal URL from the officer feed", () => {
        expect(officersWebcalUrl()).toBe(toWebcal(OFFICERS_ICS_URL));
    });
});
