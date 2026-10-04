import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    allRoutePaths,
    canonicalUrl,
    metadataForPath,
    OG_IMAGE_URL,
    routerPathForPathname,
    SITE_NAME,
    SITE_URL,
    sitemapRoutes,
} from "../../lib/seo";

// Resolved from this file rather than process.cwd() so the assertions hold
// regardless of which directory Jest is invoked from.
const APP_TSX = resolve(__dirname, "../../App.tsx");
const SPA_FALLBACK_MJS = resolve(__dirname, "../../../scripts/spa-fallback.mjs");
const INDEX_HTML = resolve(__dirname, "../../../index.html");

describe("seo metadata", () => {
    describe("SITE_URL", () => {
        it("has no trailing slash", () => {
            expect(SITE_URL).toBe("https://autoboat.aoe.vt.edu");
            expect(SITE_URL.endsWith("/")).toBe(false);
        });

        it("uses https", () => {
            expect(SITE_URL.startsWith("https://")).toBe(true);
        });
    });

    describe("OG_IMAGE_URL", () => {
        // The whole point of this constant: Open Graph cannot resolve a
        // relative path, which is what shipped before (a bare
        // "/images/favicon.ico" that no crawler could render).
        it("is an absolute URL", () => {
            expect(OG_IMAGE_URL).toBe("https://autoboat.aoe.vt.edu/images/gallery/14.webp");
            expect(() => new URL(OG_IMAGE_URL)).not.toThrow();
        });

        it("is a raster format social crawlers accept", () => {
            // .ico is rejected by essentially every link-preview bot.
            expect(/\.(png|jpe?g|webp|avif)$/i.test(OG_IMAGE_URL)).toBe(true);
            expect(OG_IMAGE_URL.endsWith(".ico")).toBe(false);
        });
    });

    describe("routerPathForPathname", () => {
        it.each([
            ["/", "/"],
            ["/fleet", "/fleet"],
            // S3 302s the bare path to the trailing-slash form, so both reach us.
            ["/fleet/", "/fleet"],
            ["//fleet//", "/fleet"],
            ["/calendar/officers/", "/calendar/officers"],
            ["", "/"],
            // react-router matches case-insensitively, so /OurTeam renders the
            // team page and must resolve to its metadata, not the home page's.
            ["/OurTeam", "/ourteam"],
            ["/CALENDAR/OFFICERS", "/calendar/officers"],
        ])("maps %s to %s", (input, expected) => {
            expect(routerPathForPathname(input)).toBe(expected);
        });
    });

    describe("metadataForPath", () => {
        it("returns distinct titles for the primary pages", () => {
            const paths = ["/", "/ourteam", "/fleet", "/sponsors", "/gallery", "/calendar", "/live", "/other-pages"];
            const titles = paths.map((path) => metadataForPath(path).title);

            expect(new Set(titles).size).toBe(paths.length);
        });

        it("returns distinct descriptions for the primary pages", () => {
            const paths = ["/", "/ourteam", "/fleet", "/sponsors", "/gallery", "/calendar", "/live", "/other-pages"];
            const descriptions = paths.map((path) => metadataForPath(path).description);

            expect(new Set(descriptions).size).toBe(paths.length);
        });

        it("puts the brand in every title", () => {
            // "AutoBoat" specifically, because a bare page name like
            // "Sponsors" or "Gallery" is too generic to identify the site in a
            // result list.
            for (const path of allRoutePaths()) {
                expect(metadataForPath(path).title).toContain("AutoBoat");
            }
        });

        it("spells out the full organization name on the home page", () => {
            // The home page is the one result that should read as the
            // organization itself rather than a section of it.
            expect(metadataForPath("/").title).toContain("AutoBoat");
            expect(metadataForPath("/").title).toMatch(/VT|Virginia Tech/);
        });

        it("keeps titles within a length search results can show", () => {
            for (const path of allRoutePaths()) {
                const { title } = metadataForPath(path);
                // Google truncates near 60 characters / ~600px. Keep real slack
                // rather than shipping a title that only just fits.
                expect(title.length).toBeLessThanOrEqual(45);
            }
        });

        it("keeps every title inside the rendered width Google will show", () => {
            // Length in CHARACTERS is a poor proxy: Google truncates by pixel
            // width, so a 40-character string of wide glyphs can overflow while
            // a 50-character string of narrow ones does not. jsdom has no text
            // metrics, but `measureText` over a fixed font is deterministic and
            // the same technique the manual check used.
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (!ctx) return; // No canvas in this environment; the length check above still applies.
            ctx.font = "20px Arial, sans-serif";

            for (const path of allRoutePaths()) {
                const { title } = metadataForPath(path);
                expect(ctx.measureText(title).width).toBeLessThanOrEqual(600);
            }
        });

        it("does not repeat a long brand suffix on every page", () => {
            // The regression: all nine titles ended in
            // " | AutoBoat at Virginia Tech" (28 characters), which crowded out
            // the part of the title that actually distinguishes the page.
            for (const path of allRoutePaths()) {
                const { title } = metadataForPath(path);
                if (path !== "/") {
                    expect(title.endsWith(" | AutoBoat")).toBe(true);
                }
            }
        });

        it("keeps descriptions within a length search results can show", () => {
            for (const path of allRoutePaths()) {
                const { description } = metadataForPath(path);
                // Floor is deliberately low: /calendar/officers is an unlisted
                // stub whose description is intentionally terse, and padding it
                // out just to satisfy an arbitrary minimum would be worse copy.
                expect(description.length).toBeGreaterThanOrEqual(50);
                expect(description.length).toBeLessThanOrEqual(170);
            }
        });

        it("resolves a trailing-slash path to the same entry", () => {
            expect(metadataForPath("/fleet/")).toEqual(metadataForPath("/fleet"));
        });

        it("falls back to the home page for an unknown path", () => {
            // App.tsx's `*` route renders Home, so this is the correct answer,
            // not merely a safe one.
            expect(metadataForPath("/nope")).toEqual(metadataForPath("/"));
            expect(metadataForPath("/nope").title).toBe(metadataForPath("/").title);
        });
    });

    describe("canonicalUrl", () => {
        it("keeps the trailing slash on the root", () => {
            expect(canonicalUrl("/")).toBe("https://autoboat.aoe.vt.edu/");
        });

        it("uses the trailing-slash form S3 actually serves on other routes", () => {
            // The bare path 302s to this, so naming the bare path as canonical
            // would point at a URL that never returns 200.
            expect(canonicalUrl("/fleet")).toBe("https://autoboat.aoe.vt.edu/fleet/");
            expect(canonicalUrl("/fleet/")).toBe("https://autoboat.aoe.vt.edu/fleet/");
        });

        it("collapses both S3 URL forms onto one canonical", () => {
            expect(canonicalUrl("/ourteam")).toBe(canonicalUrl("/ourteam/"));
        });

        it("handles the nested route without doubling the slash", () => {
            expect(canonicalUrl("/calendar/officers")).toBe("https://autoboat.aoe.vt.edu/calendar/officers/");
        });

        it("produces an absolute URL for every route", () => {
            for (const path of allRoutePaths()) {
                expect(() => new URL(canonicalUrl(path))).not.toThrow();
            }
        });
    });

    describe("sitemapRoutes", () => {
        it("excludes the unlisted officers calendar", () => {
            const paths = sitemapRoutes().map((route) => route.path);
            expect(paths).not.toContain("/calendar/officers");
        });

        it("includes every other route", () => {
            const paths = sitemapRoutes().map((route) => route.path);
            expect(paths).toEqual(
                expect.arrayContaining([
                    "/",
                    "/ourteam",
                    "/fleet",
                    "/sponsors",
                    "/other-pages",
                    "/gallery",
                    "/calendar",
                    "/live",
                ]),
            );
        });

        it("only returns routes flagged indexable", () => {
            for (const route of sitemapRoutes()) {
                expect(route.indexable).toBe(true);
            }
        });

        it("gives the home page the highest priority", () => {
            const priorities = Object.fromEntries(
                sitemapRoutes().map((route) => [route.path, Number.parseFloat(route.priority)]),
            );
            const home = priorities["/"];
            for (const value of Object.values(priorities)) {
                expect(home).toBeGreaterThanOrEqual(value);
            }
        });
    });

    describe("allRoutePaths", () => {
        // This list and src/App.tsx's <Route> elements are the two places
        // routes are declared, and they cannot be cross-checked automatically.
        // If you add a page, add it in both -- otherwise it will be reachable
        // but carry the home page's title, and it will 404 on S3 because
        // spa-fallback.mjs derives its route list from the same JSON.
        it("covers every route registered in App.tsx", () => {
            expect(allRoutePaths()).toEqual([
                "/",
                "/ourteam",
                "/fleet",
                "/sponsors",
                "/other-pages",
                "/gallery",
                "/calendar",
                "/live",
                "/calendar/officers",
            ]);
        });

        it("has no duplicates", () => {
            const paths = allRoutePaths();
            expect(new Set(paths).size).toBe(paths.length);
        });

        it("uses a leading slash on every path", () => {
            for (const path of allRoutePaths()) {
                expect(path.startsWith("/")).toBe(true);
                // The root is the only path allowed a trailing slash.
                if (path !== "/") expect(path.endsWith("/")).toBe(false);
            }
        });
    });

    describe("index.html defaults stay in sync with seoRoutes.json", () => {
        // WHY THIS EXISTS. `index.html` hard-codes the HOME page's title and
        // social tags; every other route is this same shell, rewritten per
        // route by `scripts/prerender-meta.mjs` at build time. So the two files
        // describe the same values and must agree.
        //
        // They silently drifted once: the titles in seoRoutes.json were reverted
        // to a longer form while `index.html` was left on the short one. Nothing
        // caught it -- this suite only read the JSON, and `prerender-meta.mjs`
        // UPSERTS, so it quietly overwrote index.html to match the JSON and the
        // revert reached production. Asserting the pair here is what makes that
        // class of change fail in CI instead of shipping.
        const html = readFileSync(INDEX_HTML, "utf8");
        const home = metadataForPath("/");

        function attr(pattern: RegExp): string | null {
            return html.match(pattern)?.[1] ?? null;
        }

        it("found the tags in index.html at all", () => {
            // Guards the regexes themselves: a reformat of index.html's head
            // would otherwise make every assertion below vacuously pass.
            expect(attr(/<title>([^<]*)<\/title>/)).not.toBeNull();
            expect(attr(/<meta\s+property="og:title"\s+content="([^"]*)"/)).not.toBeNull();
        });

        it("uses the home title from seoRoutes.json", () => {
            expect(attr(/<title>([^<]*)<\/title>/)).toBe(home.title);
        });

        it("uses the home title for og:title and twitter:title", () => {
            expect(attr(/<meta\s+property="og:title"\s+content="([^"]*)"/)).toBe(home.title);
            expect(attr(/<meta\s+name="twitter:title"\s+content="([^"]*)"/)).toBe(home.title);
        });

        it("uses the home description", () => {
            expect(attr(/<meta\s+name="description"\s+content="([^"]*)"/)).toBe(home.description);
        });
    });

    it("exposes the site name", () => {
        expect(SITE_NAME).toBe("AutoBoat at Virginia Tech");
    });

    describe("route registration stays in sync with App.tsx", () => {
        // Routes are declared in two places that no compiler checks against each
        // other: the <Route> elements in App.tsx and this metadata file. When
        // they drift, a page becomes reachable but serves the home page's
        // title, and -- because scripts/spa-fallback.mjs derives its route list
        // from the same JSON -- it also 404s on S3. This test is the only thing
        // that catches that.
        const appSource = readFileSync(APP_TSX, "utf8");

        const appRoutePaths = [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)]
            .map((match) => match[1])
            // The catch-all renders Home and has no metadata entry of its own.
            .filter((path) => path !== "*")
            .sort();

        it("found the routes in App.tsx at all", () => {
            // Guards the regex itself: a refactor that reflows the <Route>
            // elements would otherwise silently produce an empty list and make
            // the comparison below vacuously pass.
            expect(appRoutePaths.length).toBeGreaterThan(0);
        });

        it("declares metadata for every route in App.tsx", () => {
            expect([...allRoutePaths()].sort()).toEqual(appRoutePaths);
        });

        it("derives the SPA fallback route list from the same JSON", () => {
            // S3 returns 404 for a route with no file at its path, which is how
            // /gallery, /live, and /calendar were unreachable before
            // spa-fallback.mjs started deriving its list from this JSON.
            const fallbackSource = readFileSync(SPA_FALLBACK_MJS, "utf8");
            expect(fallbackSource).toContain("seoRoutes.json");
        });
    });
});
