/**
 * Parsing for the team's in-description cancellation convention.
 *
 * Discord has no per-occurrence exception mechanism: a guild scheduled event
 * is one record plus a recurrence rule, and the rule object has no
 * `EXDATE`-equivalent field. Cancelling a single occurrence is therefore not
 * expressible through the API at all. The team works around that by writing
 * the skipped dates into the event description:
 *
 *     Location: **Lavery Hall 335**
 *     Cancelled: October 11th 2026
 *
 * This module turns those lines into concrete dates so both consumers can act
 * on them: the website drops the occurrence from the month grid (and from the
 * agenda/mobile views), and the `.ics` feed emits a matching `EXDATE` so
 * subscribers' calendar apps drop it too.
 *
 * Deliberately pure -- no bindings, no `fetch`, no KV -- so the convention is
 * unit-testable without Cloudflare's ambient types. The reference year comes
 * from the caller (the event's own start time) rather than `new Date()`, so
 * parsing is deterministic and a series pinned to a past year still parses.
 *
 * Accepted shapes:
 *  - A line labelled `Cancelled:` / `Canceled:` / `Skipped:` / `No meeting:`
 *    (case-insensitive, `:` or a dash separator).
 *  - Dates in month-name form (`October 11th 2026`, `Oct 11, 2026`) or ISO
 *    form (`2026-10-11`), anywhere on that line.
 *  - Several dates on one line, on several lines, or both.
 *  - The year may be omitted (`Cancelled: October 11th`); it is then taken
 *    from the event's start year.
 *
 * Anything unparseable is ignored rather than throwing: a malformed note must
 * never take down the whole calendar.
 */

/**
 * Label prefixes that introduce a cancellation line. Kept deliberately tight
 * -- a loose pattern would swallow ordinary prose that happens to mention a
 * date (e.g. "We cancelled the October 11th launch, new date TBD").
 */
const LABEL_RE = /^\s*(?:cancelled|canceled|skipped|no meeting)\s*[:\u2013\u2014-]\s*(.*)$/i;

const MONTHS: Readonly<Record<string, number>> = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    sept: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
};

/** `October 11th 2026` / `Oct 11, 2026` / `October 11` (year optional). */
const MONTH_DAY_RE = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?\b/gi;

/** `2026-10-11`. */
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Build `YYYY-MM-DD`, or null when the parts are not a real calendar date
 * (rejects Feb 30, month 13, day 0, and so on). Round-trips through `Date` so
 * leap-year and month-length rules come from the platform.
 */
function toIsoDate(year: number, month: number, day: number): string | null {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    if (year < 1970 || year > 9999) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
        return null;
    }
    return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Extract every cancelled calendar date from an event description.
 *
 * `referenceYear` fills in dates written without a year. Returns ISO
 * `YYYY-MM-DD` strings, deduplicated and sorted so the output is stable and
 * easy to assert on.
 */
export function parseCancelledDates(description: string | null | undefined, referenceYear?: number | null): string[] {
    if (!description) return [];

    // Fall back to a sane year when the caller has none, so a bare
    // "Cancelled: October 11th" still resolves instead of being dropped.
    const fallbackYear =
        typeof referenceYear === "number" && Number.isInteger(referenceYear) && referenceYear >= 1970
            ? referenceYear
            : new Date().getUTCFullYear();

    const found = new Set<string>();

    for (const rawLine of description.split(/\r?\n/)) {
        const label = rawLine.match(LABEL_RE);
        if (!label) continue;
        // `label[1]` is the text after the separator; the line is known to
        // have matched, so it is always present.
        const body = label[1] ?? "";

        for (const m of body.matchAll(ISO_DATE_RE)) {
            const iso = toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
            if (iso) found.add(iso);
        }

        for (const m of body.matchAll(MONTH_DAY_RE)) {
            const month = MONTHS[(m[1] ?? "").toLowerCase()];
            if (!month) continue; // Not a month name (e.g. "next week").
            const year = m[3] ? Number(m[3]) : fallbackYear;
            const iso = toIsoDate(year, month, Number(m[2]));
            if (iso) found.add(iso);
        }
    }

    return [...found].sort();
}

/**
 * Remove `Cancelled:` note lines from a description, returning null when
 * nothing meaningful remains.
 *
 * The dates are surfaced as cancelled chips on the calendar, so the raw note
 * line is redundant (and reads as noise) in the modal body. Only *labelled*
 * lines are removed -- the same `LABEL_RE` the parser uses, so the two can
 * never disagree about what counts as a note.
 *
 * Mirrors `extractLocationFromDescription`'s tidying: collapse the blank-line
 * runs and stray whitespace left behind by the removal.
 */
export function stripCancelledNote(description: string | null | undefined): string | null {
    if (!description) return null;

    const kept = description.split(/\r?\n/).filter((line) => !LABEL_RE.test(line));
    if (kept.length === description.split(/\r?\n/).length) return description;

    // Collapse any blank-line runs the removal left behind, plus stranded
    // spaces before punctuation on the now-adjacent lines.
    const cleaned = kept
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+$/gm, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    return cleaned || null;
}

/**
 * Format an ISO date as an RFC 5545 UTC date-time, borrowing the time of day
 * from the event's own start so the `EXDATE` lands exactly on the generated
 * occurrence. Calendar clients match `EXDATE` against `DTSTART` by value, so
 * a midnight timestamp would not exclude an evening meeting.
 *
 * `timeSource` is the event's `DTSTART`; when it is unparseable the date is
 * still emitted at 00:00:00Z rather than dropped, which at least matches
 * occurrences that genuinely start at midnight.
 */
export function toExdateValue(isoDate: string, timeSource: string): string | null {
    const [y, m, d] = isoDate.split("-").map(Number);
    // `Number("not-a-date")` is NaN, not undefined, so a truthiness or
    // undefined check here would let `NaNNaNNaNT...Z` through into the feed.
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    // Re-validate as a real calendar date rather than trusting the caller.
    const roundTrip = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
    if (
        roundTrip.getUTCFullYear() !== y ||
        roundTrip.getUTCMonth() !== (m as number) - 1 ||
        roundTrip.getUTCDate() !== d
    ) {
        return null;
    }

    let hh = 0;
    let mm = 0;
    let ss = 0;
    const start = new Date(timeSource);
    if (!Number.isNaN(start.getTime())) {
        hh = start.getUTCHours();
        mm = start.getUTCMinutes();
        ss = start.getUTCSeconds();
    }

    return `${y}${pad(m as number)}${pad(d as number)}T${pad(hh)}${pad(mm)}${pad(ss)}Z`;
}
