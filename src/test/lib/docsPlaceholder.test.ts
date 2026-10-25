import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards the `/documentation` loader page in `public/documentation/`.
 *
 * That page is a shell that frames the Cloudflare-hosted docs site. Three things
 * have to stay true or it breaks in ways that are invisible until someone loads
 * the deployed URL:
 *
 *   1. The file must exist in `public/` (not only in the S4 repo). `deploy.sh`
 *      replaces the entire S4 tree with `dist/`, so a page committed only on the
 *      VT side is deleted on the next website deploy.
 *   2. `/documentation` must NOT be a route in `seoRoutes.json`. Both
 *      `spa-fallback.mjs` and `prerender-meta.mjs` iterate that JSON, and the
 *      fallback copies `dist/index.html` over `dist/<route>/index.html` --
 *      which would silently replace this page with the React SPA shell.
 *   3. The framed URL must match the Pages project in the docs repo's workflow.
 *      The two live in different repos and nothing else cross-checks them, so a
 *      project rename would leave this page framing a 404.
 *
 * None of these failures surfaces as a build error, so assert all three here.
 */
const ROOT = resolve(__dirname, "../../..");
const PLACEHOLDER = resolve(ROOT, "public/documentation/index.html");
const SEO_ROUTES = resolve(ROOT, "src/lib/seoRoutes.json");
const DOCS_WORKFLOW = resolve(ROOT, "../documentation/.github/workflows/deploy-docs.yml");

/** The iframe target, read from the page rather than hard-coded here. */
function framedUrl(): string {
    const html = readFileSync(PLACEHOLDER, "utf8");
    const match = html.match(/<iframe[^>]*\ssrc="([^"]+)"/);
    if (!match?.[1]) throw new Error("no iframe src found in the documentation loader");
    return match[1];
}

describe("/documentation loader", () => {
    it("ships the page from public/ so it survives a deploy", () => {
        expect(existsSync(PLACEHOLDER)).toBe(true);
    });

    it("is a full HTML document", () => {
        const html = readFileSync(PLACEHOLDER, "utf8");
        expect(html).toMatch(/^<!doctype html>/i);
        expect(html).toContain("</html>");
    });

    it("frames the docs site instead of shipping content of its own", () => {
        // The page is a loader: content comes from Cloudflare, not from S3.
        expect(framedUrl()).toMatch(/^https:\/\/[a-z0-9-]+\.pages\.dev\/$/);
    });

    it("points at the canonical host so the two copies do not compete in search", () => {
        // The framed site declares itself canonical; this page must agree or it
        // would advertise a different URL for the same content.
        const html = readFileSync(PLACEHOLDER, "utf8");
        const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/)?.[1];
        expect(canonical).toBe(framedUrl());
    });

    it("is excluded from search results but still follows links", () => {
        // noindex: this is a frame wrapper, not a destination. `follow` rather
        // than `nofollow` so the link to the docs host is still crawled.
        expect(readFileSync(PLACEHOLDER, "utf8")).toMatch(/<meta\s+name="robots"\s+content="noindex, follow"/i);
    });

    it("does not collide with an SPA route", () => {
        // WARNING: adding "/documentation" to seoRoutes.json makes
        // spa-fallback.mjs overwrite this file with the SPA shell.
        const routes: { path: string }[] = JSON.parse(readFileSync(SEO_ROUTES, "utf8")).routes;
        expect(routes.map((route) => route.path)).not.toContain("/documentation");
    });

    // The cross-repo check. Skipped when the docs repo is not checked out
    // alongside this one, so the suite still passes in a standalone clone or in
    // CI, where only this repo is present.
    //
    // NOTE: `it.skip` rather than a bare `it`, because a missing sibling checkout
    // is not a failure -- the two repos are separate GitHub repositories and CI
    // only ever has one of them.
    const crossRepoCheck = existsSync(DOCS_WORKFLOW) ? it : it.skip;
    crossRepoCheck("frames the same Pages project the docs workflow deploys", () => {
        const workflow = readFileSync(DOCS_WORKFLOW, "utf8");
        const project = workflow.match(/^\s*PAGES_PROJECT:\s*(\S+)\s*$/m)?.[1];
        expect(project).toBeDefined();
        expect(framedUrl()).toBe(`https://${project}.pages.dev/`);
    });
});

/**
 * The docs path manifest.
 *
 * `src/lib/docsPaths.json` lists every page the docs site publishes. The build
 * writes one stub `index.html` per entry so deep links resolve on S3, which has
 * no directory-index fallback. The list is generated from the docs repo by
 * `scripts/sync-docs-paths.mjs` and committed, because CI only checks out this
 * repo and cannot read the docs Markdown.
 *
 * The drift risk is one-directional and silent: a page added to the docs repo
 * works on Cloudflare but 404s at the aoe.vt.edu URL until the manifest is
 * regenerated. The last test catches it when the sibling repo is present.
 */
describe("docs path manifest", () => {
    const MANIFEST = resolve(ROOT, "src/lib/docsPaths.json");
    const manifest: { pages: { path: string; title: string }[] } = JSON.parse(readFileSync(MANIFEST, "utf8"));

    it("lists pages with absolute, trailing-slash paths", () => {
        expect(manifest.pages.length).toBeGreaterThan(0);
        for (const page of manifest.pages) {
            // Trailing slash matches what MkDocs with use_directory_urls emits,
            // and matches what S3 serves after its 302.
            expect(page.path).toMatch(/^\/(?:[\w-]+\/)*$/);
        }
    });

    it("includes the docs root exactly once", () => {
        // The root is served by dist/documentation/index.html itself; the stub
        // script skips it rather than copying a file onto itself.
        expect(manifest.pages.filter((page) => page.path === "/")).toHaveLength(1);
    });

    it("has no duplicate paths", () => {
        const paths = manifest.pages.map((page) => page.path);
        expect(new Set(paths).size).toBe(paths.length);
    });

    it("gives every page a non-empty title", () => {
        for (const page of manifest.pages) {
            expect(page.title.trim()).not.toBe("");
        }
    });

    it("covers a representative deep page", () => {
        // Guards against a generator that silently emits only top-level pages.
        expect(manifest.pages.map((page) => page.path)).toContain("/getting_started/setting_up_dev_environment/");
    });

    // Regenerating is a single command, so keep the manifest honest rather than
    // letting it rot. Skipped when the docs repo is not checked out.
    const DOCS_DOCS_DIR = resolve(ROOT, "../documentation/docs");
    const manifestMatchesDocs = existsSync(DOCS_DOCS_DIR) ? it : it.skip;
    manifestMatchesDocs("matches the pages in the docs repo", () => {
        const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
        // Run the generator against a temp output and compare, rather than
        // re-implementing its URL mapping here -- two implementations would
        // drift in exactly the way this test is meant to catch.
        const generated = execFileSync(
            process.execPath,
            [
                resolve(ROOT, "scripts/sync-docs-paths.mjs"),
                "--docs-root",
                resolve(ROOT, "../documentation"),
                "--stdout",
            ],
            { encoding: "utf8" },
        );
        const fresh = JSON.parse(generated);
        expect(fresh.pages).toEqual(manifest.pages);
    });
});
