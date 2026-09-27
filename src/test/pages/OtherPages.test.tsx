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
});
