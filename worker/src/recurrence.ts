/**
 * Conversion from Discord's structured recurrence rule to an RFC 5545 RRULE
 * body.
 *
 * Discord does NOT send a pre-serialized RRULE string. `recurrence_rule` on a
 * guild scheduled event is an object:
 *
 *   { start, end?, frequency, interval, by_weekday?, by_n_weekday?,
 *     by_month?, by_month_day?, by_year_day?, count? }
 *
 * Both consumers -- the website's month grid (`expandRecurrences` in
 * `src/lib/discord.ts`) and the `.ics` feed (`buildCalendar` in `ics.ts`) --
 * want the RRULE *body* without the leading `RRULE:` prefix, so the Worker
 * converts once here and the two formats can never drift apart.
 *
 * @see https://discord.com/developers/docs/resources/guild-scheduled-event#guild-scheduled-event-recurrence-rule-object
 */

/**
 * Discord's recurrence rule object (only the fields we read). `by_year_day`
 * and `count` are omitted because the docs state they cannot be set by
 * clients/applications, so they never appear in an API response.
 */
export interface DiscordRecurrenceRule {
    start: string;
    end?: string | null;
    frequency: number;
    interval: number;
    by_weekday?: number[] | null;
    by_n_weekday?: { n: number; day: number }[] | null;
    by_month?: number[] | null;
    by_month_day?: number[] | null;
}

/**
 * Discord frequency enum -> RFC 5545 FREQ. The values are Discord's
 * documented ints: YEARLY 0, MONTHLY 1, WEEKLY 2, DAILY 3.
 */
const FREQ_BY_CODE: Record<number, string> = {
    0: "YEARLY",
    1: "MONTHLY",
    2: "WEEKLY",
    3: "DAILY",
};

/** Discord weekday enum (0 = Monday .. 6 = Sunday) -> RFC 5545 BYDAY. */
const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

function weekdayCode(day: number): string | null {
    return Number.isInteger(day) ? (WEEKDAY_CODES[day] ?? null) : null;
}

/**
 * `by_weekday` and `by_n_weekday` both map to BYDAY and are mutually
 * exclusive in Discord; `by_weekday` wins when both are somehow present.
 * `by_n_weekday` entries become ordinal-byday values (`4WE` == "4th Wed").
 */
function buildByDay(rule: DiscordRecurrenceRule): string[] {
    const weekdays = (rule.by_weekday ?? []).map(weekdayCode).filter((d): d is string => d !== null);
    if (weekdays.length > 0) return weekdays;

    return (rule.by_n_weekday ?? [])
        .map(({ n, day }) => {
            const code = weekdayCode(day);
            return code !== null && Number.isInteger(n) && n >= 1 && n <= 5 ? `${n}${code}` : null;
        })
        .filter((d): d is string => d !== null);
}

function buildByMonth(rule: DiscordRecurrenceRule): number[] {
    return (rule.by_month ?? []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
}

function buildByMonthDay(rule: DiscordRecurrenceRule): number[] {
    return (rule.by_month_day ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
}

/**
 * Format an ISO-8601 timestamp as an RFC 5545 UTC date-time
 * (`20261103T190000Z`), the form UNTIL requires when DTSTART is UTC -- which
 * it always is here (`ics.ts` serializes everything in UTC).
 *
 * Returns null for anything unparseable so the caller can drop the bound and
 * fall back to an unbounded rule rather than emit a malformed UNTIL that
 * would make a calendar client reject the whole RRULE.
 */
function formatUntil(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Convert a Discord recurrence rule into an RFC 5545 RRULE body (without the
 * leading `RRULE:`), or null when the rule is unusable.
 *
 * An unknown frequency or a missing/non-positive interval rejects the whole
 * rule: an event that degrades to a single occurrence is better than a rule
 * that makes a calendar client reject the entire feed. Individual
 * out-of-range values inside an otherwise valid rule are dropped instead.
 *
 * `rule.end` (Discord's "ending time of the recurrence interval") becomes
 * UNTIL. Without it a series that ends is indistinguishable from an infinite
 * one: the month grid would render occurrences forever and the .ics feed
 * would publish a never-terminating RRULE.
 */
export function formatRecurrenceRule(rule: DiscordRecurrenceRule | null | undefined): string | null {
    if (!rule) return null;

    const freq = FREQ_BY_CODE[rule.frequency];
    if (!freq) return null;

    const parts = [`FREQ=${freq}`];

    if (Number.isInteger(rule.interval) && rule.interval > 0) {
        parts.push(`INTERVAL=${rule.interval}`);
    }

    const byDay = buildByDay(rule);
    if (byDay.length > 0) parts.push(`BYDAY=${byDay.join(",")}`);

    const byMonth = buildByMonth(rule);
    if (byMonth.length > 0) parts.push(`BYMONTH=${byMonth.join(",")}`);

    const byMonthDay = buildByMonthDay(rule);
    if (byMonthDay.length > 0) parts.push(`BYMONTHDAY=${byMonthDay.join(",")}`);

    // UNTIL must be the last part: RFC 5545 requires it to terminate the
    // recurrence, and ics.ts emits the body verbatim into the feed.
    const until = formatUntil(rule.end);
    if (until) parts.push(`UNTIL=${until}`);

    return parts.join(";");
}
