import { render, screen } from "@testing-library/react";
import Footer from "../../components/Footer";

describe("Footer", () => {
    it("renders all expected links", () => {
        render(<Footer />);

        const expected = ["Email", "Donate", "Discord", "Instagram", "GitHub", "LinkedIn"];
        for (const label of expected) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
    });

    it("marks external links with target=_blank and rel=noopener noreferrer", () => {
        render(<Footer />);

        const discord = screen.getByText("Discord").closest("a");
        expect(discord).toHaveAttribute("target", "_blank");
        expect(discord).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("does not open internal mailto links in a new tab", () => {
        render(<Footer />);

        const email = screen.getByText("Email").closest("a");
        expect(email).toHaveAttribute("href", "mailto:autoboat@vt.edu");
        expect(email).not.toHaveAttribute("target", "_blank");
    });

    it("renders the team tagline", () => {
        render(<Footer />);

        expect(screen.getByText(/AutoBoat @ Virginia Tech/i)).toBeInTheDocument();
    });
});
