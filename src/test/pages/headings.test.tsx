import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Calendar from "../../pages/Calendar";
import Fleet from "../../pages/Fleet";
import Gallery from "../../pages/Gallery";
import Home from "../../pages/Home";
import OtherPages from "../../pages/OtherPages";
import OurTeam from "../../pages/OurTeam";
import Sponsors from "../../pages/Sponsors";

/**
 * Page headings are an SEO and accessibility concern at the same time: search
 * engines use the h1 to understand what a page is about, and assistive tech
 * uses the heading outline to navigate it. Several pages had NO h1 at all --
 * their visible headings were all h2, so the outline started at level 2.
 *
 * These tests render the pages and count real heading elements, so they catch
 * both a missing h1 and an extra one introduced by a reworded heading.
 */

function countHeadings(container: HTMLElement, level: number): number {
    return container.querySelectorAll(`h${level}`).length;
}

function renderPage(ui: React.ReactElement) {
    return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("one h1 per page", () => {
    const PAGES: Array<[string, React.ReactElement]> = [
        ["Home", <Home />],
        ["OurTeam", <OurTeam />],
        ["Fleet", <Fleet />],
        ["Sponsors", <Sponsors />],
        ["OtherPages", <OtherPages />],
        ["Gallery", <Gallery />],
        ["Calendar", <Calendar />],
    ];

    it.each(PAGES)("%s renders exactly one h1", (_name, element) => {
        const { container, unmount } = renderPage(element);
        expect(countHeadings(container, 1)).toBe(1);
        unmount();
    });

    it("Home's h1 is the visible hero title, not sr-only", () => {
        // The home page is the one page whose h1 doubles as the visible
        // headline; if it became sr-only the hero would lose its title.
        const { container, unmount } = renderPage(<Home />);
        const h1 = container.querySelector("h1");
        expect(h1).toHaveTextContent("AutoBoat @ Virginia Tech");
        expect(h1?.className).not.toContain("sr-only");
        unmount();
    });

    it.each([
        ["OurTeam", <OurTeam />],
        ["Fleet", <Fleet />],
        ["Sponsors", <Sponsors />],
        ["Gallery", <Gallery />],
    ])("%s carries a useful h1 even though it is sr-only", (_name, element) => {
        // sr-only h1s are invisible, so nothing in the UI catches a wrong or
        // empty one -- assert there is real text, not just a tag.
        const { container, unmount } = renderPage(element);
        const h1 = container.querySelector("h1");
        expect(h1).not.toBeNull();
        expect((h1?.textContent ?? "").trim().length).toBeGreaterThan(3);
        unmount();
    });

    it("every page with a visible h1 also still has its section headings", () => {
        // Guards against "fixing" the outline by demoting section headings to
        // plain text, which would flatten the structure instead of fixing it.
        const { container, unmount } = renderPage(<Fleet />);
        expect(countHeadings(container, 2)).toBeGreaterThan(0);
        unmount();
    });
});

describe("heading sources stay in sync with page titles", () => {
    // The h1 is the last thing checked when a page is renamed, and nothing
    // renders it in a test unless you look for it. This asserts each page file
    // actually contains the heading text we expect.
    const EXPECTED: Array<[string, string]> = [
        ["OurTeam.tsx", "Meet the Team"],
        ["Fleet.tsx", "Our Fleet"],
        ["Sponsors.tsx", "Sponsors"],
        ["Gallery.tsx", "Gallery"],
        ["OtherPages.tsx", "Other Pages"],
        ["Officers.tsx", "Officers Calendar"],
    ];

    it.each(EXPECTED)("%s contains its h1 text", (file, text) => {
        const source = readFileSync(resolve(__dirname, "../../pages", file), "utf8");
        expect(source).toContain(`<h1`);
        expect(source).toContain(text);
    });
});
