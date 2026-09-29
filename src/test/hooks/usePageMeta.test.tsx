import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { usePageMeta } from "../../hooks/usePageMeta";

function Probe() {
    usePageMeta();
    return null;
}

function renderAt(path: string) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <Probe />
        </MemoryRouter>,
    );
}

function metaContent(selector: string): string | null {
    return document.head.querySelector<HTMLMetaElement>(selector)?.getAttribute("content") ?? null;
}

function canonicalHref(): string | null {
    return document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute("href") ?? null;
}

describe("usePageMeta", () => {
    afterEach(() => {
        // The hook upserts into the real document.head, which jsdom shares
        // across tests in this file. Clear the tags it owns so each test starts
        // from a clean head rather than inheriting the previous route's values.
        for (const el of document.head.querySelectorAll(
            'meta[name="description"], meta[name="robots"], meta[name="twitter:card"], meta[name="twitter:title"], meta[name="twitter:description"], meta[property^="og:"], link[rel="canonical"]',
        )) {
            el.remove();
        }
        document.title = "";
    });

    it("sets the document title for the current route", () => {
        renderAt("/fleet");
        expect(document.title).toBe("Our Fleet | AutoBoat at Virginia Tech");
    });

    it("sets a description matching the route, not the home default", () => {
        renderAt("/fleet");
        expect(metaContent('meta[name="description"]')).toContain("Ducky");
    });

    it("sets a canonical URL in the trailing-slash form S3 serves", () => {
        // /sponsors 302s to /sponsors/, so the canonical must name the latter.
        renderAt("/sponsors");
        expect(canonicalHref()).toBe("https://autoboat.aoe.vt.edu/sponsors/");
    });

    it("keeps the trailing slash on the home canonical", () => {
        renderAt("/");
        expect(canonicalHref()).toBe("https://autoboat.aoe.vt.edu/");
    });

    it("sets og:url to the canonical URL", () => {
        renderAt("/ourteam");
        expect(metaContent('meta[property="og:url"]')).toBe("https://autoboat.aoe.vt.edu/ourteam/");
    });

    it("sets Open Graph and Twitter titles to the route title", () => {
        renderAt("/gallery");
        expect(metaContent('meta[property="og:title"]')).toBe("Gallery | AutoBoat at Virginia Tech");
        expect(metaContent('meta[name="twitter:title"]')).toBe("Gallery | AutoBoat at Virginia Tech");
        expect(metaContent('meta[name="twitter:card"]')).toBe("summary_large_image");
    });

    it("allows indexing on a public route", () => {
        renderAt("/fleet");
        expect(metaContent('meta[name="robots"]')).toBe("index, follow");
    });

    it("blocks indexing on the unlisted officers calendar", () => {
        renderAt("/calendar/officers");
        expect(metaContent('meta[name="robots"]')).toBe("noindex, nofollow");
    });

    it("still sets a title on the noindex route", () => {
        // noindex is not the same as "no metadata" -- the page can still be
        // shared by URL, so the preview tags must be populated.
        renderAt("/calendar/officers");
        expect(document.title).toBe("Officers Calendar | AutoBoat at Virginia Tech");
    });

    it("does not confuse /calendar with /calendar/officers", () => {
        renderAt("/calendar");
        expect(document.title).toBe("Calendar | AutoBoat at Virginia Tech");
        expect(metaContent('meta[name="robots"]')).toBe("index, follow");
    });

    it("applies home metadata to an unknown path", () => {
        renderAt("/not-a-real-page");
        expect(document.title).toBe("AutoBoat at Virginia Tech | Autonomous Robot Boats");
    });

    it("does not stack duplicate tags when navigating between routes", () => {
        // A blind appendChild on each route change would grow head with every
        // navigation; the hook upserts instead.
        const first = renderAt("/fleet");
        first.unmount();
        const second = renderAt("/sponsors");
        second.unmount();
        const third = renderAt("/gallery");
        third.unmount();

        expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
        expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
        expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
        expect(document.head.querySelectorAll('meta[name="twitter:card"]')).toHaveLength(1);
    });

    it("updates the existing tag in place rather than leaving the stale value", () => {
        const first = renderAt("/fleet");
        first.unmount();
        const second = renderAt("/sponsors");
        second.unmount();

        expect(metaContent('meta[name="description"]')).toContain("fund, supply, and mentor");
    });
});
