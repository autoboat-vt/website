import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { useCallback, useId, useState } from "react";
import type { ChannelSelection, EventChannelGroup } from "../lib/eventChannels";
import { isAllSelected, toggleChannel } from "../lib/eventChannels";
import { announceDropdownOpen, useCloseOnOtherDropdownOpen } from "./calendarDropdown";

/**
 * Channel filter for the calendar page.
 *
 * The team schedules each subteam's events in its own Discord voice channel, and
 * the Worker ships that channel id on every event, so the calendar can be
 * narrowed to one or more groups without any extra API surface. This control is
 * the picker; the actual filtering is a one-line predicate in `Calendar.tsx`
 * (`matchesChannelFilter`).
 *
 * Selection semantics (mirrored by `toggleChannel` in `eventChannels.ts`):
 *
 *  - An EMPTY selection means "show everything". That is the initial state and
 *    what "All events" resets to, so there is exactly one representation of
 *    "no filter" and the generated feed URL stays identical to the unfiltered
 *    feed.
 *  - Otherwise the selection is an allow-list of channel keys. Checking every
 *    group collapses back to the empty set so the two do not drift apart.
 *  - Unchecking is always available, including from the initial state, because
 *    toggling materializes the full set before subtracting (see `toggleChannel`).
 *
 * The panel is a dropdown anchored to `.calendar-header`, matching the
 * Subscribe panel's geometry. The two share a mutual-exclusion event so they
 * can never be open at the same time and overlap.
 */

/**
 * Subteam filter for the calendar page.
 *
 * The team schedules each subteam's events in its own Discord voice channel, and
 * the Worker ships that channel id on every event, so the calendar can be
 * narrowed to one or more subteams without any extra API surface. This control
 * is the picker; the actual filtering is a one-line predicate in `Calendar.tsx`
 * (`matchesChannelFilter`).
 *
 * SCOPE: general member and officer events are deliberately excluded -- they are
 * always shown. See `ALWAYS_VISIBLE_CHANNEL_IDS` in eventChannels.ts. The copy
 * below states that, because a user who unchecks everything would otherwise
 * assume the calendar is about to go blank.
 *
 * Each row carries a color swatch matching the hue the grid uses for that
 * subteam's chips and day dots, so the mapping can be learned from the panel
 * instead of inferred by comparing the grid against the checkbox list. The hue
 * comes from `group.slug` -> the shared `subteam--<slug>` class in app.css.
 *
 * Selection model (mirrored by `toggleChannel` in eventChannels.ts):
 *
 *  - `null` means "all subteams", is the initial state, and is what "All
 *    subteams" resets to.
 *  - A set is an allow-list of subteam keys. An empty set is "no subteams",
 *    which is distinct from `null` -- collapsing the two would make a lone
 *    subteam impossible to uncheck.
 *  - Unchecking is always available from the initial state, because toggling
 *    materializes the full set before subtracting.
 *
 * The panel is a dropdown anchored to `.calendar-header`, matching the
 * Subscribe panel's geometry. The two share a mutual-exclusion event so they
 * can never be open at the same time and overlap.
 */

export interface CalendarFilterProps {
    /** Selectable groups, derived from the loaded events. */
    groups: EventChannelGroup[];
    /** Selected subteam keys. `null` means every subteam. */
    selected: ChannelSelection;
    /** Called with the next selection. */
    onChange: (next: ChannelSelection) => void;
}

export default function CalendarFilter({ groups, selected, onChange }: CalendarFilterProps) {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    const close = useCallback(() => setOpen(false), []);
    useCloseOnOtherDropdownOpen("calendar-filter", close);

    const allSelected = isAllSelected(selected);
    const toggle = () => {
        setOpen((wasOpen) => {
            if (!wasOpen) announceDropdownOpen("calendar-filter");
            return !wasOpen;
        });
    };

    // No events yet (still loading, or the feed is empty): there is nothing to
    // choose between, and an enabled toggle opening an empty panel reads as a
    // bug. The control stays visible so the header does not shift when the
    // events arrive.
    const hasGroups = groups.length > 0;
    const panelVisible = open && hasGroups;

    /** Effective checked state: "all" means every group is on. */
    const isChecked = (id: string) => allSelected || (selected?.has(id) ?? false);

    return (
        <div className={`calendar-filter${panelVisible ? " calendar-filter--open" : ""}`}>
            <button
                type="button"
                className="btn btn--sm calendar-filter__toggle"
                aria-expanded={panelVisible}
                aria-controls={panelId}
                disabled={!hasGroups}
                onClick={toggle}
            >
                <SlidersHorizontal size={16} aria-hidden="true" />
                Filter
                {/* No count badge here either -- see the note above. The
                    accessible name stays just "Filter" in every state. */}
                <ChevronDown size={15} className="calendar-filter__chevron" aria-hidden="true" />
            </button>

            {panelVisible && (
                <div className="calendar-filter__panel" id={panelId}>
                    <div className="calendar-filter__header">
                        <h3 className="calendar-filter__title">Subteams</h3>
                        <p className="calendar-filter__intro">
                            Select the subteams whose events you like to see. Events not specific to a particular
                            subteam are always shown.
                        </p>
                    </div>

                    <button
                        type="button"
                        className="calendar-filter__all"
                        aria-pressed={allSelected}
                        onClick={() => onChange(null)}
                    >
                        <span className="calendar-filter__all-label">All subteams</span>
                        {allSelected && <Check size={15} aria-hidden="true" />}
                    </button>

                    <ul className="calendar-filter__list">
                        {groups.map((group) => (
                            <li key={group.id}>
                                <label className="calendar-filter__option">
                                    <input
                                        type="checkbox"
                                        checked={isChecked(group.id)}
                                        onChange={() => onChange(toggleChannel(selected, group.id, groups))}
                                    />
                                    {/* Swatch teaches the chip colors the grid
                                        uses. aria-hidden because it only repeats
                                        the label next to it. */}
                                    <span
                                        className={`calendar-filter__swatch subteam--${group.slug}`}
                                        aria-hidden="true"
                                    />
                                    <span className="calendar-filter__label">{group.label}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
