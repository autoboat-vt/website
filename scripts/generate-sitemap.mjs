#!/usr/bin/env node

/**
 * Post-build script: generate `dist/sitemap.xml` from `src/lib/seoRoutes.json`.
 *
 * The sitemap used to be a hand-written file at the repo root with a hard-coded
 * `lastmod` of 2026-07-18. Two problems with that:
 *
 *   1. It was not in `public/`, so Vite never copied it into `dist/` and the
 *      deployed site returned 404 for `/sitemap.xml`.
 *   2. It drifted -- three live routes (`/other-pages`, `/live`, `/calendar`)
 *      were missing, and the stale `lastmod` told crawlers nothing had changed
 *      since July.
 *
 * Generating it keeps it in step with the routes and lets `lastmod` be real.
 *
 * NOTE: `lastmod` is the build date, not a content-change date. It is honest in
 * the sense that the page really was rebuilt, but it means every deploy
 * refreshes every URL. That is the tradeoff for not maintaining a changelog;
 * Google treats `lastmod` as a weak signal and will ignore it if it stops
 * looking trustworthy. If that happens, switch to reading `git log -1` per
 * page and cache the result.
 *
 * Run as part of `bun run build`, AFTER `spa-fallback.mjs`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = join(root, "dist");

const seo = JSON.parse(readFileSync(join(root, "src/lib/seoRoutes.json"), "utf8"));
const siteUrl = seo.siteUrl.replace(/\/+$/, "");
const buildDate = new Date().toISOString().slice(0, 10);

/**
 * Absolute canonical URL for a route, mirroring `canonicalUrl()` in seo.ts.
 *
 * The trailing slash on non-root routes is required: S3 serves each page from
 * `<route>/index.html` and 302s the bare path to the trailing-slash form, so
 * that is the address that returns 200. Listing the bare path would advertise
 * a URL that only ever redirects.
 */
function canonicalFor(path) {
    return path === "/" ? `${siteUrl}/` : `${siteUrl}${path}/`;
}

/** Where `spa-fallback.mjs` wrote (or the Vite build placed) this route's HTML. */
function htmlFileFor(path) {
    return path === "/" ? join(distDir, "index.html") : join(distDir, path, "index.html");
}

const indexable = seo.routes.filter((route) => route.indexable);

// Every listed route must have a real HTML file, or the sitemap would advertise
// a URL that 404s -- the exact failure being fixed here. Reading the filesystem
// rather than importing spa-fallback's route list keeps this script free of
// that module's copy side effects.
const missing = indexable.filter((route) => !existsSync(htmlFileFor(route.path))).map((route) => route.path);
if (missing.length > 0) {
    throw new Error(
        `generate-sitemap: sitemap lists routes with no built HTML: ${missing.join(", ")}. ` +
            "spa-fallback.mjs derives its routes from seoRoutes.json, so a missing file means the build skipped a route.",
    );
}

const entries = indexable
    .map(
        (route) => `    <url>
        <loc>${canonicalFor(route.path)}</loc>
        <lastmod>${buildDate}</lastmod>
        <changefreq>${route.changefreq}</changefreq>
        <priority>${route.priority}</priority>
    </url>`,
    )
    .join("\n");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;

writeFileSync(join(distDir, "sitemap.xml"), xml);
console.log(`  generate-sitemap: wrote dist/sitemap.xml (${indexable.length} routes, lastmod ${buildDate})`);
