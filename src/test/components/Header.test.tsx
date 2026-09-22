import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Header from "../../components/Header";

/**
 * Tests for the top nav. The five primary links plus the Other Pages hub entry
 * -- the feature pages (/live, /calendar, /gallery) deliberately live off-nav
 * and are only reachable by URL or through /other-pages.
 */

function renderHeader() {
    return render(
        <MemoryRouter>
            <Header />
        </MemoryRouter>,
    );
}

describe("Header", () => {
    it("renders the primary nav links in order", () => {
        renderHeader();

        const labels = Array.from(document.querySelectorAll(".nav__links .nav__link")).map((el) => el.textContent);
        expect(labels).toEqual(["About", "Meet the Team", "Our Fleet", "Sponsors", "Other Pages"]);
    });

    it("points the Other Pages link at /other-pages", () => {
        renderHeader();

        expect(screen.getByText("Other Pages").closest("a")).toHaveAttribute("href", "/other-pages");
    });

    it("keeps the feature pages out of the nav", () => {
        renderHeader();

        for (const label of ["Calendar", "Live Map", "Gallery"]) {
            expect(screen.queryByText(label)).not.toBeInTheDocument();
        }
    });
});
