import { render, screen, within } from "@testing-library/react";
import Fleet from "../../pages/Fleet";

/**
 * Tests for the Fleet page. Focused on the vessel roster and the status
 * treatment -- the page has no other logic worth locking down, and the
 * status styling was previously a two-way ternary that silently rendered
 * "Retired" the same as "In Development".
 */

function renderFleet() {
    return render(<Fleet />);
}

/** The <h2> block for a vessel, which owns the name + status pill. */
function headingFor(name: string): HTMLElement {
    return screen.getByRole("heading", { name: new RegExp(name, "i") });
}

/** Vessel section ids in the order they appear on the page. */
function rosterOrder(container: HTMLElement): string[] {
    // Each vessel's title block carries id={vessel.name.toLowerCase()}.
    return Array.from(container.querySelectorAll(".fleet-section-title")).map((el) => el.id);
}

describe("Fleet page", () => {
    it("lists every vessel", () => {
        renderFleet();

        for (const name of ["Ducky", "Theseus", "Lumpy"]) {
            expect(headingFor(name)).toBeInTheDocument();
        }
    });

    it("puts Ducky first", () => {
        const { container } = renderFleet();

        expect(rosterOrder(container)[0]).toBe("ducky");
    });

    it("keeps the retired vessel last", () => {
        const { container } = renderFleet();

        const order = rosterOrder(container);
        expect(order[order.length - 1]).toBe("lumpy");
    });

    it("calls the jet ski Ducky, not JetSki", () => {
        // The vessel was renamed; the hull is still a JetSki, but the boat is Ducky.
        renderFleet();

        expect(headingFor("Ducky")).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: /^JetSki/i })).not.toBeInTheDocument();
    });

    it("eagerly loads the first card so it can be the LCP element", () => {
        const { container } = renderFleet();

        const firstImg = container.querySelector("#ducky")?.parentElement?.querySelector("img");
        expect(firstImg).toHaveAttribute("loading", "eager");
        expect(firstImg?.getAttribute("fetchpriority")).toBe("high");
    });

    it("lazy-loads the remaining cards", () => {
        const { container } = renderFleet();

        for (const id of ["theseus", "lumpy"]) {
            const img = container.querySelector(`#${id}`)?.parentElement?.querySelector("img");
            expect(img).toHaveAttribute("loading", "lazy");
        }
    });

    it("marks Lumpy as Retired", () => {
        renderFleet();

        expect(within(headingFor("Lumpy")).getByText("Retired")).toBeInTheDocument();
    });

    it("marks Ducky as Active", () => {
        renderFleet();

        expect(within(headingFor("Ducky")).getByText("Active")).toBeInTheDocument();
    });

    it("does not pulse the retired vessel's status dot", () => {
        // The pulse reads as "live right now", which is wrong for a retired boat.
        const { container } = renderFleet();

        expect(container.querySelector("#lumpy")).toBeTruthy();
        expect(container.querySelector("#lumpy .fleet-status-dot")).toBeNull();
    });

    it("still pulses the active vessels' status dots", () => {
        const { container } = renderFleet();

        expect(container.querySelector("#ducky .fleet-status-dot")).not.toBeNull();
        expect(container.querySelector("#theseus .fleet-status-dot")).not.toBeNull();
    });

    it("gives the retired status a distinct color from in-development amber", () => {
        // Guard against the old binary ternary, which styled everything
        // non-Active as amber.
        renderFleet();

        const retiredLabel = within(headingFor("Lumpy")).getByText("Retired");
        expect(retiredLabel.className).not.toMatch(/amber/);
        expect(retiredLabel.className).toMatch(/black\/60|white\/60/);
    });

    it("describes Lumpy in the past tense now that it is retired", () => {
        renderFleet();

        expect(screen.getByText(/Lumpy has since been retired/i)).toBeInTheDocument();
        expect(screen.queryByText(/Lumpy is our current/i)).not.toBeInTheDocument();
    });
});
