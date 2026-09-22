import {
    type CalendarEvent,
    DISCORD_GUILD_ID,
    DiscordError,
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
    });
});
