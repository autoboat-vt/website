import type { CalendarEvent } from "../../lib/discord";
import type { ChannelSelection } from "../../lib/eventChannels";
import {
    ALWAYS_VISIBLE_CHANNEL_IDS,
    channelKeyFor,
    eventChannelGroups,
    isAllSelected,
    isAlwaysVisible,
    labelForChannel,
    matchesChannelFilter,
    OTHER_CHANNEL_ID,
    SUBTEAM_CHANNELS,
    toggleChannel,
    totalCount,
    workerChannelIds,
} from "../../lib/eventChannels";

/**
 * Tests for the calendar channel-grouping module.
 *
 * Two properties carry the weight, and most of these tests exist to pin them:
 *
 *  1. SELECTION SEMANTICS: an empty set means "everything". Groups are a
 *     display concern, but that convention is what keeps the unfiltered feed
 *     URL identical to the default.
 *  2. SCOPE: the picker narrows SUBTEAM events only. General member and officer
 *     events are shown no matter what is unchecked, so a filter can hide a
 *     subteam but never the team's main meetings.
 */

const SOFTWARE = "1550592611859955862";
const NAVARCH = "1550592897659707402";
/** General member channel: always visible, never filterable. */
const MEMBERS = "1550594275580837921";
/** Officer channel: always visible, never filterable. */
const OFFICERS = "1550594891766308997";
/** A channel the curated list does not know about. */
const UNKNOWN = "9999999999999999999";

function event(id: string, channelId: string | null): CalendarEvent {
    return {
        id,
        name: `Event ${id}`,
        description: null,
        start: "2026-10-01T19:00:00.000Z",
        end: null,
        status: "scheduled",
        location: null,
        userCount: null,
        isRecurring: false,
        image: null,
        recurrenceRule: null,
        cancelledDates: [],
        channelId,
    };
}

describe("channelKeyFor", () => {
    it("uses the Discord channel id when present", () => {
        expect(channelKeyFor(event("a", SOFTWARE))).toBe(SOFTWARE);
    });

    it("buckets a channel-less event under the sentinel key", () => {
        // An EXTERNAL event has no channel. It still needs a selectable key, or
        // its events would be permanently unfilterable.
        expect(channelKeyFor(event("a", null))).toBe(OTHER_CHANNEL_ID);
    });

    it("treats a missing channelId field as channel-less", () => {
        // An older Worker omits the field entirely; that must degrade to the
        // channel-less bucket rather than throwing or matching everything.
        const { channelId: _omitted, ...rest } = event("a", SOFTWARE);
        expect(channelKeyFor(rest as CalendarEvent)).toBe(OTHER_CHANNEL_ID);
    });

    it("never collides with a real channel id", () => {
        // Discord snowflakes are numeric, so the sentinel must not be.
        expect(OTHER_CHANNEL_ID).not.toMatch(/^\d+$/);
    });
});

describe("eventChannelGroups", () => {
    it("only includes groups that contain events", () => {
        const groups = eventChannelGroups([event("a", SOFTWARE)]);
        expect(groups.map((g) => g.id)).toEqual([SOFTWARE]);
    });

    it("counts events per subteam group", () => {
        const groups = eventChannelGroups([event("a", SOFTWARE), event("b", SOFTWARE), event("c", NAVARCH)]);
        expect(groups.find((g) => g.id === SOFTWARE)?.count).toBe(2);
        expect(groups.find((g) => g.id === NAVARCH)?.count).toBe(1);
    });

    it("never offers general member or officer channels as groups", () => {
        // Their events are always shown, so a checkbox for them could not hide
        // anything and would misrepresent what the filter does.
        const groups = eventChannelGroups([event("a", MEMBERS), event("b", OFFICERS), event("c", SOFTWARE)]);
        expect(groups.map((g) => g.id)).toEqual([SOFTWARE]);
    });

    it("does not count always-visible events in any group total", () => {
        // The badge counts what the checkbox controls, nothing else.
        const groups = eventChannelGroups([event("a", MEMBERS), event("b", SOFTWARE)]);
        expect(totalCount(groups)).toBe(1);
    });

    it("orders groups by the curated list, not by event order", () => {
        // Deliberately feed the events in the reverse of the display order.
        const groups = eventChannelGroups([event("a", NAVARCH), event("b", SOFTWARE)]);
        expect(groups.map((g) => g.id)).toEqual([SOFTWARE, NAVARCH]);
    });

    it("puts the channel-less bucket last", () => {
        const groups = eventChannelGroups([event("a", null), event("b", SOFTWARE)]);
        expect(groups[groups.length - 1]?.id).toBe(OTHER_CHANNEL_ID);
    });

    it("merges an unlisted channel into the channel-less bucket rather than dropping it", () => {
        // A newly created subteam channel must stay reachable; dropping its
        // events from every group would hide them from the filter entirely.
        const groups = eventChannelGroups([event("a", UNKNOWN), event("b", null)]);
        expect(groups).toEqual([{ id: OTHER_CHANNEL_ID, label: "Other", count: 2 }]);
    });

    it("returns an empty list for no events", () => {
        expect(eventChannelGroups([])).toEqual([]);
    });

    it("returns no groups at all when only always-visible events exist", () => {
        // The picker renders disabled in this state rather than opening an
        // empty panel.
        expect(eventChannelGroups([event("a", MEMBERS), event("b", OFFICERS)])).toEqual([]);
    });

    it("lists every subteam channel exactly once across a mixed set", () => {
        const groups = eventChannelGroups(SUBTEAM_CHANNELS.map((c, i) => event(String(i), c.id)));
        expect(groups).toHaveLength(SUBTEAM_CHANNELS.length);
        expect(new Set(groups.map((g) => g.id)).size).toBe(SUBTEAM_CHANNELS.length);
    });

    it("keeps the always-visible channels out of the subteam list", () => {
        // Guards against an id being added to both lists, which would make the
        // same channel both filterable and always-on.
        for (const { id } of SUBTEAM_CHANNELS) {
            expect(ALWAYS_VISIBLE_CHANNEL_IDS.has(id)).toBe(false);
        }
    });

    it("totalCount sums every group", () => {
        const groups = eventChannelGroups([event("a", SOFTWARE), event("b", NAVARCH), event("c", null)]);
        expect(totalCount(groups)).toBe(3);
    });
});

describe("isAlwaysVisible", () => {
    it("is true for general member events", () => {
        expect(isAlwaysVisible(event("a", MEMBERS))).toBe(true);
    });

    it("is true for officer events", () => {
        // Their visibility is the Worker's audience filter's job; the picker
        // must not be able to hide them on the officers page.
        expect(isAlwaysVisible(event("a", OFFICERS))).toBe(true);
    });

    it("is false for subteam channels", () => {
        expect(isAlwaysVisible(event("a", SOFTWARE))).toBe(false);
    });

    it("is false for a channel-less event", () => {
        // Channel-less events are NOT always visible -- they are their own
        // selectable "Other" group.
        expect(isAlwaysVisible(event("a", null))).toBe(false);
    });
});

describe("labelForChannel", () => {
    it("resolves a subteam channel to its friendly name", () => {
        expect(labelForChannel(SOFTWARE)).toBe("Software");
    });

    it("resolves an unlisted channel to the same label its group uses", () => {
        // Otherwise the picker and this helper would label the same bucket two
        // different ways.
        expect(labelForChannel(UNKNOWN)).toBe("Other");
        expect(labelForChannel(OTHER_CHANNEL_ID)).toBe("Other");
    });
});

describe("matchesChannelFilter", () => {
    it("shows EVERYTHING for a null selection", () => {
        // The load-bearing convention. If this ever returns false for `null`,
        // the calendar renders nothing on first load.
        expect(matchesChannelFilter(event("a", SOFTWARE), null)).toBe(true);
        expect(matchesChannelFilter(event("a", null), null)).toBe(true);
    });

    it("keeps only the selected channel for a narrowing selection", () => {
        const selected = new Set([SOFTWARE]);
        expect(matchesChannelFilter(event("a", SOFTWARE), selected)).toBe(true);
        expect(matchesChannelFilter(event("a", NAVARCH), selected)).toBe(false);
    });

    it("always shows general member events, even when another subteam is the only selection", () => {
        // The headline behavior for this filter's scope.
        expect(matchesChannelFilter(event("a", MEMBERS), new Set([SOFTWARE]))).toBe(true);
    });

    it("always shows officer events, even when another subteam is the only selection", () => {
        // Officer events must remain visible on /calendar/officers while the
        // officer's own subteam is filtered out.
        expect(matchesChannelFilter(event("a", OFFICERS), new Set([SOFTWARE]))).toBe(true);
    });

    it("still shows always-visible events when the selection excludes everything else", () => {
        expect(matchesChannelFilter(event("a", MEMBERS), new Set([OTHER_CHANNEL_ID]))).toBe(true);
        expect(matchesChannelFilter(event("a", OFFICERS), new Set([OTHER_CHANNEL_ID]))).toBe(true);
    });

    it("shows NOTHING for an empty set", () => {
        // Distinct from `null` (all). This is "no subteams selected", which
        // must stay expressible or a lone subteam could never be unchecked.
        expect(matchesChannelFilter(event("a", SOFTWARE), new Set())).toBe(false);
    });

    it("does not include channel-less events in an unrelated selection", () => {
        // They belong to their own "Other" group, so they must not leak into
        // every filtered view.
        expect(matchesChannelFilter(event("a", null), new Set([SOFTWARE]))).toBe(false);
    });

    it("includes channel-less events when Other is explicitly selected", () => {
        expect(matchesChannelFilter(event("a", null), new Set([OTHER_CHANNEL_ID]))).toBe(true);
    });
});

describe("workerChannelIds", () => {
    it("drops the sentinel bucket so only real ids are sent", () => {
        expect(workerChannelIds(new Set([SOFTWARE, OTHER_CHANNEL_ID]))).toEqual(expect.arrayContaining([SOFTWARE]));
        expect(workerChannelIds(new Set([SOFTWARE, OTHER_CHANNEL_ID]))).not.toContain(OTHER_CHANNEL_ID);
    });

    it("returns nothing for the 'all subteams' state, which omits the query entirely", () => {
        expect(workerChannelIds(null)).toEqual([]);
    });

    it("includes the always-visible channels whenever a filter is active", () => {
        // Otherwise the feed would drop the general member events the page
        // still shows, and the subscription would disagree with the grid.
        const ids = workerChannelIds(new Set([SOFTWARE]));
        expect(ids).toContain(SOFTWARE);
        for (const id of ALWAYS_VISIBLE_CHANNEL_IDS) {
            expect(ids).toContain(id);
        }
    });

    it("sends only the always-visible channels when no subteam is selected", () => {
        // Not an empty list: general member events must survive the filter.
        expect([...workerChannelIds(new Set())].sort()).toEqual([...ALWAYS_VISIBLE_CHANNEL_IDS].sort());
    });
});

describe("isAllSelected", () => {
    it("is true only for the null selection", () => {
        // `null` and `new Set()` both mean "no narrowing" at a glance but are
        // different states -- this predicate is the single place that decides.
        expect(isAllSelected(null)).toBe(true);
        expect(isAllSelected(new Set())).toBe(false);
        expect(isAllSelected(new Set([SOFTWARE]))).toBe(false);
    });
});

describe("toggleChannel", () => {
    // Synthetic group lists -- `toggleChannel` is generic over groups.
    const groups = [
        { id: SOFTWARE, label: "Software", count: 1 },
        { id: NAVARCH, label: "Naval Architecture & Propulsion", count: 1 },
    ];

    /**
     * Assert a narrowed (non-null) selection and return it, so the tests do not
     * need non-null assertions at every use site.
     */
    function expectNarrowed(next: ChannelSelection): Set<string> {
        expect(next).not.toBeNull();
        return next as Set<string>;
    }

    it("materializes the full set before subtracting from the default state", () => {
        // The initial state is `null` ("all"). Unchecking one group has to
        // produce {other}, not `null` -- otherwise the click would be a no-op.
        expect([...expectNarrowed(toggleChannel(null, SOFTWARE, groups))]).toEqual([NAVARCH]);
    });

    it("adds a group to a partial selection", () => {
        // Three groups so this does not accidentally complete the set and
        // trigger the "all" collapse asserted below.
        const three = [...groups, { id: "third", label: "Third", count: 1 }];
        const next = expectNarrowed(toggleChannel(new Set([SOFTWARE]), NAVARCH, three));
        expect([...next].sort()).toEqual([NAVARCH, SOFTWARE].sort());
    });

    it("unchecking the ONLY group produces an empty set, not 'all'", () => {
        // The bug this model exists to prevent: with an empty-set-means-all
        // convention, this click would read back as "everything selected" and
        // the checkbox would silently refuse to turn off.
        const one = [{ id: SOFTWARE, label: "Software", count: 1 }];
        expect([...expectNarrowed(toggleChannel(null, SOFTWARE, one))]).toEqual([]);
    });

    it("collapses a fully-checked set back to the null 'all' representation", () => {
        // Without this, "every group checked" and "no filter" would be two
        // states that render identically but generate different feed URLs.
        const next = toggleChannel(new Set([SOFTWARE]), NAVARCH, groups);
        expect(next).toBeNull();
    });

    it("does not mutate the set it is given", () => {
        const original = new Set([SOFTWARE]);
        toggleChannel(original, NAVARCH, groups);
        expect([...original]).toEqual([SOFTWARE]);
    });
});
