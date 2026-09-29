/**
 * Route metadata for SEO -- the single source of truth for each page's
 * <title>, meta description, canonical URL, and sitemap entry.
 *
 * The data lives in a plain JSON file (`seoRoutes.json`) rather than here so it
 * can be read from two runtimes that share no module system:
 *
 *   - the React app, through `src/hooks/usePageMeta.ts` (browser)
 *   - the build, through `scripts/spa-fallback.mjs` and
 *     `scripts/generate-sitemap.mjs` (node)
 *
 * WARNING: Do not inline this data into a component or a script. The app and
 * the sitemap must agree about which routes exist. If they drift, the sitemap
 * advertises URLs that aren't there or omits pages that are live -- and the
 * failure is silent in both directions.
 *
 * WARNING: This is a client-rendered SPA, so these tags are set at runtime in
 * the browser. Search engines that execute JavaScript (Google) see them; any
 * crawler reading the raw HTML sees the defaults baked into `index.html` (see
 * the comment there). `scripts/prerender-meta.mjs` rewrites those defaults per
 * route at build time so non-JS consumers agree with this module.
 */
import seoRoutes from "./seoRoutes.json";

export interface RouteMeta {
    /** Router path, no trailing slash except for the root (`/`). */
    path: string;
    title: string;
    description: string;
    /** Sitemap `<changefreq>`. Advisory only -- Google ignores it. */
    changefreq: string;
    /** Sitemap `<priority>` as a string, because it is serialized verbatim. */
    priority: string;
    /**
     * Whether the route may be indexed. This one flag drives BOTH the sitemap
     * listing and the runtime `robots` meta tag, so a route cannot be
     * advertised in the sitemap while asking not to be indexed.
     *
     * `/calendar/officers` is `false`: it is unlisted but not access
     * controlled, so it should not be in search results either.
     */
    indexable: boolean;
}

const ROUTES: readonly RouteMeta[] = seoRoutes.routes;

// Validate the JSON at module load.
//
// WARNING: These checks exist because a missing `indexable` key is not a type
// error -- JSON is untyped, so `undefined` flows straight through and reads as
// falsy. A route with a typo'd key therefore silently becomes `noindex` and
// drops out of the sitemap, and it cost real debugging time (two routes were
// left on the old `inSitemap` field). Failing loudly here surfaces it in tests
// and at build time instead of shipping a site that quietly de-indexes itself.
for (const route of ROUTES) {
    if (typeof route.indexable !== "boolean") {
        throw new Error(`seoRoutes.json: route "${route.path}" needs a boolean "indexable" field`);
    }
    if (!route.title || !route.description) {
        throw new Error(`seoRoutes.json: route "${route.path}" needs both a title and a description`);
    }
}

/** Origin only, no trailing slash. */
export const SITE_URL: string = seoRoutes.siteUrl.replace(/\/+$/, "");

export const SITE_NAME: string = seoRoutes.siteName;

/**
 * Absolute URL for the social share image.
 *
 * WARNING: Open Graph requires an ABSOLUTE URL. A relative path here means no
 * preview image at all, which is what shipped before (`/images/favicon.ico`).
 */
export const OG_IMAGE_URL: string = `${SITE_URL}${seoRoutes.ogImagePath}`;

export const HOME_PATH = "/";

/**
 * Strip the trailing slash so `/fleet/` and `/fleet` resolve to one entry.
 * S3 serves the former and 302-redirects the bare path to it, so both URLs
 * exist in the wild and must canonicalize to the same target.
 */
function normalizePath(path: string): string {
    const withoutTrailing = path.replace(/\/+$/, "");
    return withoutTrailing === "" ? HOME_PATH : withoutTrailing;
}

/**
 * Map a `window.location.pathname` to a router path.
 *
 * Lowercases because react-router matches case-insensitively: `/OurTeam`
 * renders the team page, so it has to resolve to the same metadata rather than
 * silently falling back to the home page's.
 */
export function routerPathForPathname(pathname: string): string {
    const segments = pathname.toLowerCase().split("/").filter(Boolean);
    return segments.length === 0 ? HOME_PATH : `/${segments.join("/")}`;
}

/**
 * Look up a route, throwing if it is missing.
 *
 * WARNING: Returning `RouteMeta` (rather than `RouteMeta | undefined`) is the
 * whole point. Writing this as `const HOME_META = ROUTES.find(...)` followed by
 * a `throw` guard does NOT work: TypeScript does not propagate a module-scope
 * narrowing into the body of a function declared later, so `metadataForPath`
 * still saw `RouteMeta | undefined` and failed to compile. A typed accessor
 * puts the check where the compiler can see it.
 */
function requireRoute(path: string): RouteMeta {
    const route = ROUTES.find((candidate) => candidate.path === path);
    if (!route) {
        // Throwing beats defaulting: a missing entry means the data file is
        // malformed, and `metadataForPath`'s fallback depends on this one.
        // Failing loudly at module load surfaces it in tests and at build time
        // instead of shipping a site with no title.
        throw new Error(`seoRoutes.json must contain an entry for "${path}"`);
    }
    return route;
}

const HOME_META: RouteMeta = requireRoute(HOME_PATH);

export { HOME_META };

/**
 * Metadata for a router path, falling back to the home entry for unknown
 * paths. The fallback is correct because `App.tsx`'s `*` route renders the
 * home page for anything unmatched.
 */
export function metadataForPath(path: string): RouteMeta {
    const normalized = normalizePath(path);
    return ROUTES.find((route) => route.path === normalized) ?? HOME_META;
}

/**
 * Absolute canonical URL for a router path.
 *
 * WARNING: Non-root routes get a TRAILING SLASH, and that is not cosmetic.
 * S3 serves each page from `<route>/index.html`, so `/fleet/` is the URL that
 * returns 200 while the bare `/fleet` returns a 302 to it. Since that redirect
 * is temporary (not a 301), the canonical tag is the only thing that reliably
 * consolidates the two addresses -- so it has to name the one that actually
 * serves the page. Verified against production: every bare route 302s to its
 * trailing-slash form.
 */
export function canonicalUrl(path: string): string {
    const normalized = normalizePath(path);
    return normalized === HOME_PATH ? `${SITE_URL}/` : `${SITE_URL}${normalized}/`;
}

/** Routes that belong in `sitemap.xml`. */
export function sitemapRoutes(): RouteMeta[] {
    return ROUTES.filter((route) => route.indexable);
}

/** Every route path, for cross-checking against `App.tsx`. */
export function allRoutePaths(): string[] {
    return ROUTES.map((route) => route.path);
}
