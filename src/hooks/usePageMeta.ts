import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { canonicalUrl, metadataForPath, routerPathForPathname } from "../lib/seo";

/**
 * Create-or-update a `<meta>` tag we own.
 *
 * Upserting rather than appending matters: this runs on every route change, so
 * a blind `appendChild` would stack duplicate descriptions and Open Graph tags
 * onto the page as the user navigates.
 */
function upsertMeta(attr: "name" | "property", key: string, content: string): void {
    const existing = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
    if (existing) {
        existing.setAttribute("content", content);
        return;
    }
    const el = document.createElement("meta");
    el.setAttribute(attr, key);
    el.setAttribute("content", content);
    document.head.appendChild(el);
}

function upsertCanonical(href: string): void {
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
        link = document.createElement("link");
        link.setAttribute("rel", "canonical");
        document.head.appendChild(link);
    }
    link.setAttribute("href", href);
}

/**
 * Apply the current route's metadata to `document.head`.
 *
 * Call once, from a component rendered inside the router (see `App.tsx`).
 *
 * NOTE: This only affects the live DOM. The copy a non-JS crawler reads is the
 * one baked into `index.html`, which `scripts/prerender-meta.mjs` rewrites per
 * route at build time. If you add a tag here, add it there too -- otherwise
 * the two disagree for every crawler that doesn't execute JavaScript.
 */
export function usePageMeta(): void {
    const { pathname } = useLocation();

    useEffect(() => {
        const routerPath = routerPathForPathname(pathname);
        const meta = metadataForPath(routerPath);
        const canonical = canonicalUrl(routerPath);

        document.title = meta.title;
        upsertMeta("name", "description", meta.description);
        // Driven by the same `indexable` flag that controls the sitemap, so a
        // route can't be listed in the sitemap while asking not to be indexed.
        upsertMeta("name", "robots", meta.indexable ? "index, follow" : "noindex, nofollow");
        upsertCanonical(canonical);

        upsertMeta("property", "og:title", meta.title);
        upsertMeta("property", "og:description", meta.description);
        // og:url is the canonical URL, which is what collapses /fleet and
        // /fleet/ into one entity for social crawlers.
        upsertMeta("property", "og:url", canonical);
        upsertMeta("name", "twitter:card", "summary_large_image");
        upsertMeta("name", "twitter:title", meta.title);
        upsertMeta("name", "twitter:description", meta.description);
    }, [pathname]);
}
