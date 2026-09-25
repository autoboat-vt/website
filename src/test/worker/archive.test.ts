/**
 * @jest-environment node
 *
 * Unit tests for the past-event retention merge (worker/src/archive.ts).
 *
 * `routes.test.ts` drives the same behavior end-to-end through the Worker's
 * `fetch` handler; these tests pin the individual merge RULES, which is much
 * easier to reason about directly than through two stubbed HTTP rounds. Both
 * layers are worth keeping: the route tests catch wiring mistakes, these catch
 * rule mistakes.
 *
 * The module is pure (no KV, no fetch), so it is imported by relative path the
 * same way the other Worker suites import their modules.
 */

import {
    type EventsCacheEntry,
    isFresh,
    KEEP_FOREVER_MS,
    MAX_ARCHIVED_EVENTS,
    mergeArchive,
    parseCacheEntry,
} from "../../../worker/src/archive";
import type { CalendarEvent } from "../../../worker/src/events";

/** A minimal `CalendarEvent`; only the fields the merge reads are meaningful. */
function event(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
    return {
        name: overrides.id,
        description: null,
        start: "2099-01-01T19:00:00.000Z",
        end: "2099-01-01T20:00:00.000Z",
        status: "scheduled",
        location: null,
        userCount: null,
        isRecurring: false,
        image: null,
        recurrenceRule: null,
        channelId: null,
        audience: "public",
        cancelledDates: [],
        ...overrides,
    };
}

const NOW = new Date("2026-09-25T12:00:00.000Z");
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** An event that finished `daysAgo` before NOW. */
function pastEvent(id: string, daysAgo: number, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    const start = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return event({ id, start: start.toISOString(), end: end.toISOString(), ...overrides });
}

/** An event starting `daysAhead` after NOW. */
function futureEvent(id: string, daysAhead: number): CalendarEvent {
    const start = new Date(NOW.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return event({ id, start: start.toISOString(), end: end.toISOString() });
}

describe("mergeArchive", () => {
    describe("retaining events Discord has stopped reporting", () => {
        it("keeps a past event that is absent from the fresh payload", () => {
            // The core case: Discord omits completed events, so this is the
            // event the archive exists to preserve.
            const stored = [pastEvent("done-1", 7)];
            const out = mergeArchive(stored, [], NOW, RETENTION_MS);

            expect(out.map((e) => e.id)).toEqual(["done-1"]);
        });

        it("rewrites a retained event's status to completed", () => {
            // Discord's terminal status never reaches us (the event is simply
            // gone from the list), so the Worker synthesizes it. Without this
            // the calendar would style history as if it were still upcoming.
            const out = mergeArchive([pastEvent("done-1", 7)], [], NOW, RETENTION_MS);

            expect(out[0]?.status).toBe("completed");
        });

        it("preserves an already-canceled status rather than flattening it", () => {
            // The calendar distinguishes a called-off meeting from one that
            // happened, and that distinction is worth keeping.
            const out = mergeArchive([pastEvent("canceled-1", 7, { status: "canceled" })], [], NOW, RETENTION_MS);

            expect(out[0]?.status).toBe("canceled");
        });

        it("keeps a retained event's audience and other fields intact", () => {
            // Audience filtering runs AFTER the merge, so a retained officer
            // event must keep its classification or it would leak.
            const stored = [pastEvent("officer-1", 7, { audience: "officer" })];
            const out = mergeArchive(stored, [], NOW, RETENTION_MS);

            expect(out[0]?.audience).toBe("officer");
        });
    });

    describe("what must NOT be archived", () => {
        it("does not archive an event that is still in the fresh payload", () => {
            const fresh = [futureEvent("live-1", 3)];
            const out = mergeArchive([event({ id: "live-1", ...fresh[0] })], fresh, NOW, RETENTION_MS);

            expect(out).toHaveLength(1);
        });

        it("drops an event with unparseable dates instead of keeping it forever", () => {
            // A NaN end can never age out of the retention test (nor be
            // reasoned about), so keeping it would let one malformed record
            // live in the cache permanently.
            const malformed = event({ id: "bad-1", start: "not-a-date", end: null });
            const out = mergeArchive([malformed], [], NOW, RETENTION_MS);

            expect(out).toEqual([]);
        });

        it("still drops a malformed event even with unbounded retention", () => {
            // The only thing the default keeps-forever mode may discard is a
            // record it cannot date.
            const out = mergeArchive([event({ id: "bad-1", start: "not-a-date", end: null })], [], NOW);

            expect(out).toEqual([]);
        });
    });

    describe("unbounded retention (the default)", () => {
        it("expresses keep-forever as Infinity, not a large number", () => {
            // A finite sentinel would silently prune once an event aged past
            // it; Infinity makes the age comparison unconditionally true.
            expect(KEEP_FOREVER_MS).toBe(Number.POSITIVE_INFINITY);
        });

        it("keeps a future event that vanished from Discord", () => {
            // The team asked to keep EVERY event. Deleted and cancelled are
            // indistinguishable over the API, so a future event that
            // disappears is retained rather than assumed scrapped.
            const out = mergeArchive([futureEvent("future-1", 30)], [], NOW);

            expect(out.map((e) => e.id)).toEqual(["future-1"]);
        });

        it("leaves a vanished future event's status alone", () => {
            // Marking it `completed` would claim a meeting happened that never
            // did. Only events that had actually ended get that rewrite.
            const out = mergeArchive([futureEvent("future-1", 30)], [], NOW);

            expect(out[0]?.status).toBe("scheduled");
        });

        it("keeps an arbitrarily old event", () => {
            // The whole point: no event is ever discarded for being old.
            const out = mergeArchive([pastEvent("ancient-1", 3650)], [], NOW);

            expect(out.map((e) => e.id)).toEqual(["ancient-1"]);
        });

        it("defaults to unbounded when no window is passed", () => {
            // The default argument is what makes retention unlimited in
            // production, so assert it rather than relying on the caller.
            const out = mergeArchive([pastEvent("old-1", 5000)], [], NOW);

            expect(out).toHaveLength(1);
        });

        it("keeps history indefinitely across repeated merges", () => {
            // Simulates many refreshes: a genuinely old event must survive
            // every round, not just the first.
            let archive = [pastEvent("old-1", 800)];
            for (let i = 0; i < 50; i++) {
                archive = mergeArchive(archive, [futureEvent(`new-${i}`, i + 1)], NOW);
            }

            expect(archive.map((e) => e.id)).toContain("old-1");
        });
    });

    describe("opt-in age pruning (RETENTION_DAYS)", () => {
        it("drops a past event older than an explicit retention window", () => {
            // Setting a window is the escape hatch if history ever grows past
            // what a single KV value can hold.
            const out = mergeArchive([pastEvent("ancient-1", 365)], [], NOW, RETENTION_MS);

            expect(out).toEqual([]);
        });

        it("keeps a past event exactly at the window boundary", () => {
            // The comparison is `>=`, so the window is inclusive at its edge.
            const atEdge = event({
                id: "edge-1",
                start: new Date(NOW.getTime() - RETENTION_MS - 60 * 60 * 1000).toISOString(),
                end: new Date(NOW.getTime() - RETENTION_MS).toISOString(),
            });
            const out = mergeArchive([atEdge], [], NOW, RETENTION_MS);

            expect(out.map((e) => e.id)).toEqual(["edge-1"]);
        });

        it("honours a window that is too large to prune anything", () => {
            // e.g. RETENTION_DAYS=40000; an enormous value is a valid way to
            // express "keep everything" without leaving the var unset.
            const out = mergeArchive([pastEvent("ancient-1", 3650)], [], NOW, 40_000 * 24 * 60 * 60 * 1000);

            expect(out.map((e) => e.id)).toEqual(["ancient-1"]);
        });
    });

    describe("merging fresh over stored", () => {
        it("prefers the fresh copy of an event present in both", () => {
            // A renamed or rescheduled event must not keep serving its stale
            // archived name.
            const stored = [event({ ...futureEvent("shared-1", 3), id: "shared-1", name: "Old Name" })];
            const fresh = [event({ ...futureEvent("shared-1", 3), id: "shared-1", name: "New Name" })];
            const out = mergeArchive(stored, fresh, NOW, RETENTION_MS);

            expect(out).toHaveLength(1);
            expect(out[0]?.name).toBe("New Name");
        });

        it("keys on id, so an event is never duplicated", () => {
            // Recurring events appear in every payload under one stable id.
            const same = futureEvent("recurring-1", 3);
            const out = mergeArchive([same], [same], NOW, RETENTION_MS);

            expect(out).toHaveLength(1);
        });

        it("returns an empty archive for empty inputs", () => {
            expect(mergeArchive([], [], NOW, RETENTION_MS)).toEqual([]);
        });

        it("sorts the result by start time", () => {
            const stored = [pastEvent("past-1", 7), pastEvent("past-2", 3)];
            const fresh = [futureEvent("future-1", 5)];
            const out = mergeArchive(stored, fresh, NOW, RETENTION_MS);

            const starts = out.map((e) => new Date(e.start).getTime());
            expect(starts).toEqual([...starts].sort((a, b) => a - b));
        });
    });

    describe("the size cap", () => {
        // These use a retention window wide enough to hold every generated
        // event, so the CAP is what is under test rather than the age filter.
        const WIDE_RETENTION = 10_000 * 24 * 60 * 60 * 1000;

        it("stays within MAX_ARCHIVED_EVENTS", () => {
            // KV values cap at 25 MiB and the whole archive is serialized on
            // every write, so retention has to be bounded by count as well as
            // by age.
            const many = Array.from({ length: MAX_ARCHIVED_EVENTS + 50 }, (_, i) => pastEvent(`past-${i}`, i + 1));
            const out = mergeArchive(many, [], NOW, WIDE_RETENTION);

            expect(out).toHaveLength(MAX_ARCHIVED_EVENTS);
        });

        it("never drops an upcoming event to stay within the cap", () => {
            // Losing a future event to an eviction policy would be a visible
            // bug, so the cap only ever discards the oldest history.
            const upcoming = Array.from({ length: 10 }, (_, i) => futureEvent(`future-${i}`, i + 1));
            const many = Array.from({ length: MAX_ARCHIVED_EVENTS }, (_, i) => pastEvent(`past-${i}`, i + 1));
            const out = mergeArchive(many, upcoming, NOW, WIDE_RETENTION);

            expect(out).toHaveLength(MAX_ARCHIVED_EVENTS);
            for (const e of upcoming) {
                expect(out.map((o) => o.id)).toContain(e.id);
            }
        });

        it("evicts the OLDEST history first", () => {
            const many = Array.from({ length: MAX_ARCHIVED_EVENTS + 10 }, (_, i) => pastEvent(`past-${i}`, i + 1));
            const out = mergeArchive(many, [], NOW, WIDE_RETENTION);
            const ids = new Set(out.map((e) => e.id));

            // past-0 is the most recent; the highest index is the oldest.
            expect(ids.has("past-0")).toBe(true);
            expect(ids.has(`past-${MAX_ARCHIVED_EVENTS + 9}`)).toBe(false);
        });
    });
});

describe("parseCacheEntry", () => {
    it("parses the current shape", () => {
        const entry: EventsCacheEntry = { fetchedAt: 123, events: [event({ id: "a" })] };
        expect(parseCacheEntry(entry)).toEqual(entry);
    });

    it("reads a legacy bare array as infinitely stale", () => {
        // A pre-retention Worker wrote a bare array. Reporting fetchedAt 0
        // means it is refetched and rewritten in the new shape, rather than
        // being dropped (losing history) or served stale for the whole
        // retention window.
        const parsed = parseCacheEntry([event({ id: "a" })]);
        expect(parsed?.fetchedAt).toBe(0);
        expect(parsed?.events).toHaveLength(1);
    });

    it("returns null for values that are not an archive", () => {
        for (const value of [null, undefined, 42, "nope", {}, { fetchedAt: 1 }, { events: "no" }]) {
            expect(parseCacheEntry(value)).toBeNull();
        }
    });

    it("tolerates a missing or non-finite fetchedAt", () => {
        expect(parseCacheEntry({ events: [] })?.fetchedAt).toBe(0);
        expect(parseCacheEntry({ fetchedAt: Number.NaN, events: [] })?.fetchedAt).toBe(0);
        expect(parseCacheEntry({ fetchedAt: Number.POSITIVE_INFINITY, events: [] })?.fetchedAt).toBe(0);
    });
});

describe("isFresh", () => {
    const TTL_MS = 180_000;

    it("is fresh inside the TTL", () => {
        expect(isFresh({ fetchedAt: NOW.getTime() - 60_000, events: [] }, NOW, TTL_MS)).toBe(true);
    });

    it("is stale at and beyond the TTL", () => {
        // The boundary is `>=`, matching "no longer fresh".
        expect(isFresh({ fetchedAt: NOW.getTime() - TTL_MS, events: [] }, NOW, TTL_MS)).toBe(false);
        expect(isFresh({ fetchedAt: NOW.getTime() - TTL_MS - 1, events: [] }, NOW, TTL_MS)).toBe(false);
    });

    it("treats a legacy entry (fetchedAt 0) as stale", () => {
        // Guards the upgrade path: a 0 stamp must never read as "fresh".
        expect(isFresh({ fetchedAt: 0, events: [] }, NOW, TTL_MS)).toBe(false);
    });

    it("treats a future timestamp as fresh", () => {
        // Clock skew between the writer and the reader shouldn't cause a
        // refetch storm.
        expect(isFresh({ fetchedAt: NOW.getTime() + 1_000, events: [] }, NOW, TTL_MS)).toBe(true);
    });
});
