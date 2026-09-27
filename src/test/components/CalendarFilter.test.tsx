import { fireEvent, render, screen, within } from "@testing-library/react";
import CalendarFilter from "../../components/CalendarFilter";
import type { ChannelSelection, EventChannelGroup } from "../../lib/eventChannels";

/**
 * Tests for the calendar subteam-filter dropdown.
 *
 * The selection MODEL is the important part, and several of these tests exist
 * to pin it: `null` means "all subteams" and is distinct from an empty set
 * ("no subteams"). Collapsing the two would make a lone subteam impossible to
 * uncheck.
 */

const GROUPS: EventChannelGroup[] = [
    { id: "software", label: "Software", slug: "software" },
    { id: "mechanical", label: "Mechanical", slug: "mechanical" },
    { id: "navarch", label: "NavArch", slug: "navarch" },
];

function renderFilter(selected: ChannelSelection = null, onChange = jest.fn()) {
    render(<CalendarFilter groups={GROUPS} selected={selected} onChange={onChange} />);
    return { onChange };
}

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));

describe("CalendarFilter", () => {
    it("keeps the panel closed until the toggle is clicked", () => {
        // Anchored on the panel's own heading, not on the intro sentence -- the
        // copy is free to change, the heading is the panel's identity.
        renderFilter();
        expect(screen.queryByRole("heading", { name: "Subteams" })).not.toBeInTheDocument();
        openPanel();
        expect(screen.getByRole("heading", { name: "Subteams" })).toBeInTheDocument();
    });

    it("explains that non-subteam events are always shown", () => {
        // The scope rule has to be visible in the UI, or a user will assume
        // unchecking everything hides everything. Asserting the individual
        // phrases (not one long string) keeps this from breaking every time the
        // sentence is reworded.
        renderFilter();
        openPanel();
        const intro = document.querySelector(".calendar-filter__intro");
        expect(intro?.textContent).toMatch(/subteam/i);
        expect(intro?.textContent).toMatch(/always shown/i);
    });

    it("lists every group by name and no event counts", () => {
        // A per-group count could not be made both accurate and meaningful (a
        // recurring event is one record but many calendar entries), so there is
        // deliberately no number next to a group. The only spans are the color
        // swatch and the label.
        renderFilter();
        openPanel();
        for (const group of GROUPS) {
            const option = screen.getByText(group.label).closest("label");
            expect(option).not.toBeNull();
            expect((option as HTMLElement).querySelectorAll("span")).toHaveLength(2);
        }
    });

    it("shows a swatch carrying each group's own subteam slug", () => {
        // The swatch is what teaches the grid's chip colors, so it must use the
        // same `subteam--<slug>` class the chips do -- a swatch with its own
        // color logic would be free to disagree with the grid.
        renderFilter();
        openPanel();
        for (const group of GROUPS) {
            const option = screen.getByText(group.label).closest("label");
            const swatch = (option as HTMLElement).querySelector(".calendar-filter__swatch");
            expect(swatch).not.toBeNull();
            expect(swatch?.classList.contains(`subteam--${group.slug}`)).toBe(true);
        }
    });

    it("hides the swatch from assistive tech", () => {
        // It only repeats the label beside it, so announcing it would just add
        // noise to the checkbox's name.
        renderFilter();
        openPanel();
        const swatches = document.querySelectorAll(".calendar-filter__swatch");
        expect(swatches).toHaveLength(GROUPS.length);
        for (const swatch of swatches) {
            expect(swatch).toHaveAttribute("aria-hidden", "true");
        }
    });

    it("shows every checkbox checked in the default 'all' state", () => {
        // Empty selection means everything, so the boxes must render checked --
        // otherwise the UI would claim nothing is shown while showing all.
        renderFilter();
        openPanel();
        for (const box of screen.getAllByRole("checkbox")) {
            expect(box).toBeChecked();
        }
    });

    it("emits the complement when one group is unchecked from the default state", () => {
        const { onChange } = renderFilter(null);
        openPanel();
        fireEvent.click(within(screen.getByText("Software").closest("label") as HTMLElement).getByRole("checkbox"));

        // "Everything minus Software" -- the click must not be a no-op.
        expect(onChange).toHaveBeenCalledTimes(1);
        expect([...(onChange.mock.calls[0][0] as Set<string>)].sort()).toEqual(["mechanical", "navarch"]);
    });

    it("only checks the selected groups in a partial selection", () => {
        renderFilter(new Set(["software"]));
        openPanel();
        const sw = within(screen.getByText("Software").closest("label") as HTMLElement).getByRole("checkbox");
        const mech = within(screen.getByText("Mechanical").closest("label") as HTMLElement).getByRole("checkbox");
        expect(sw).toBeChecked();
        expect(mech).not.toBeChecked();
    });

    it("has no All subteams reset control", () => {
        // Deliberately removed: the reset was a second, redundant way to express
        // "all" that competed with the checkboxes. Re-checking every group still
        // collapses back to the `null` "all" state (see `toggleChannel`), so the
        // state is reachable without a dedicated button.
        renderFilter(new Set(["software"]));
        openPanel();
        expect(screen.queryByRole("button", { name: /All subteams/i })).not.toBeInTheDocument();
    });

    it("reaches the 'all' state by checking the last remaining group", () => {
        // The path that replaced the reset button, so it is worth pinning.
        // Starting from all-but-one is what makes this observable with a static
        // `selected` prop: each click recomputes from the ORIGINAL prop, so two
        // clicks in a row cannot accumulate -- the final click has to complete
        // the set on its own.
        const { onChange } = renderFilter(new Set(["software", "mechanical"]));
        openPanel();
        fireEvent.click(within(screen.getByText("NavArch").closest("label") as HTMLElement).getByRole("checkbox"));

        expect(onChange).toHaveBeenCalledWith(null);
    });

    it("emits the union when a group is added to a partial selection", () => {
        const { onChange } = renderFilter(new Set(["software"]));
        openPanel();
        fireEvent.click(within(screen.getByText("Mechanical").closest("label") as HTMLElement).getByRole("checkbox"));

        expect([...(onChange.mock.calls[0][0] as Set<string>)].sort()).toEqual(["mechanical", "software"]);
    });

    it("has no count badge on the toggle in any state", () => {
        // The toggle used to show how many subteams were selected. Removed with
        // the per-group counts -- see the note in CalendarFilter.tsx.
        renderFilter(new Set(["software", "navarch"]));
        expect(screen.getByRole("button", { name: /^Filter$/ })).toBeInTheDocument();
        expect(screen.queryByText(/subteams selected/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/^2$/)).not.toBeInTheDocument();

        renderFilter(null);
        expect(screen.queryByText(/subteams selected/i)).not.toBeInTheDocument();
    });

    it("disables the toggle while there are no events to group", () => {
        render(<CalendarFilter groups={[]} selected={null} onChange={jest.fn()} />);
        expect(screen.getByRole("button", { name: /^Filter/ })).toBeDisabled();
    });

    it("closes the panel when the other header dropdown opens", () => {
        // Both panels anchor to the same rectangle in the header, so they must
        // never be open together.
        renderFilter();
        openPanel();
        expect(screen.getByRole("heading", { name: "Subteams" })).toBeInTheDocument();

        fireEvent(document, new CustomEvent("autoboat:calendar-dropdown-open", { detail: "calendar-subscribe" }));
        expect(screen.queryByRole("heading", { name: "Subteams" })).not.toBeInTheDocument();
    });

    it("stays open when its own announcement fires", () => {
        renderFilter();
        openPanel();
        fireEvent(document, new CustomEvent("autoboat:calendar-dropdown-open", { detail: "calendar-filter" }));
        expect(screen.getByRole("heading", { name: "Subteams" })).toBeInTheDocument();
    });
});
