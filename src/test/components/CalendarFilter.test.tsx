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
    { id: "software", label: "Software", count: 4 },
    { id: "mechanical", label: "Mechanical", count: 2 },
    { id: "navarch", label: "Naval Architecture & Propulsion", count: 1 },
];

function renderFilter(selected: ChannelSelection = null, onChange = jest.fn()) {
    render(<CalendarFilter groups={GROUPS} selected={selected} onChange={onChange} />);
    return { onChange };
}

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));

describe("CalendarFilter", () => {
    it("keeps the panel closed until the toggle is clicked", () => {
        renderFilter();
        expect(screen.queryByText(/Narrow the calendar to specific subteams/i)).not.toBeInTheDocument();
        openPanel();
        expect(screen.getByText(/Narrow the calendar to specific subteams/i)).toBeInTheDocument();
    });

    it("says general member and officer events are always shown", () => {
        // The scope rule has to be visible in the UI, or a user will assume
        // unchecking everything hides everything.
        renderFilter();
        openPanel();
        expect(screen.getByText(/General member and officer events are always shown/i)).toBeInTheDocument();
    });

    it("lists every group with its event count", () => {
        renderFilter();
        openPanel();
        for (const group of GROUPS) {
            const option = screen.getByText(group.label).closest("label");
            expect(option).not.toBeNull();
            expect(within(option as HTMLElement).getByText(String(group.count))).toBeInTheDocument();
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

    it("marks All subteams as pressed by default", () => {
        renderFilter();
        openPanel();
        expect(screen.getByRole("button", { name: /All subteams/i })).toHaveAttribute("aria-pressed", "true");
    });

    it("emits the complement when one group is unchecked from the default state", () => {
        const { onChange } = renderFilter(null);
        openPanel();
        fireEvent.click(within(screen.getByText("Software").closest("label") as HTMLElement).getByRole("checkbox"));

        // "Everything minus Software" -- the click must not be a no-op.
        expect(onChange).toHaveBeenCalledTimes(1);
        expect([...(onChange.mock.calls[0][0] as Set<string>)].sort()).toEqual(["mechanical", "navarch"]);
    });

    it("emits null when All subteams is chosen", () => {
        const { onChange } = renderFilter(new Set(["software"]));
        openPanel();
        fireEvent.click(screen.getByRole("button", { name: /All subteams/i }));

        expect(onChange).toHaveBeenCalledWith(null);
    });

    it("only checks the selected groups in a partial selection", () => {
        renderFilter(new Set(["software"]));
        openPanel();
        const sw = within(screen.getByText("Software").closest("label") as HTMLElement).getByRole("checkbox");
        const mech = within(screen.getByText("Mechanical").closest("label") as HTMLElement).getByRole("checkbox");
        expect(sw).toBeChecked();
        expect(mech).not.toBeChecked();
        expect(screen.getByRole("button", { name: /All subteams/i })).toHaveAttribute("aria-pressed", "false");
    });

    it("shows a count badge on the toggle only when a filter is active", () => {
        renderFilter(new Set(["software", "navarch"]));
        // The badge is decorative; the accessible name carries the count.
        expect(screen.getByRole("button", { name: /2 subteams selected/i })).toBeInTheDocument();
    });

    it("has no count badge when every subteam is selected", () => {
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
        expect(screen.getByText(/Narrow the calendar to specific subteams/i)).toBeInTheDocument();

        fireEvent(document, new CustomEvent("autoboat:calendar-dropdown-open", { detail: "calendar-subscribe" }));
        expect(screen.queryByText(/Narrow the calendar to specific subteams/i)).not.toBeInTheDocument();
    });

    it("stays open when its own announcement fires", () => {
        renderFilter();
        openPanel();
        fireEvent(document, new CustomEvent("autoboat:calendar-dropdown-open", { detail: "calendar-filter" }));
        expect(screen.getByText(/Narrow the calendar to specific subteams/i)).toBeInTheDocument();
    });
});
