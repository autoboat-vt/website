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

        it("names the organization in every title", () => {
            for (const path of allRoutePaths()) {
                expect(metadataForPath(path).title).toContain("AutoBoat at Virginia Tech");
            }
        });

        it("keeps titles within a length search results can show", () => {
            for (const path of allRoutePaths()) {
                const { title } = metadataForPath(path);
                // Google truncates around 60 characters; a little slack is fine
                // but a runaway title would be cut off mid-word.
                expect(title.length).toBeLessThanOrEqual(70);
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
