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
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");
const indexHtml = join(distDir, "index.html");

// Must match the routes defined in src/App.tsx.
const ROUTES = ["/ourteam", "/fleet", "/how-to-join", "/sponsors", "/gallery"];

for (const route of ROUTES) {
    const dest = join(distDir, `${route}/index.html`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(indexHtml, dest);
    console.log(`  spa-fallback: wrote ${route}/index.html`);
}

// S3 custom error document fallback.
copyFileSync(indexHtml, join(distDir, "404.html"));
console.log("  spa-fallback: wrote /404.html (S3 error document)");
