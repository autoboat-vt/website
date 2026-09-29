#!/usr/bin/env node

/**
 * Post-build script: bake per-route metadata into each generated index.html.
 *
 * Why this exists
 * ---------------
 * This is a client-rendered SPA. Every route is served the same HTML shell and
 * `src/hooks/usePageMeta.ts` rewrites the title/description at runtime. Google
 * executes JavaScript, but most other consumers do not -- link-preview bots,
 * social crawlers, and plain `curl` all read the raw HTML. Without this step
 * they see the home page's title on every URL.
 *
 * So there are two writers for the same five tags, deliberately:
 *
 *   build time (this script)  -> what a non-JS consumer sees
 *   runtime (usePageMeta.ts)  -> what a JS consumer sees
 *
 * WARNING: Both read `src/lib/seoRoutes.json`. Never hard-code titles here.
 * If you add a tag to the hook, add it here too, or the two disagree.
 *
 * Run automatically as part of `bun run build`, AFTER `spa-fallback.mjs`
 * (which is what creates the per-route `index.html` files this rewrites).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = join(root, "dist");

const seo = JSON.parse(readFileSync(join(root, "src/lib/seoRoutes.json"), "utf8"));
const siteUrl = seo.siteUrl.replace(/\/+$/, "");

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Replace the `content` of the `<meta>` carrying `attr="key"`, inserting the
 * tag before `</head>` if it is not there.
 *
 * Matches the whole tag with `[^>]*` on both sides of the key so it does not
 * care which order Vite emitted the attributes in, then rewrites `content`
 * inside the matched tag.
 *
 * WARNING: Inserting rather than throwing is deliberate. These tags used to be
 * REQUIRED in index.html, which made that file silently load-bearing: reverting
 * it (or dropping a tag while editing the head) failed the build with an error
 * that pointed at this script rather than at the missing tag. Upserting keeps
 * the build output correct regardless of what the shell happens to contain.
 */
function setMeta(html, attr, key, value) {
    const content = escapeHtml(value);
    const tagRe = new RegExp(`<meta[^>]*\\s${attr}="${escapeRegExp(key)}"[^>]*>`, "i");
    if (!tagRe.test(html)) {
        return insertBeforeHeadEnd(html, `<meta ${attr}="${key}" content="${content}">`);
    }
    return html.replace(tagRe, (tag) =>
        /\scontent="/.test(tag)
            ? tag.replace(/\scontent="[^"]*"/, ` content="${content}"`)
            : tag.replace(/>$/, ` content="${content}">`),
    );
}

/** Rewrite the `<link rel="canonical">` href, inserting the tag if absent. */
function setCanonical(html, href) {
    const tagRe = /<link[^>]*\srel="canonical"[^>]*>/i;
    if (!tagRe.test(html)) {
        return insertBeforeHeadEnd(html, `<link rel="canonical" href="${href}">`);
    }
    return html.replace(tagRe, (tag) =>
        /\shref="/.test(tag) ? tag.replace(/\shref="[^"]*"/, ` href="${href}"`) : tag.replace(/>$/, ` href="${href}">`),
    );
}

/** Rewrite the `<title>`, inserting one if the shell has none. */
function setTitle(html, title) {
    const value = escapeHtml(title);
    if (/<title>.*?<\/title>/s.test(html)) {
        return html.replace(/<title>.*?<\/title>/s, `<title>${value}</title>`);
    }
    return insertBeforeHeadEnd(html, `<title>${value}</title>`);
}

/** Insert a tag as the last element of <head>. */
function insertBeforeHeadEnd(html, tag) {
    if (!/<!--\s*seo-meta\s*-->/.test(html)) {
        html = html.replace(/<\/head>/i, `    <!-- seo-meta -->\n</head>`);
    }
    return html.replace(/<!--\s*seo-meta\s*-->/i, `<!-- seo-meta -->\n        ${tag}`);
}

/**
 * Absolute canonical URL for a route, mirroring `canonicalUrl()` in seo.ts.
 *
 * The trailing slash on non-root routes is required: S3 serves each page from
 * `<route>/index.html` and 302s the bare path to the trailing-slash form, so
 * that is the address that returns 200.
 */
function canonicalFor(path) {
    return path === "/" ? `${siteUrl}/` : `${siteUrl}${path}/`;
}

const shell = readFileSync(join(distDir, "index.html"), "utf8");

for (const route of seo.routes) {
    const canonical = canonicalFor(route.path);

    let html = shell;
    html = setTitle(html, route.title);
    html = setMeta(html, "name", "description", route.description);
    // Same `indexable` flag the runtime hook and the sitemap read, so a route
    // cannot be listed for indexing in one place and denied in another.
    html = setMeta(html, "name", "robots", route.indexable ? "index, follow" : "noindex, nofollow");
    html = setMeta(html, "property", "og:title", route.title);
    html = setMeta(html, "property", "og:description", route.description);
    html = setMeta(html, "property", "og:url", canonical);
    html = setMeta(html, "name", "twitter:title", route.title);
    html = setMeta(html, "name", "twitter:description", route.description);
    html = setCanonical(html, canonical);

    // The root route owns dist/index.html; everything else lives in a
    // directory of its own, written by scripts/spa-fallback.mjs.
    const dest = route.path === "/" ? join(distDir, "index.html") : join(distDir, route.path, "index.html");
    writeFileSync(dest, html);
    console.log(`  prerender-meta: ${route.path} -> ${route.title}`);
}
