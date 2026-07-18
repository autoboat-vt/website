import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Footer from "../../components/Footer";

describe("Footer", () => {
    it("renders all expected links", () => {
        render(
            <MemoryRouter>
                <Footer />
            </MemoryRouter>,
        );

        // Social icon links expose their label via aria-label (visible text is
        // sr-only "Label (opens in a new tab)"), so query by accessible name.
        const socials = ["Email", "Discord", "Instagram", "GitHub", "LinkedIn"];
        for (const label of socials) {
            expect(screen.getByRole("link", { name: new RegExp(`^${label}$`, "i") })).toBeInTheDocument();
        }
        // Donate CTA
        expect(screen.getByRole("link", { name: /support autoboat/i })).toBeInTheDocument();
    });

    it("marks external links with target=_blank and rel=noopener noreferrer", () => {
        render(
            <MemoryRouter>
                <Footer />
            </MemoryRouter>,
        );

        const discord = screen.getByRole("link", { name: /^discord$/i });
        expect(discord).toHaveAttribute("target", "_blank");
        expect(discord).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("does not open internal mailto links in a new tab", () => {
        render(
            <MemoryRouter>
                <Footer />
            </MemoryRouter>,
        );

        const email = screen.getByRole("link", { name: /^email$/i });
        expect(email).toHaveAttribute("href", "mailto:autoboat@vt.edu");
        expect(email).not.toHaveAttribute("target", "_blank");
    });

    it("renders the team tagline", () => {
        render(
            <MemoryRouter>
                <Footer />
            </MemoryRouter>,
        );

        expect(screen.getByText(/AutoBoat @ Virginia Tech/i)).toBeInTheDocument();
    });
});
