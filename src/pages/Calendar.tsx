import { AlertCircle, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Card from "../components/Card";
import {
    type CalendarEvent,
    discordEventUrl,
    type ExpandedOccurrence,
    expandRecurrences,
    fetchEvents,
} from "../lib/discord";

const DAY_HEADINGS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

function eventChipClassName(event: CalendarEvent): string {
    let cls = "calendar-event";
    if (event.status === "canceled") cls += " calendar-event--canceled";
    else if (event.status === "completed") cls += " calendar-event--completed";
    if (event.isRecurring) cls += " calendar-event--recurring";
    return cls;
}

function EventChip({ occurrence }: { occurrence: ExpandedOccurrence }) {
    const { event } = occurrence;
    const time = formatOccurrenceTime(occurrence);
    return (
        <a
            href={discordEventUrl(event)}
            target="_blank"
            rel="noopener noreferrer"
            className={eventChipClassName(event)}
            title={`${event.name} (${time}) -- view in Discord`}
        >
            <span className="calendar-event__time">{time}</span>
            <span className="calendar-event__name">{event.name}</span>
            <span className="sr-only"> (opens in a new tab)</span>
        </a>
    );
}

export default function Calendar() {
    const [monthAnchor, setMonthAnchor] = useState(() => {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), 1);
    });
    const [events, setEvents] = useState<CalendarEvent[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(() => new Date());

    // Keep "today" fresh so the highlight moves at midnight without a fetch.
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        fetchEvents(controller.signal)
            .then((data) => {
                if (!controller.signal.aborted) {
                    setEvents(data);
                    setError(null);
                }
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted) return;
                setError(err instanceof Error ? err.message : "Failed to load events");
                setEvents([]);
            });
        return () => controller.abort();
    }, []);

    const occurrences = useMemo(() => {
        if (events === null) return [];
        // Window is padded +/- one week so recurring boundaries at the start
        // or end of the grid still produce the right chips.
        const windowStart = addDays(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1), -7);
        const windowEnd = addDays(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0), 7);
        return expandRecurrences(events, windowStart, windowEnd);
    }, [events, monthAnchor]);

    const { cells, monthLabel } = useMemo(
        () => buildMonthGrid(monthAnchor, occurrences, now),
        [monthAnchor, occurrences, now],
    );

    const isLoading = events === null && error === null;

    const goToPrevMonth = () => {
        setMonthAnchor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
    };
    const goToNextMonth = () => {
        setMonthAnchor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
    };
    const goToToday = () => {
        const now = new Date();
        setMonthAnchor(new Date(now.getFullYear(), now.getMonth(), 1));
    };

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
                <Card className="calendar-wrapper">
                    <div className="calendar-header">
                        <button
                            type="button"
                            className="calendar-nav-btn"
                            onClick={goToPrevMonth}
                            aria-label="Previous month"
                        >
                            <ChevronLeft size={18} />
                        </button>
                        <h2 className="calendar-month-label">{monthLabel}</h2>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className="calendar-nav-btn"
                                onClick={goToNextMonth}
                                aria-label="Next month"
                            >
                                <ChevronRight size={18} />
                            </button>
                            <button type="button" className="btn btn--outline btn-sm" onClick={goToToday}>
                                Today
                            </button>
                        </div>
                    </div>

                    <div className="calendar">
                        {DAY_HEADINGS.map((d) => (
                            <div key={d} className="calendar-dow">
                                {d}
                            </div>
                        ))}
                        {cells.map((cell) => {
                            let dayCls = "calendar-day";
                            if (!cell.inCurrentMonth) dayCls += " calendar-day--other-month";
                            if (cell.isToday) dayCls += " calendar-day--today";
                            return (
                                <div key={cell.date.toISOString()} className={dayCls}>
                                    <div className="calendar-day-number">{cell.date.getDate()}</div>
                                    <div className="calendar-day-events">
                                        {cell.occurrences.map((occ, i) => (
                                            <EventChip
                                                key={`${occ.event.id}-${occ.start.getTime()}-${i}`}
                                                occurrence={occ}
                                            />
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {events !== null && events.length === 0 && (
                        <p className="mt-6 text-center text-hovercolor">
                            No events are scheduled yet. Check the team Discord for the latest updates.
                        </p>
                    )}

                    {events?.some((e) => e.isRecurring) && (
                        <p className="mt-6 text-center text-sm text-hovercolor">
                            Recurring meetings are expanded into their individual occurrences.
                        </p>
                    )}
                </Card>
            )}
        </section>
    );
}
