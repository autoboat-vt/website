import { render, screen } from "@testing-library/react";
import Sponsors from "../../pages/Sponsors";

/**
 * Tests for the Sponsors page. The sponsor list is content, but the parts
 * worth guarding are the external-link treatment (sponsor sites must open in
 * a new tab with the sr-only affordance) and that each entry is actually
 * linked -- a sponsor card with a missing/mistyped `website` silently renders
 * as plain text.
 */

function renderSponsors() {
    return render(<Sponsors />);
}

describe("Sponsors page", () => {
    it("lists every sponsor", () => {
        renderSponsors();

        expect(screen.getByText("Virginia Tech College of Engineering")).toBeInTheDocument();
        expect(screen.getByText("Polymaker")).toBeInTheDocument();
    });

    it("links Polymaker to polymaker.com", () => {
        renderSponsors();

        const link = screen.getByText("Polymaker").closest("a");
        expect(link).toHaveAttribute("href", "https://polymaker.com");
    });

    it("opens sponsor links in a new tab with rel=noopener noreferrer", () => {
        renderSponsors();

        for (const name of ["Virginia Tech College of Engineering", "Polymaker"]) {
            const link = screen.getByText(name).closest("a");
            expect(link).toHaveAttribute("target", "_blank");
            expect(link).toHaveAttribute("rel", "noopener noreferrer");
        }
    });

    it("marks each sponsor link with the sr-only new-tab affordance", () => {
        renderSponsors();

        const link = screen.getByText("Polymaker").closest("a");
        expect(link?.textContent).toMatch(/opens in a new tab/i);
    });

    it("describes what Polymaker contributes", () => {
        renderSponsors();

        expect(screen.getByText(/filament/i)).toBeInTheDocument();
    });

    it("shows the Polymaker logo instead of the fallback icon", () => {
        renderSponsors();

        const logo = screen.getByAltText("Polymaker logo");
        expect(logo).toHaveAttribute("src", "/images/sponsors/polymaker.svg");
    });

    it("lazy-loads sponsor logos", () => {
        renderSponsors();

        expect(screen.getByAltText("Polymaker logo")).toHaveAttribute("loading", "lazy");
    });

    it("falls back to an icon for sponsors without a logo", () => {
        // VT College of Engineering has no logo asset -- its card must still
        // render an icon band rather than an empty box or a broken image.
        const { container } = renderSponsors();

        const vtCard = Array.from(container.querySelectorAll("#current-sponsors .group")).find((c) =>
            c.textContent?.includes("Virginia Tech College of Engineering"),
        );
        expect(vtCard?.querySelector("img")).toBeNull();
        expect(vtCard?.querySelector("svg")).not.toBeNull();
    });
});
