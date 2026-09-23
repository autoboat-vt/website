import { AlertCircle, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CalendarSubscribe from "../components/CalendarSubscribe";
import Card from "../components/Card";
import EventModal from "../components/EventModal";
import {
    type CalendarEvent,
    type ExpandedOccurrence,
    expandRecurrences,
    fetchEvents,
    OFFICERS_URL,
} from "../lib/discord";

const DAY_HEADINGS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Single-letter labels used on mobile, where the 3-letter forms overflow
 * a ~45px column. `aria-label` keeps the full name for screen readers. */
const DAY_HEADINGS_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
}

function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

interface DayCell {
    date: Date;
    inCurrentMonth: boolean;
    isToday: boolean;
    occurrences: ExpandedOccurrence[];
}

/**
 * Build the month grid for a given calendar month.
 * The grid starts on the Sunday on or before the 1st and ends on the Saturday
 * on or after the last day. The row count is variable (usually 5 weeks = 35
 * cells, occasionally 6 = 42) because we pad the visible month only -- a
 * constant 42-cell grid means every other month wastes a row on a fully
 * other-month week.
 */
function buildMonthGrid(
    monthAnchor: Date,
    occurrences: ExpandedOccurrence[],
    now: Date,
): { cells: DayCell[]; monthLabel: string } {
    const year = monthAnchor.getFullYear();
    const month = monthAnchor.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const monthStart = startOfDay(firstOfMonth);
    const lastOfMonth = new Date(year, month + 1, 0);
    const monthEnd = startOfDay(lastOfMonth);

    // DAY_HEADINGS is Sun..Sat, column 0 is Sunday, and Date.getDay() is Sun = 0,
    // so the 1st's getDay() is exactly how many leading other-month pad days the
    // grid needs for its column to match its heading.
    const gridStartOffset = monthStart.getDay();
    const gridStart = addDays(monthStart, -gridStartOffset);
    const daysFromSaturdayInMonth = 6 - monthEnd.getDay();

    // Do not compute the count via timestamp diff / 86400000 -- DST transitions
    // cause 23- and 25-hour days that throw off integer math. Iterate by date
    // instead so each cell is one calendar day regardless of hour changes.
    const cellCount = gridStartOffset + lastOfMonth.getDate() + daysFromSaturdayInMonth + 1;

    const cells: DayCell[] = [];
    for (let i = 0; i < cellCount; i++) {
        const date = addDays(gridStart, i);
        const dayStart = startOfDay(date);
        const dayEnd = addDays(dayStart, 1);
        // Half-open interval [start, max(end, start+epsilon)) so zero-duration
        // events (start == end) still render on their start day.
        const thatDay = occurrences.filter((o) => {
            const occEnd = o.end.getTime() > o.start.getTime() ? o.end.getTime() : o.start.getTime() + 1;
            return o.start.getTime() < dayEnd.getTime() && occEnd > dayStart.getTime();
        });
        cells.push({
            date,
            inCurrentMonth: date.getMonth() === month,
            isToday: isSameDay(date, now),
            occurrences: thatDay,
        });
    }

    const monthLabel = monthAnchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    return { cells, monthLabel };
}

function formatOccurrenceTime(occ: ExpandedOccurrence): string {
    const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    const start = occ.start.toLocaleTimeString(undefined, opts);
    if (occ.end.getTime() === occ.start.getTime()) {
        return start;
    }
    return `${start} - ${occ.end.toLocaleTimeString(undefined, opts)}`;
}

/**
 * Class list for an event chip.
 *
 * Two independent notions of "cancelled" meet here:
 *  - `occurrence.isCancelled` -- THIS occurrence was cancelled individually
 *    via the description's `Cancelled:` note.
 *  - `event.status === "canceled"` -- the whole series was cancelled in
 *    Discord. Every occurrence of it is cancelled.
 * Both render with the same treatment, since to a reader they mean the same
 * thing: this meeting is not happening.
 */
function eventChipClassName(occurrence: ExpandedOccurrence): string {
    const { event, isCancelled } = occurrence;
    let cls = "calendar-event";
    if (isCancelled || event.status === "canceled") cls += " calendar-event--canceled";
    else if (event.status === "completed") cls += " calendar-event--completed";
    if (event.isRecurring) cls += " calendar-event--recurring";
    return cls;
}

function EventChip({
    occurrence,
    onClick,
}: {
    occurrence: ExpandedOccurrence;
    onClick: (occ: ExpandedOccurrence) => void;
}) {
    const { event } = occurrence;
    const time = formatOccurrenceTime(occurrence);
    return (
        <button
            type="button"
            className={eventChipClassName(occurrence)}
            title={`${event.name} (${time})${occurrence.isCancelled ? " - cancelled" : ""}`}
            onClick={() => onClick(occurrence)}
        >
            <span className="calendar-event__time">{time}</span>
            <span className="calendar-event__name">{event.name}</span>
        </button>
    );
}

/**
 * A row in the mobile agenda list shown below the month grid for the
 * selected day. Same accent-border treatment as the grid chips, laid out
 * as a comfortable full-width tap target.
 */
function AgendaRow({
    occurrence,
    onClick,
}: {
    occurrence: ExpandedOccurrence;
    onClick: (occ: ExpandedOccurrence) => void;
}) {
    const { event } = occurrence;
    const time = formatOccurrenceTime(occurrence);
    return (
        <li>
            <button
                type="button"
                className={eventChipClassName(occurrence)}
                title={occurrence.isCancelled ? `${event.name} - cancelled` : event.name}
                onClick={() => onClick(occurrence)}
            >
                <span className="calendar-event__time">{time}</span>
                <span className="calendar-event__name">{event.name}</span>
            </button>
        </li>
    );
}

/**
 * Events refresh cadence while the page is visible.
 *
 * Kept in sync with the Worker's `CACHE_TTL_SECONDS` (180s): polling faster
 * would only re-read the same cached payload, because the Worker cannot serve
 * anything fresher.
 *
 * This is a READ-side setting. The Worker's write budget (the free tier allows
 * 1,000 writes/day, and only a cache MISS costs one) is what actually bounds
 * the TTL -- see the write budget note in `worker/src/index.ts`. Shortening
 * this interval does NOT reduce writes, since a warm cache is pure reads.
 */
const EVENTS_POLL_INTERVAL_MS = 180_000;

export interface CalendarProps {
    /**
     * Which feed to read. `officer` reads the Worker's `/officers/events`
     * route, which includes officer-only events the public feed filters out.
     * Used by the `/calendar/officers` page; `/calendar` keeps the default.
     */
    variant?: "public" | "officer";
}

export default function Calendar({ variant = "public" }: CalendarProps) {
    const baseUrl = variant === "officer" ? OFFICERS_URL : undefined;
    const [monthAnchor, setMonthAnchor] = useState(() => {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), 1);
    });
    const [events, setEvents] = useState<CalendarEvent[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(() => new Date());
    const [selectedOccurrence, setSelectedOccurrence] = useState<ExpandedOccurrence | null>(null);
    // Mobile month-grid substitute: the tapped day whose events are listed
    // in the agenda below the grid. Defaults to today so the agenda is
    // populated on first load. Only rendered on narrow viewports.
    const [selectedDay, setSelectedDay] = useState<Date | null>(() => startOfDay(new Date()));
    // Viewport gate kept as React state so mobile renders day-cells as
    // buttons (with dots) instead of per-event chips -- nested <button>s
    // would be invalid HTML. matchMedia is stubbed (matches: false) in
    // tests, which exercise the desktop branch.
    const [isMobile, setIsMobile] = useState(() =>
        typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 700px)").matches : false,
    );
    useEffect(() => {
        if (typeof window.matchMedia !== "function") return;
        const mq = window.matchMedia("(max-width: 700px)");
        const onChange = () => setIsMobile(mq.matches);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, []);

    // Keep "today" fresh so the highlight moves at midnight without a fetch.
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(t);
    }, []);

    // Abort controller for in-flight polls; cancelled on unmount or when a
    // newer poll starts. Keeps state clean across rapid re-renders.
    const abortRef = useRef<AbortController | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // Tracks whether any poll has produced data, so transient failures can
    // stay silent once the grid is populated.
    const hasDataRef = useRef(false);

    const poll = useCallback(async () => {
        // Cancel any in-flight poll before starting a new one.
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const data = await fetchEvents(controller.signal, baseUrl);
            // If we were aborted while awaiting, drop the result.
            if (controller.signal.aborted) return;
            hasDataRef.current = true;
            setEvents(data);
            setError(null);
        } catch (err) {
            if (controller.signal.aborted) return; // Expected on unmount/replace.
            // Only surface an error (and blank the grid) when there are no
            // events to show. Transient poll failures keep the last-good data.
            if (hasDataRef.current) return;
            setError(err instanceof Error ? err.message : "Failed to load events");
            setEvents([]);
        }
    }, [baseUrl]);

    // Initial load + polling loop with visibility-aware pause, mirroring the
    // LiveMap pattern (skip hidden tabs, immediately repoll on visibility).
    useEffect(() => {
        poll();
        intervalRef.current = setInterval(() => {
            if (document.hidden) return;
            poll();
        }, EVENTS_POLL_INTERVAL_MS);

        const onVisibility = () => {
            // On becoming visible again, immediately poll rather than waiting
            // for the next interval tick -- feels more "live".
            if (!document.hidden) poll();
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            if (intervalRef.current) clearInterval(intervalRef.current);
            abortRef.current?.abort();
        };
    }, [poll]);

    const occurrences = useMemo(() => {
        if (events === null) return [];
        // Window is padded +/- one week so recurring boundaries at the start
        // or end of the grid still produce the right chips.
        const windowStart = addDays(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1), -7);
        const windowEnd = addDays(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0), 7);
        // Pass the tracked clock: expandRecurrences clips cancelled series at
        // `now`, so it must follow the same clock the "today" highlight uses.
        return expandRecurrences(events, windowStart, windowEnd, now);
    }, [events, monthAnchor, now]);

    const { cells, monthLabel } = useMemo(
        () => buildMonthGrid(monthAnchor, occurrences, now),
        [monthAnchor, occurrences, now],
    );

    const isLoading = events === null && error === null;

    /**
     * Follow month navigation with the agenda selection (1st of the newly
     * shown month) so the agenda never shows a day the grid no longer displays.
     */
    const navigateMonth = (offset: number) => {
        setMonthAnchor((m) => {
            const next = new Date(m.getFullYear(), m.getMonth() + offset, 1);
            setSelectedDay(startOfDay(next));
            return next;
        });
    };
    const goToToday = () => {
        const now = new Date();
        setMonthAnchor(new Date(now.getFullYear(), now.getMonth(), 1));
        setSelectedDay(startOfDay(now));
    };

    const selectedDayOccurrences = useMemo(() => {
        if (selectedDay === null) return [];
        const dayStart = startOfDay(selectedDay);
        const dayEnd = addDays(dayStart, 1);
        // Same half-open interval as buildMonthGrid's per-day filter so a
        // zero-duration event is listed on its start day.
        return occurrences.filter((o) => {
            const occEnd = o.end.getTime() > o.start.getTime() ? o.end.getTime() : o.start.getTime() + 1;
            return o.start.getTime() < dayEnd.getTime() && occEnd > dayStart.getTime();
        });
    }, [occurrences, selectedDay]);

    return (
        <section className="section mx-auto grid max-w-275 gap-8 px-4 py-16">
            {error && (
                <Card className="calendar-error" role="alert">
                    <h3>Couldn't load events</h3>
                    <p className="mb-0 flex items-center gap-2">
                        <AlertCircle size={18} aria-hidden="true" />
                        {error}
                    </p>
                </Card>
            )}

            {isLoading && (
                <div className="flex items-center justify-center gap-2 py-12 text-hovercolor" aria-live="polite">
                    <Loader2 className="animate-spin" size={22} aria-hidden="true" />
                    <span>Loading events...</span>
                </div>
            )}

            {!isLoading && !error && (
                // Card caps its own width at min(1100px, 90%); w-full max-w-none lets
                // the grid fill the section instead on wide viewports.
                <Card className="calendar-wrapper w-full max-w-none">
                    <div className="calendar-header">
                        {/* The two arrows live in ONE group so the header can
                            never wrap between them. They used to be split
                            across the header (prev) and the controls group
                            (next), so when the controls group wrapped to its
                            own row on a narrow screen the arrows stacked
                            vertically instead of staying side by side. */}
                        <div className="calendar-month-nav">
                            <button
                                type="button"
                                className="calendar-nav-btn"
                                onClick={() => navigateMonth(-1)}
                                aria-label="Previous month"
                            >
                                <ChevronLeft size={18} />
                            </button>
                            <h2 className="calendar-month-label">{monthLabel}</h2>
                            <button
                                type="button"
                                className="calendar-nav-btn"
                                onClick={() => navigateMonth(1)}
                                aria-label="Next month"
                            >
                                <ChevronRight size={18} />
                            </button>
                        </div>
                        <div className="calendar-header__controls">
                            <button type="button" className="btn btn--sm" onClick={goToToday}>
                                Today
                            </button>
                            {/* Renders the toggle inline here; its panel is
                                absolutely positioned so it can't stretch this
                                nowrap group (see .calendar-subscribe__panel). */}
                            <CalendarSubscribe variant={variant} />
                        </div>
                    </div>

                    <div className="calendar">
                        {DAY_HEADINGS.map((d, i) => (
                            // Mobile shows the single-letter form (visually hidden
                            // full name keeps screen readers on "Sunday", not "S").
                            <div key={d} className="calendar-dow">
                                {isMobile ? (
                                    <>
                                        <span aria-hidden="true">{DAY_HEADINGS_SHORT[i]}</span>
                                        <span className="sr-only">{d}</span>
                                    </>
                                ) : (
                                    d
                                )}
                            </div>
                        ))}
                        {cells.map((cell) => {
                            let dayCls = "calendar-day";
                            if (!cell.inCurrentMonth) dayCls += " calendar-day--other-month";
                            if (cell.isToday) dayCls += " calendar-day--today";
                            const isSelected = selectedDay !== null && isSameDay(cell.date, selectedDay);
                            if (isMobile && isSelected) dayCls += " calendar-day--selected";
                            const dayLabel = cell.date.toLocaleDateString(undefined, {
                                weekday: "long",
                                month: "long",
                                day: "numeric",
                            });
                            if (isMobile) {
                                const count = cell.occurrences.length;
                                const ariaLabel =
                                    count === 0
                                        ? dayLabel
                                        : count === 1
                                          ? `${dayLabel}, 1 event`
                                          : `${dayLabel}, ${count} events`;
                                return (
                                    <button
                                        key={cell.date.toISOString()}
                                        type="button"
                                        className={dayCls}
                                        aria-label={ariaLabel}
                                        aria-pressed={isSelected}
                                        onClick={() => setSelectedDay(startOfDay(cell.date))}
                                    >
                                        <span className="calendar-day-number">{cell.date.getDate()}</span>
                                        {count > 0 && (
                                            <span className="calendar-day-dots" aria-hidden="true">
                                                {cell.occurrences.slice(0, 3).map((occ, i) => {
                                                    let dotCls = "calendar-day-dot";
                                                    if (occ.isCancelled || occ.event.status === "canceled")
                                                        dotCls += " calendar-day-dot--muted";
                                                    else if (occ.event.status === "completed")
                                                        dotCls += " calendar-day-dot--muted";
                                                    if (occ.event.isRecurring) dotCls += " calendar-day-dot--recurring";
                                                    return (
                                                        <span
                                                            className={dotCls}
                                                            key={`${occ.event.id}-${occ.start.getTime()}-${i}`}
                                                        />
                                                    );
                                                })}
                                                {count > 3 && <span className="calendar-day-more">+{count - 3}</span>}
                                            </span>
                                        )}
                                    </button>
                                );
                            }
                            return (
                                <div key={cell.date.toISOString()} className={dayCls}>
                                    <div className="calendar-day-number">{cell.date.getDate()}</div>
                                    <div className="calendar-day-events">
                                        {cell.occurrences.map((occ, i) => (
                                            <EventChip
                                                key={`${occ.event.id}-${occ.start.getTime()}-${i}`}
                                                occurrence={occ}
                                                onClick={setSelectedOccurrence}
                                            />
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {isMobile && selectedDay !== null && (
                        <div className="calendar-agenda">
                            <h3 className="calendar-agenda__heading">
                                {selectedDay.toLocaleDateString(undefined, {
                                    weekday: "long",
                                    month: "long",
                                    day: "numeric",
                                })}
                            </h3>
                            {selectedDayOccurrences.length === 0 ? (
                                <p className="calendar-agenda__empty">No events</p>
                            ) : (
                                <ul className="calendar-agenda__list">
                                    {selectedDayOccurrences.map((occ, i) => (
                                        <AgendaRow
                                            key={`${occ.event.id}-${occ.start.getTime()}-${i}`}
                                            occurrence={occ}
                                            onClick={setSelectedOccurrence}
                                        />
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {events !== null && events.length === 0 && (
                        <p className="mt-6 text-center text-hovercolor">
                            No events are scheduled yet. Check the team Discord for the latest updates.
                        </p>
                    )}
                </Card>
            )}

            <EventModal occurrence={selectedOccurrence} onClose={() => setSelectedOccurrence(null)} />
        </section>
    );
}
