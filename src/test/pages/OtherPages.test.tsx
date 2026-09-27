import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OtherPages from "../../pages/OtherPages";

/**
 * Tests for the Other Pages page. It's the only in-nav entry point to the
 * feature pages that don't get their own nav slot, so each card's href is
 * load-bearing -- a typo here makes a page unreachable except by URL.
 */

function renderOtherPages() {
    return render(
        <MemoryRouter>
            <OtherPages />
        </MemoryRouter>,
    );
}

describe("Other Pages page", () => {
    it("links to the Live Map", () => {
        renderOtherPages();

        expect(screen.getByText("Live Map").closest("a")).toHaveAttribute("href", "/live");
    });

    it("links to the Calendar", () => {
        renderOtherPages();

        expect(screen.getByText("Calendar").closest("a")).toHaveAttribute("href", "/calendar");
    });

    it("links to the Gallery", () => {
        renderOtherPages();

        expect(screen.getByText("Gallery").closest("a")).toHaveAttribute("href", "/gallery");
    });

    it("links to the external documentation site", () => {
        renderOtherPages();

        expect(screen.getByText("Documentation").closest("a")).toHaveAttribute(
            "href",
            "https://autoboat-vt.github.io/documentation",
        );
    });

    it("opens the documentation site in a new tab with the rel guard", () => {
        // Unlike the other cards this one leaves the site, so it needs the
        // new-tab affordance and `noopener` (tabnabbing).
        renderOtherPages();

        const card = screen.getByText("Documentation").closest("a") as HTMLElement;
        expect(card).toHaveAttribute("target", "_blank");
        expect(card.getAttribute("rel")).toContain("noopener");
        expect(card.getAttribute("rel")).toContain("noreferrer");
        expect(within(card).getByText(/opens in a new tab/i)).toBeInTheDocument();
    });

    it("keeps in-app cards as internal links with no new-tab treatment", () => {
        // Guards the conditional in the render map: an entry WITHOUT `external`
        // must not pick up target/rel, or every feature page would open a blank
        // tab.
        renderOtherPages();

        for (const title of ["Live Map", "Calendar", "Gallery"]) {
            const card = screen.getByText(title).closest("a") as HTMLElement;
            expect(card).not.toHaveAttribute("target");
            expect(card).not.toHaveAttribute("rel");
        }
    });

    it("keeps the original frosted card background", () => {
        // The color lives on the affordance, not the tile -- the card keeps the
        // translucent `bg-card` panel. Guards against the tile being filled with
        // maroon again, which would swallow the description text (it is styled
        // for the light panel, and reads ~1.1:1 on maroon).
        renderOtherPages();

        for (const title of ["Live Map", "Calendar", "Gallery", "Documentation"]) {
            const card = screen.getByText(title).closest("a") as HTMLElement;
            expect(card.className).toContain("bg-card");
            expect(card.className).toContain("border-cardborder");
            expect(card.className).not.toContain("bg-accent");
        }
    });

    it("styles the Open/Visit affordance as a maroon button with white text", () => {
        // The affordance reads as a button but must stay a non-interactive span:
        // the whole card is already the <a>, and an <a> inside an <a> is invalid
        // HTML (react-dom warns about it).
        renderOtherPages();

        for (const title of ["Live Map", "Calendar", "Gallery", "Documentation"]) {
            const card = screen.getByText(title).closest("a") as HTMLElement;
            const cta = within(card).getByText(/^(Open|Visit) /);
            expect(cta.tagName).toBe("SPAN");
            expect(cta.className).toContain("bg-accent");
            expect(cta.className).toContain("text-white");
            // WARNING: these two overrides are required. The shared `.btn:hover`
            // rule turns the fill near-black, and the global `a:hover` turns the
            // text near-black too -- either one alone breaks the pairing.
            expect(cta.className).toContain("hover:text-white");
            // The hover fill is burnt orange (`hover:bg-accent-2`) -- chosen by
            // the maintainer, who was shown that white-on-burnt-orange is only
            // 3.05:1 (below the 4.5:1 AA floor for text this size). Do not
            // "correct" this to a maroon shade without checking with them; a
            // shaded maroon was tried and reads as no change at all.
            expect(cta.className).toContain("hover:bg-accent-2");
            expect(cta.className).toContain("hover:text-white");
        }
    });

    it("carries no nested interactive elements inside the card link", () => {
        // An <a> or <button> inside the card's <a> would be invalid HTML and
        // would break keyboard navigation (two tab stops for one destination).
        // The CTA is a <span> for exactly this reason.
        renderOtherPages();

        for (const title of ["Live Map", "Calendar", "Gallery", "Documentation"]) {
            const card = screen.getByText(title).closest("a") as HTMLElement;
            expect(card.querySelectorAll("a, button, input")).toHaveLength(0);
        }
    });

    it("does not move the card or its CTA on hover", () => {
        // The hover-lift transform was removed site-wide for controls. A lift on
        // the card is especially bad here: the cards sit in a grid, so one
        // lifting makes the whole row look like it shifted.
        renderOtherPages();

        for (const title of ["Live Map", "Calendar", "Gallery", "Documentation"]) {
            const card = screen.getByText(title).closest("a") as HTMLElement;
            expect(card.className).not.toMatch(/translate/);
            expect(card.className).not.toContain("transition-transform");
            // The arrow used to nudge sideways on card hover.
            expect(within(card).getByText(/^(Open|Visit) /).parentElement?.innerHTML).not.toContain(
                "group-hover:translate",
            );
        }
    });
});
