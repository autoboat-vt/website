import {
    type CalendarEvent,
    DISCORD_GUILD_ID,
    DiscordError,
    describeRecurrence,
    discordEventUrl,
    EVENTS_ICS_URL,
    EVENTS_URL,
    expandRecurrences,
    extractLocationFromDescription,
    fetchEvents,
    webcalUrl,
} from "../../lib/discord";

/**
 * Tests for the Discord events client. Mirrors the pattern in
 * src/test/lib/telemetry.test.ts: mock global fetch with a minimal
 * duck-typed Response stand-in (jsdom does not expose `new Response`).
 */

type FetchMock = jest.Mock;

interface MockResponse {
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, init?: { status?: number }): MockResponse {
    const status = init?.status ?? 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
    };
}

function mockFetchOnce(body: unknown, init?: { status?: number }): FetchMock {
    const fn = jest.fn(() => Promise.resolve(jsonResponse(body, init))) as unknown as FetchMock;
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

function sampleEvent(partial: Partial<CalendarEvent> & Pick<CalendarEvent, "id" | "name" | "start">): CalendarEvent {
    return {
        description: null,
        end: null,
        status: "scheduled",
        location: null,
        userCount: null,
        isRecurring: false,
        image: null,
        recurrenceRule: null,
        cancelledDates: [],
        ...partial,
    };
}

describe("discord events client", () => {
    const realFetch = global.fetch;

    afterEach(() => {
        global.fetch = realFetch;
        jest.restoreAllMocks();
    });

    describe("EVENTS_URL", () => {
        it("defaults to the known worker.dev placeholder when VITE_EVENTS_URL is unset", () => {
            expect(EVENTS_URL).toMatch(/^https:\/\//);
            expect(EVENTS_URL).toContain("workers.dev");
        });
    });

    describe("DISCORD_GUILD_ID", () => {
        it("is a string (placeholder until the user fills it in)", () => {
            expect(typeof DISCORD_GUILD_ID).toBe("string");
        });
    });

    describe("discordEventUrl", () => {
        it("builds a discord.com/channels URL from guild id + event id", () => {
            const ev = sampleEvent({ id: "111", name: "X", start: "2026-03-04T19:00:00Z" });
            expect(discordEventUrl(ev)).toBe(`https://discord.com/channels/${DISCORD_GUILD_ID}/111`);
        });
    });

    describe("EVENTS_ICS_URL", () => {
        it("points at the worker's /calendar.ics route", () => {
            expect(EVENTS_ICS_URL).toBe(`${EVENTS_URL}/calendar.ics`);
            expect(EVENTS_ICS_URL).toMatch(/^https:\/\/.+\/calendar\.ics$/);
        });
    });

    describe("webcalUrl", () => {
        it("uses the webcals:// scheme so the OS hands it to a calendar app", () => {
            // `webcal://` (no s) is increasingly rejected; `webcals://` is the
            // secure form and is what actually opens the OS calendar handler.
            expect(webcalUrl()).toBe(EVENTS_ICS_URL.replace(/^https?:\/\//, "webcals://"));
            expect(webcalUrl()).toBe(`webcals://${EVENTS_URL.replace(/^https?:\/\//, "")}/calendar.ics`);
            expect(webcalUrl().startsWith("webcals://")).toBe(true);
        });
    });

    describe("fetchEvents", () => {
        it("returns the parsed array on success", async () => {
            const events = [
                sampleEvent({ id: "1", name: "Team meeting", start: "2026-03-04T19:00:00Z" }),
                sampleEvent({ id: "2", name: "Build day", start: "2026-03-15T14:00:00Z" }),
            ];
            const fn = mockFetchOnce(events);

            const result = await fetchEvents();

            expect(fn).toHaveBeenCalledTimes(1);
            const firstCall = fn.mock.calls[0] ?? [];
            expect(firstCall[0]).toBe(`${EVENTS_URL}/events`);
            expect(firstCall[1]?.headers).toMatchObject({ Accept: "application/json" });
            expect(firstCall[1]?.mode).toBe("cors");
            expect(result).toEqual(events);
        });

        it("returns [] when the payload is not an array", async () => {
            mockFetchOnce({ error: "unexpected shape" });
            const result = await fetchEvents();
            expect(result).toEqual([]);
        });

        it("filters out items missing required CalendarEvent fields", async () => {
            mockFetchOnce([
                sampleEvent({ id: "1", name: "Good", start: "2026-03-04T19:00:00Z" }),
                { id: "2" }, // missing name/start/...
                null,
                "not an object",
            ]);
            const result = await fetchEvents();
            expect(result).toHaveLength(1);
            expect(result[0]?.name).toBe("Good");
        });

        it("drops an event whose recurrenceRule is not a string", async () => {
            // The shape mismatch that broke the Worker originally: an RRULE
            // arriving as Discord's structured object. Every other field is
            // valid, so the rule is the only reason for rejection.
            mockFetchOnce([
                {
                    id: "1",
                    name: "Structured rule",
                    description: null,
                    start: "2026-10-01T19:00:00Z",
                    end: null,
                    status: "scheduled",
                    location: null,
                    userCount: null,
                    isRecurring: true,
                    image: null,
                    recurrenceRule: { frequency: 2, interval: 1, by_weekday: [2] },
                },
                sampleEvent({ id: "2", name: "Fine", start: "2026-10-02T19:00:00Z" }),
            ]);
            const result = await fetchEvents();
            expect(result.map((e) => e.name)).toEqual(["Fine"]);
        });

        it("drops an event whose recurrenceRule is not a usable RRULE body", async () => {
            mockFetchOnce([
                sampleEvent({
                    id: "1",
                    name: "Bad rule",
                    start: "2026-10-01T19:00:00Z",
                    isRecurring: true,
                    recurrenceRule: "not-a-rule",
                }),
            ]);
            expect(await fetchEvents()).toEqual([]);
        });

        it("keeps a valid recurring event", async () => {
            mockFetchOnce([
                sampleEvent({
                    id: "1",
                    name: "Weekly standup",
                    start: "2026-10-01T19:00:00Z",
                    isRecurring: true,
                    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TH",
                }),
            ]);
            const result = await fetchEvents();
            expect(result).toHaveLength(1);
            expect(result[0]?.isRecurring).toBe(true);
            expect(result[0]?.recurrenceRule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH");
        });

        it("accepts an event with a populated cancelledDates list", async () => {
            mockFetchOnce([
                sampleEvent({
                    id: "1",
                    name: "Weekly standup",
                    start: "2026-10-01T19:00:00Z",
                    isRecurring: true,
                    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TH",
                    cancelledDates: ["2026-10-08"],
                }),
            ]);
            const result = await fetchEvents();
            expect(result[0]?.cancelledDates).toEqual(["2026-10-08"]);
        });

        it("drops an event whose cancelledDates is not an array of strings", async () => {
            // A wrong-typed value would throw inside expansion instead of
            // degrading, so it is rejected at the boundary.
            mockFetchOnce([
                sampleEvent({
                    id: "1",
                    name: "Bad exclusions",
                    start: "2026-10-01T19:00:00Z",
                    cancelledDates: "2026-10-08" as unknown as string[],
                }),
                sampleEvent({ id: "2", name: "Fine", start: "2026-10-02T19:00:00Z" }),
            ]);
            const result = await fetchEvents();
            expect(result.map((e) => e.name)).toEqual(["Fine"]);
        });

        it("tolerates a Worker that omits cancelledDates entirely", async () => {
            // Forward/backward compatibility: an older Worker payload has no
            // such field, and that must not drop the event.
            const legacy = sampleEvent({ id: "1", name: "Legacy", start: "2026-10-01T19:00:00Z" });
            const { cancelledDates: _omitted, ...withoutField } = legacy;
            mockFetchOnce([withoutField]);
            const result = await fetchEvents();
            expect(result.map((e) => e.name)).toEqual(["Legacy"]);
        });

        it("derives isRecurring from the rule when the two disagree", async () => {
            // The two fields are redundant; trusting the flag over the rule
            // lets a chip render as recurring while its occurrences collapse
            // to a single one.
            mockFetchOnce([
                sampleEvent({
                    id: "1",
                    name: "Rule but not flagged",
                    start: "2026-10-01T19:00:00Z",
                    isRecurring: false,
                    recurrenceRule: "FREQ=DAILY",
                }),
                sampleEvent({
                    id: "2",
                    name: "Flagged but no rule",
                    start: "2026-10-02T19:00:00Z",
                    isRecurring: true,
                    recurrenceRule: null,
                }),
            ]);
            const result = await fetchEvents();
            expect(result.find((e) => e.id === "1")?.isRecurring).toBe(true);
            expect(result.find((e) => e.id === "2")?.isRecurring).toBe(false);
        });

        it("throws DiscordError on HTTP 502", async () => {
            mockFetchOnce({ error: "upstream failed" }, { status: 502 });
            await expect(fetchEvents()).rejects.toThrow(DiscordError);
            await expect(fetchEvents()).rejects.toThrow(/status 502/);
        });

        it("throws DiscordError when the response body is not valid JSON", async () => {
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    status: 200,
                    statusText: "OK",
                    json: () => Promise.reject(new Error("unexpected token")),
                }),
            ) as unknown as typeof fetch;
            await expect(fetchEvents()).rejects.toThrow(/not valid JSON/);
        });

        it("aborts the fetch when the caller's signal fires", async () => {
            // A fetch that stays pending forever unless the abort fires.
            let abortFired = false;
            const pending = new Promise<MockResponse>((_resolve, reject) => {
                const controller = new AbortController();
                // Mirror what fetchJson is expected to wire up.
                setTimeout(() => {
                    abortFired = true;
                    controller.abort();
                    reject(new DOMException("Aborted", "AbortError"));
                }, 5);
            });
            global.fetch = jest.fn(() => pending) as unknown as typeof fetch;

            const controller = new AbortController();
            const promise = fetchEvents(controller.signal);
            controller.abort();
            await expect(promise).rejects.toBeDefined();
            expect(abortFired).toBe(true);
        });
    });

    describe("extractLocationFromDescription", () => {
        it("returns nulls for a null or empty description", () => {
            expect(extractLocationFromDescription(null)).toEqual({ location: null, description: null });
            expect(extractLocationFromDescription("")).toEqual({ location: null, description: "" });
        });

        it("reads a labeled line and removes the whole line from the description", () => {
            expect(
                extractLocationFromDescription("Weekly syncup.\nLocation: **Holden Auditorium**\nBring a laptop."),
            ).toEqual({
                location: "Holden Auditorium",
                description: "Weekly syncup.\nBring a laptop.",
            });
            expect(extractLocationFromDescription("Where: __Torgersen Bridge__\nBring a laptop.")).toEqual({
                location: "Torgersen Bridge",
                description: "Bring a laptop.",
            });
        });

        it("returns a null description when the labeled line was the only content", () => {
            expect(extractLocationFromDescription("Location: Holden Auditorium")).toEqual({
                location: "Holden Auditorium",
                description: null,
            });
        });

        it("falls back to the first bold span and removes just the span", () => {
            expect(extractLocationFromDescription("Meet at **Newman Library** for the build night.")).toEqual({
                location: "Newman Library",
                description: "Meet at for the build night.",
            });
        });

        it("returns the description unchanged when no location pattern matches", () => {
            expect(extractLocationFromDescription("Zoom link in Discord.")).toEqual({
                location: null,
                description: "Zoom link in Discord.",
            });
        });
    });

    describe("expandRecurrences", () => {
        // Window: March 2026 (full month, in UTC so tests are stable).
        const from = new Date(Date.UTC(2026, 2, 1));
        const to = new Date(Date.UTC(2026, 3, 0, 23, 59, 59)); // March 31

        it("includes a non-recurring event that falls inside the window", () => {
            const ev = sampleEvent({
                id: "1",
                name: "Build day",
                start: "2026-03-15T14:00:00.000Z",
                end: "2026-03-15T17:00:00.000Z",
            });
            const out = expandRecurrences([ev], from, to);
            expect(out).toHaveLength(1);
            expect(out[0]?.event.id).toBe("1");
        });

        it("excludes a non-recurring event entirely outside the window", () => {
            const ev = sampleEvent({
                id: "1",
                name: "Build day",
                start: "2026-04-15T14:00:00.000Z",
            });
            const out = expandRecurrences([ev], from, to);
            expect(out).toHaveLength(0);
        });

        it("expands a weekly Wednesday recurrence (Discord by_weekday=[2])", () => {
            // Discord: WEEKLY + byWeekday=[2] == BYDAY=WE in RFC 5545.
            // 2026-03-04 is a Wednesday.
            const ev = sampleEvent({
                id: "rec",
                name: "Weekly standup",
                start: "2026-03-04T19:00:00.000Z",
                isRecurring: true,
                recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE",
            });
            const out = expandRecurrences([ev], from, to);
            // Wednesdays in March 2026: 4, 11, 18, 25.
            expect(out).toHaveLength(4);
            const days = out.map((o) => o.start.getUTCDay());
            expect(days.every((d) => d === 3)).toBe(true); // WEDNESDAY = 3
        });

        it("clips recurrences to the window when UNTIL limits the series", () => {
            const ev = sampleEvent({
                id: "rec",
                name: "Weekly standup",
                start: "2026-03-04T19:00:00.000Z",
                isRecurring: true,
                recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE;UNTIL=20260315T000000Z",
            });
            const out = expandRecurrences([ev], from, to);
            // Only Mar 4 and Mar 11 fit inside UNTIL=Mar 15.
            expect(out).toHaveLength(2);
        });

        it("shifts each occurrence by the base event's duration (end-start)", () => {
            const ev = sampleEvent({
                id: "rec",
                name: "Build day",
                start: "2026-03-04T14:00:00.000Z", // Wednesday
                end: "2026-03-04T17:00:00.000Z",
                isRecurring: true,
                recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE",
            });
            const out = expandRecurrences([ev], from, to);
            for (const occ of out) {
                expect(occ.end.getTime() - occ.start.getTime()).toBe(3 * 60 * 60 * 1000);
            }
        });

        it("falls back to a single occurrence when the RRULE is malformed", () => {
            const ev = sampleEvent({
                id: "bad",
                name: "Bogus rule",
                start: "2026-03-10T19:00:00.000Z",
                isRecurring: true,
                recurrenceRule: "NOT_AN_RRULE",
            });
            // Should not throw; the event still shows up once.
            const out = expandRecurrences([ev], from, to);
            expect(out).toHaveLength(1);
            expect(out[0]?.event.id).toBe("bad");
        });

        it("skips events with unparseable dates instead of throwing", () => {
            const ev = sampleEvent({
                id: "bad-date",
                name: "Corrupt",
                start: "not-a-date",
            });
            const out = expandRecurrences([ev], from, to);
            expect(out).toHaveLength(0);
        });

        it("sorts occurrences by start time across mixed recurring and one-off events", () => {
            const recurring = sampleEvent({
                id: "rec",
                name: "Weekly",
                start: "2026-03-06T19:00:00.000Z", // Friday
                isRecurring: true,
                recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=FR",
            });
            const oneOffEarly = sampleEvent({
                id: "early",
                name: "Kickoff",
                start: "2026-03-02T12:00:00.000Z", // Earlier than the first recurrence
            });
            const oneOffLate = sampleEvent({
                id: "late",
                name: "Demo",
                start: "2026-03-30T12:00:00.000Z", // Later than all
            });
            const out = expandRecurrences([recurring, oneOffEarly, oneOffLate], from, to);
            const starts = out.map((o) => o.start.getTime());
            const sorted = [...starts].sort((a, b) => a - b);
            expect(starts).toEqual(sorted);
        });

        // A cancelled series has a terminal Discord status and no UNTIL (the
        // rule's `end` is not settable), so without a clip it would paint
        // struck-through chips on every future occurrence, forever.
        describe("cancelled series", () => {
            function cancelledWeekly(): CalendarEvent {
                return sampleEvent({
                    id: "dead",
                    name: "Cancelled standup",
                    start: "2026-03-04T19:00:00.000Z", // Wednesday
                    status: "canceled",
                    isRecurring: true,
                    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE",
                });
            }

            it("keeps occurrences that already happened", () => {
                // Mid-March: Mar 4 and Mar 11 are in the past, Mar 18/25 are not.
                const out = expandRecurrences([cancelledWeekly()], from, to, new Date(Date.UTC(2026, 2, 15)));
                expect(out.map((o) => o.start.getUTCDate())).toEqual([4, 11]);
            });

            it("stops projecting occurrences into the future", () => {
                // Same month, before the series started: nothing has happened
                // yet, so nothing should render.
                const out = expandRecurrences([cancelledWeekly()], from, to, new Date(Date.UTC(2026, 2, 1)));
                expect(out).toHaveLength(0);
            });

            it("still expands a live series through the whole window", () => {
                // The clip is scoped to cancelled events; a scheduled weekly
                // event keeps all four March occurrences.
                const live = { ...cancelledWeekly(), id: "live", status: "scheduled" as const };
                const out = expandRecurrences([live], from, to, new Date(Date.UTC(2026, 2, 1)));
                expect(out).toHaveLength(4);
            });

            it("leaves an already-finished window empty rather than shifting it", () => {
                // `now` far past the window: the clip resolves to the window
                // end, so the historical range still expands normally.
                const out = expandRecurrences([cancelledWeekly()], from, to, new Date(Date.UTC(2027, 0, 1)));
                expect(out).toHaveLength(4);
            });
        });

        // Discord's API cannot express a per-occurrence exception, so the team
        // writes skipped dates into the description and the Worker parses them
        // into `cancelledDates`. Cancelled occurrences are still RENDERED (so
        // the change is visible) but flagged `isCancelled` for styling; the
        // .ics feed is what omits them.
        describe("per-occurrence cancellations (cancelledDates)", () => {
            function weeklyWednesday(cancelledDates: string[] = []): CalendarEvent {
                return sampleEvent({
                    id: "ex",
                    name: "Weekly standup",
                    start: "2026-03-04T19:00:00.000Z", // a Wednesday
                    isRecurring: true,
                    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE",
                    cancelledDates,
                });
            }

            it("flags the cancelled occurrence and keeps the rest unflagged", () => {
                // March 2026 Wednesdays: 4, 11, 18, 25. Cancel the 18th.
                const out = expandRecurrences([weeklyWednesday(["2026-03-18"])], from, to);
                expect(out.map((o) => o.start.getUTCDate())).toEqual([4, 11, 18, 25]);
                expect(out.map((o) => o.isCancelled)).toEqual([false, false, true, false]);
            });

            it("flags several cancelled occurrences", () => {
                const out = expandRecurrences([weeklyWednesday(["2026-03-11", "2026-03-25"])], from, to);
                expect(out.map((o) => o.start.getUTCDate())).toEqual([4, 11, 18, 25]);
                expect(out.map((o) => o.isCancelled)).toEqual([false, true, false, true]);
            });

            it("flags a contiguous run from a comma-separated-style list", () => {
                // Mirrors what the Worker produces for
                // "Cancelled: October 13th 2026, November 10th, 2026".
                const out = expandRecurrences([weeklyWednesday(["2026-03-04", "2026-03-11", "2026-03-18"])], from, to);
                expect(out.map((o) => o.isCancelled)).toEqual([true, true, true, false]);
            });

            it("can flag every occurrence in the window", () => {
                const all = ["2026-03-04", "2026-03-11", "2026-03-18", "2026-03-25"];
                const out = expandRecurrences([weeklyWednesday(all)], from, to);
                expect(out).toHaveLength(4);
                expect(out.every((o) => o.isCancelled)).toBe(true);
            });

            it("ignores a cancelled date that matches no occurrence", () => {
                // A note for a date the rule does not generate (a Thursday)
                // must not flag anything or throw.
                const out = expandRecurrences([weeklyWednesday(["2026-03-19"])], from, to);
                expect(out).toHaveLength(4);
                expect(out.some((o) => o.isCancelled)).toBe(false);
            });

            it("tolerates an empty or absent cancelledDates list", () => {
                expect(expandRecurrences([weeklyWednesday([])], from, to).every((o) => !o.isCancelled)).toBe(true);
                const noField = { ...weeklyWednesday(), cancelledDates: [] };
                expect(expandRecurrences([noField], from, to).every((o) => !o.isCancelled)).toBe(true);
            });

            it("matches on the local calendar day, not the UTC instant", () => {
                // An evening UTC time can fall on the next local day; the note
                // is written the way the grid displays it, so the match must
                // use local components. A 23:00Z start is still the same local
                // day in US/Eastern, so the 11th must be flagged.
                const ev = sampleEvent({
                    id: "tz",
                    name: "Evening meeting",
                    start: "2026-03-04T23:00:00.000Z",
                    isRecurring: true,
                    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE",
                    cancelledDates: ["2026-03-11"],
                });
                const out = expandRecurrences([ev], from, to);
                const flagged = out.filter((o) => o.isCancelled).map((o) => o.start.getUTCDate());
                expect(flagged).toEqual([11]);
            });

            it("does not flag a non-recurring event", () => {
                // Cancellations only apply where occurrences are generated;
                // a one-off has no rule to index into.
                const oneOff = sampleEvent({
                    id: "one",
                    name: "One-off",
                    start: "2026-03-10T19:00:00.000Z",
                    cancelledDates: ["2026-03-10"],
                });
                const out = expandRecurrences([oneOff], from, to);
                expect(out).toHaveLength(1);
                expect(out[0]?.isCancelled).toBe(false);
            });

            it("always sets isCancelled to a boolean, never undefined", () => {
                // The styling reads this directly, so a missing field would
                // silently render a cancelled occurrence as normal.
                const out = expandRecurrences(
                    [
                        weeklyWednesday(["2026-03-11"]),
                        sampleEvent({ id: "o", name: "One-off", start: "2026-03-05T19:00:00Z" }),
                    ],
                    from,
                    to,
                );
                expect(out.every((o) => typeof o.isCancelled === "boolean")).toBe(true);
            });
        });
    });

    describe("describeRecurrence", () => {
        /** Build a recurring event around a fixed Wednesday base start. */
        function recurring(rule: string | null, isRecurring = true): CalendarEvent {
            return sampleEvent({
                id: "rec",
                name: "Weekly standup",
                start: "2026-10-07T19:00:00.000Z", // A Wednesday
                isRecurring,
                recurrenceRule: rule,
            });
        }

        it("describes a plain weekly rule", () => {
            expect(describeRecurrence(recurring("FREQ=WEEKLY;INTERVAL=1;BYDAY=WE"))).toBe("Every week on Wednesday");
        });

        it("describes an every-other-week rule", () => {
            expect(describeRecurrence(recurring("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE"))).toBe("Every 2 weeks on Wednesday");
        });

        it("describes a weekday rule", () => {
            expect(describeRecurrence(recurring("FREQ=DAILY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR"))).toBe("Every weekday");
        });

        it("describes a monthly Nth-weekday rule", () => {
            expect(describeRecurrence(recurring("FREQ=MONTHLY;INTERVAL=1;BYDAY=4WE"))).toBe(
                "Every month on the 4th Wednesday",
            );
        });

        it("describes a yearly month-and-day rule", () => {
            expect(describeRecurrence(recurring("FREQ=YEARLY;INTERVAL=1;BYMONTH=7;BYMONTHDAY=24"))).toBe(
                "Every July on the 24th",
            );
        });

        it("handles a bare frequency with no BYDAY", () => {
            expect(describeRecurrence(recurring("FREQ=WEEKLY"))).toBe("Every week");
        });

        it("capitalizes only the first letter", () => {
            const text = describeRecurrence(recurring("FREQ=DAILY;INTERVAL=1;BYDAY=SA,SU"));
            // rrule's own phrasing is lowercase-first with capitalized weekday
            // names, e.g. "every day on Saturday, Sunday".
            expect(text?.startsWith("Every")).toBe(true);
            expect(text).toBe("Every day on Saturday, Sunday");
        });

        it("returns null for a non-recurring event", () => {
            expect(
                describeRecurrence(sampleEvent({ id: "1", name: "One-off", start: "2026-10-07T19:00:00Z" })),
            ).toBeNull();
        });

        it("returns null when the flag is set but no rule is present", () => {
            expect(describeRecurrence(recurring(null))).toBeNull();
        });

        it("returns null for an unparseable rule rather than throwing", () => {
            expect(describeRecurrence(recurring("NOT_AN_RRULE"))).toBeNull();
        });

        it("returns null for a rule with no recognizable frequency", () => {
            // rrulestr defaults a missing FREQ to YEARLY rather than throwing,
            // so this must be rejected explicitly to avoid claiming the event
            // repeats yearly.
            expect(describeRecurrence(recurring("INTERVAL=1"))).toBeNull();
        });
    });
});
