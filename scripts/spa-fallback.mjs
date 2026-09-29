#!/usr/bin/env node

/**
 * Post-build script: generate SPA route fallback files for S3 hosting.
 *
 * S3 (without website-mode error-document config) returns 404 for client-side
 * routes like /sponsors, /ourteam, etc. because no file exists at those paths.
 * This script copies dist/index.html to each route path so S3 finds a real
 * file, serves it, and the React router takes over once loaded in the browser.
 *
 * Also generates dist/404.html — S3 uses it as the custom error document when
 * configured, so any truly-unknown path also falls back to the SPA.
 *
 * Run automatically as part of `bun run build` (see package.json scripts).
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");
const indexHtml = join(distDir, "index.html");

/**
 * Route list, derived from `src/lib/seoRoutes.json`.
 *
 * WARNING: This used to be a hand-maintained array that had to be kept in sync
 * with `src/App.tsx` by hand, and it silently drifted -- three routes were
 * reachable in the app but missing here, so S3 returned 404 for them. Deriving
 * it means adding a route to seoRoutes.json updates the SPA fallback, the
 * sitemap, and the runtime metadata at once.
 *
 * Every route still needs a matching <Route> in src/App.tsx; this list and
 * that file cannot be cross-checked automatically. Exported so
 * `generate-sitemap.mjs` can assert the sitemap does not reference a path that
 * has no fallback file.
 */
export const ROUTES = JSON.parse(readFileSync(join(__dirname, "..", "src", "lib", "seoRoutes.json"), "utf8"))
    .routes.map((route) => route.path)
    // The root is served by dist/index.html itself, so it needs no copy.
    .filter((path) => path !== "/");

for (const route of ROUTES) {
    const dest = join(distDir, `${route}/index.html`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(indexHtml, dest);
    console.log(`  spa-fallback: wrote ${route}/index.html`);
}

// S3 custom error document fallback.
copyFileSync(indexHtml, join(distDir, "404.html"));
console.log("  spa-fallback: wrote /404.html (S3 error document)");
