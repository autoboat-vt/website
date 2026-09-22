import { render, screen } from "@testing-library/react";
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
});
