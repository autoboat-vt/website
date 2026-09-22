import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Index from "../../pages/Index";

/**
 * Tests for the Index hub page. It's the only in-nav entry point to the
 * feature pages that don't get their own nav slot, so each card's href is
 * load-bearing -- a typo here makes a page unreachable except by URL.
 */

function renderIndex() {
    return render(
        <MemoryRouter>
            <Index />
        </MemoryRouter>,
    );
}

describe("Index page", () => {
    it("links to the Live Map", () => {
        renderIndex();

        expect(screen.getByText("Live Map").closest("a")).toHaveAttribute("href", "/live");
    });

    it("links to the Calendar", () => {
        renderIndex();

        expect(screen.getByText("Calendar").closest("a")).toHaveAttribute("href", "/calendar");
    });

    it("links to the Gallery", () => {
        renderIndex();

        expect(screen.getByText("Gallery").closest("a")).toHaveAttribute("href", "/gallery");
    });
});
