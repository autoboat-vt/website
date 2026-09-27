/**
 * Channel -> label mapping for the calendar channel filter.
 *
 * The team separates events by scheduling them in different Discord voice
 * channels -- one per subteam, one for general members, one for officers. That
 * channel id is the only durable grouping signal on an event (Discord requires
 * `entity_metadata: null` on voice events, so there is no location to group by,
 * and all of the event channels share ONE category, so the category id is
 * identical for every event).
 *
 * The Worker already ships `channelId` on every event, so this module needs no
 * extra API surface. Labels are a hand-maintained map from channel id to a
 * friendly name here rather than being fetched from Discord: the ids are stable
 * and the labels are a display concern, so a lookup table costs nothing at
 * runtime and needs no Worker change or redeploy.
 *
 * SCOPE: the picker only narrows SUBTEAM events. Two kinds of events are
 * deliberately outside it and are always shown:
 *
 *  - **General member events** (`member-events`). They are for the whole team,
 *    so gating them behind a filter would hide the main meetings from exactly
 *    the people they are for.
 *  - **Officer events** (`officer-events`). Their visibility is already decided
 *    by the Worker's audience filter -- absent from the public feed entirely,
 *    present on `/calendar/officers` -- so the picker has nothing to add. On
 *    the officers page they must stay visible too.
 *
 * Channel-less events are the exception: they are not subteam events, but there
 * is nothing else to group them by, so they get their own selectable "Other"
 * group rather than being silently unfilterable.
 *
 * Both properties are enforced by `ALWAYS_VISIBLE_CHANNEL_IDS` rather than by
 * simply leaving those channels out of `SUBTEAM_CHANNELS`, so the behavior is a
 * stated rule instead of an accident of what happens to be missing.
 *
 * WARNING: Channel ids are authoritative but the labels are not self-updating. A
 * renamed Discord channel, or a newly created subteam channel, appears as
 * "Other" until its id and label are added here. `labelForChannel()` falls back
 * to the generic bucket rather than inventing a name, so an unlisted channel
 * never mislabels events -- it just groups them with the channel-less ones.
 */

import type { CalendarEvent } from "./discord";

/**
 * Key used for events that have no channel at all (Discord `EXTERNAL` events,
 * which are not hosted in a voice channel).
 *
 * Prefixed with underscores so it can never collide with a Discord snowflake,
 * which is always numeric. It is a filter key only and is never sent to the
 * Worker: there is no channel id to send, and the Worker excludes channel-less
 * events from any non-empty filter anyway.
 */
export const OTHER_CHANNEL_ID = "__other__";

/** One selectable group in the filter. */
export interface EventChannelGroup {
    /** Filter key: a Discord channel id, or `OTHER_CHANNEL_ID`. */
    id: string;
    /** Label shown in the picker. */
    label: string;
    /** How many events fall in this group, for the count badge. */
    count: number;
}

/**
 * Which groups the user has selected.
 *
 * `null` means "every subteam" and is the initial state; a set means exactly
 * those groups.
 *
 * WARNING: Do NOT collapse this back to "an empty set means everything". That
 * convention looks tidier but cannot express "no subteams selected" when there
 * is only ONE subteam with events -- unchecking it produces an empty set, which
 * would immediately read back as "everything selected", so the checkbox would
 * silently refuse to turn off. Making "all" a distinct value keeps every state
 * representable regardless of how many groups exist.
 */
export type ChannelSelection = ReadonlySet<string> | null;

/** Whether the selection currently covers every subteam. */
export function isAllSelected(selected: ChannelSelection): boolean {
    return selected === null;
}

/**
 * Subteam event channels: the ONLY channels the picker can narrow.
 *
 * Ordering is deliberate and independent of the ids (subteams in the order the
 * team lists them). Channel ids were read from the Worker's `/audiences`
 * diagnostics route, which lists every channel the bot can see, rather than
 * guessed from names.
 *
 * Adding an entry here is what makes a channel filterable; the non-subteam
 * event channels live in `ALWAYS_VISIBLE_CHANNEL_IDS` instead.
 */
export const SUBTEAM_CHANNELS: { id: string; label: string }[] = [
    { id: "1550592611859955862", label: "Software" },
    { id: "1550592897659707402", label: "NavArch" },
    { id: "1550592668105441300", label: "Electrical" },
    { id: "1550592740486553650", label: "Mechanical" },
    { id: "1553773762258800703", label: "Business" },
];

/**
 * Channels whose events are ALWAYS shown and which never appear in the picker.
 *
 * These are the non-subteam event channels:
 *
 *  - `member-events` -- general member events, for the whole team.
 *  - `officer-events` -- visibility already handled by the Worker's audience
 *    filter; the officers calendar must keep showing them.
 *
 * WARNING: An event in one of these channels is NOT hideable. Unchecking every
 * subteam still shows its general member events, which is the point.
 */
export const ALWAYS_VISIBLE_CHANNEL_IDS: ReadonlySet<string> = new Set([
    "1550594275580837921", // member-events
    "1550594891766308997", // officer-events
]);

/** Label for the bucket holding events with no channel. */
const OTHER_LABEL = "Other";

const LABELS_BY_ID = new Map(SUBTEAM_CHANNELS.map((c) => [c.id, c.label]));

/**
 * The filter key for one event.
 *
 * A channel-less event gets `OTHER_CHANNEL_ID` so it is still selectable rather
 * than silently unfilterable.
 */
export function channelKeyFor(event: Pick<CalendarEvent, "channelId">): string {
    return event.channelId ?? OTHER_CHANNEL_ID;
}

/**
 * True when an event is in a channel the picker must never filter out.
 *
 * Used by both `eventChannelGroups` (so these channels get no checkbox) and
 * `matchesChannelFilter` (so they are always shown). Keeping the two in one
 * predicate is what stops the picker from offering a control that cannot
 * actually hide anything.
 */
export function isAlwaysVisible(event: Pick<CalendarEvent, "channelId">): boolean {
    return event.channelId != null && ALWAYS_VISIBLE_CHANNEL_IDS.has(event.channelId);
}

/** Sum of the counts in a group list, for an "All events" affordance. */
export function totalCount(groups: EventChannelGroup[]): number {
    return groups.reduce((sum, g) => sum + g.count, 0);
}

/**
 * Build the selectable groups from a set of loaded events.
 *
 * Only groups that actually contain events are returned, so an empty subteam
 * does not clutter the picker with a checkbox that filters nothing. Groups are
 * ordered by `SUBTEAM_CHANNELS`, with the channel-less bucket last.
 *
 * NOTE: groups are derived from the full loaded set (which the Worker's archive
 * makes all of history), not from the visible month, so a group does not
 * disappear from the picker as the user navigates to a month where that subteam
 * happens to have nothing scheduled.
 */
export function eventChannelGroups(events: CalendarEvent[]): EventChannelGroup[] {
    const counts = new Map<string, number>();
    for (const event of events) {
        // General member and officer channels are never filterable, so they get
        // no group and are not counted -- a badge next to a group that cannot
        // be turned off would misrepresent what the filter does.
        if (isAlwaysVisible(event)) continue;
        const key = channelKeyFor(event);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const groups: EventChannelGroup[] = [];
    for (const { id, label } of SUBTEAM_CHANNELS) {
        const count = counts.get(id);
        if (count) groups.push({ id, label, count });
    }

    // Any channel not in the curated list (a new or renamed event channel) is
    // merged into the channel-less bucket rather than dropped, so its events
    // stay reachable.
    let otherCount = counts.get(OTHER_CHANNEL_ID) ?? 0;
    for (const [key, count] of counts) {
        if (key !== OTHER_CHANNEL_ID && !LABELS_BY_ID.has(key)) otherCount += count;
    }
    if (otherCount > 0) groups.push({ id: OTHER_CHANNEL_ID, label: OTHER_LABEL, count: otherCount });

    return groups;
}

/**
 * Resolve a filter key to its display label.
 *
 * An unrecognised channel id resolves to the "Other" label because that is the
 * bucket `eventChannelGroups` puts it in -- returning the raw id instead would
 * label the same group two different ways.
 */
export function labelForChannel(key: string): string {
    if (key === OTHER_CHANNEL_ID) return OTHER_LABEL;
    return LABELS_BY_ID.get(key) ?? OTHER_LABEL;
}

/**
 * Whether an event passes the current selection.
 *
 * General member and officer events bypass the whole thing -- see
 * `ALWAYS_VISIBLE_CHANNEL_IDS`. That check comes first so the rule reads the
 * same in both selection states.
 *
 * A `null` selection shows every subteam. Otherwise the selection is an
 * allow-list of filter keys, and an event with no channel passes only when its
 * `OTHER_CHANNEL_ID` key is in it.
 */
export function matchesChannelFilter(event: CalendarEvent, selected: ChannelSelection): boolean {
    if (isAlwaysVisible(event)) return true;
    if (selected === null) return true;
    return selected.has(channelKeyFor(event));
}

/**
 * The channel ids to send to the Worker as a `?channels=` filter.
 *
 * `OTHER_CHANNEL_ID` is dropped on purpose: the Worker matches real Discord
 * channel ids, and the bucket holding channel-less events has no id to send.
 * Selecting only "Other" therefore yields only the always-visible ids, so such
 * a subscription returns the general member events rather than nothing. That is
 * the honest outcome -- the Worker cannot express "no channel at all".
 *
 * WARNING: The always-visible channels ride along whenever a filter is active.
 * Without them a subscription would silently drop the general member events the
 * page still shows, so the feed and the grid would stop agreeing.
 */
export function workerChannelIds(selected: ChannelSelection): string[] {
    // `null` (all subteams) is also what the Worker does with no `channels`
    // parameter, so stay empty rather than spelling out every id. Sending all
    // of them would work, but "all" and "explicitly all" would then produce
    // different URLs for the same subscription.
    if (selected === null) return [];
    const ids = new Set<string>(ALWAYS_VISIBLE_CHANNEL_IDS);
    for (const id of selected) {
        if (id !== OTHER_CHANNEL_ID) ids.add(id);
    }
    return [...ids];
}

/**
 * Toggle one group in the selection.
 *
 * From the "all" state this first materializes the full group list and then
 * subtracts, so a single click narrows rather than doing nothing. Checking the
 * last remaining group collapses back to `null` ("all") so the two states do
 * not drift into separate-but-identical representations.
 *
 * Unchecking the LAST group yields an empty set, not `null`: that is "no
 * subteams selected", which correctly shows only the always-visible events.
 */
export function toggleChannel(
    selected: ChannelSelection,
    id: string,
    allGroups: readonly EventChannelGroup[],
): ChannelSelection {
    const next = new Set(selected === null ? allGroups.map((g) => g.id) : selected);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    // Re-collapse to "all" once every group is checked, so "all checked" and
    // "no filter" do not become two states with different feed URLs.
    if (allGroups.length > 0 && allGroups.every((g) => next.has(g.id))) {
        return null;
    }
    return next;
}
