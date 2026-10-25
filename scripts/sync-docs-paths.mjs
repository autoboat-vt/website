#!/usr/bin/env node

/**
 * Regenerate `src/lib/docsPaths.json` from the documentation repo.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `/documentation/<anything>/` is served by VT S4 (Amazon S3), and S3 only
 * returns a file that exists at that exact key. It does NOT fall back to a
 * parent index.html for a subdirectory, so a deep link like
 *
 *     https://autoboat.aoe.vt.edu/documentation/getting_started/setting_up_dev_environment/
 *
 * is a hard 404 unless a real `index.html` sits at that path. The docs site
 * itself lives on Cloudflare, so every one of these paths has to be
 * materialized as a stub in the S3 upload. That stub list is this manifest.
 *
 * WHY THE RESULT IS COMMITTED RATHER THAN COMPUTED AT BUILD TIME
 * -------------------------------------------------------------
 * The docs repo is a SEPARATE repository. The website's CI checkout does not
 * contain it, so the build cannot read `../documentation/docs`. The manifest is
 * therefore generated here, by hand, and committed; `scripts/docs-stubs.mjs`
 * consumes it at build time. Re-run this script after adding, renaming, or
 * deleting a docs page.
 *
 * The cross-repo drift risk is real: a page added to the docs repo will work on
 * Cloudflare but 404 at the aoe.vt.edu URL until this is re-run. Generate the
 * docs repo's own link check accordingly -- see `src/test/lib/docsPlaceholder
 * .test.ts`, which cross-checks the manifest against the docs repo when it
 * happens to be checked out alongside.
 *
 * Usage (from the website repo root):
 *     node scripts/sync-docs-paths.mjs
 *     node scripts/sync-docs-paths.mjs --docs-root ../documentation
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = resolve(__dirname, "..");
const OUT_FILE = join(WEBSITE_ROOT, "src", "lib", "docsPaths.json");

/** Default location of the sibling docs repo. */
const DEFAULT_DOCS_ROOT = resolve(WEBSITE_ROOT, "..", "documentation");

const docsRootArgIndex = process.argv.indexOf("--docs-root");
const DOCS_ROOT = docsRootArgIndex === -1 ? DEFAULT_DOCS_ROOT : resolve(process.argv[docsRootArgIndex + 1] ?? "");
const DOCS_DIR = join(DOCS_ROOT, "docs");

/**
 * Print the manifest to stdout instead of writing the file.
 *
 * Exists so `src/test/lib/docsPlaceholder.test.ts` can re-derive the manifest
 * and compare it against the committed copy without duplicating the URL mapping
 * in the test. Prints nothing else, so the output is directly parseable.
 */
const STDOUT_ONLY = process.argv.includes("--stdout");

/**
 * Every `.md` file under `docs/`, relative to `docs/` and using forward slashes
 * regardless of platform.
 *
 * Files and directories starting with `_` or `.` are skipped: MkDocs ignores
 * them, so generating stubs for them would create URLs that 404 on Cloudflare.
 */
function markdownFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith("_") || entry.startsWith(".")) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            found.push(...markdownFiles(full));
        } else if (entry.endsWith(".md")) {
            found.push(relative(DOCS_DIR, full).split(sep).join("/"));
        }
    }
    return found;
}

/**
 * The URL MkDocs will publish a page at.
 *
 * Mirrors `use_directory_urls: true` (MkDocs' default, and this repo does not
 * override it): a page becomes a directory with an index.html, so `a/b.md` is
 * served at `/a/b/` and `a/index.md` at `/a/`. The root index becomes `/`.
 *
 * WARNING: If the docs repo ever sets `use_directory_urls: false`, every URL
 * becomes `/a/b.html` and this mapping is wrong. Check before changing it.
 */
function urlPathFor(markdownPath) {
    if (markdownPath === "index.md") return "/";
    if (markdownPath.endsWith("/index.md")) return `/${markdownPath.slice(0, -"index.md".length)}`;
    return `/${markdownPath.replace(/\.md$/, "/")}`;
}

/** Strip a leading YAML frontmatter block and return its `title`, if any. */
function frontmatterTitle(source) {
    if (!source.startsWith("---")) return null;
    const end = source.indexOf("\n---", 3);
    if (end === -1) return null;
    const block = source.slice(3, end);
    // Only a simple top-level `title: value` is needed; nav labels live in
    // mkdocs.yml, and duplicating a YAML parser here would be overkill for one
    // scalar.
    const match = block.match(/^title:\s*(.+)$/m);
    if (!match?.[1]) return null;
    return match[1].trim().replace(/^["']|["']$/g, "");
}

/** `setting_up_dev_environment.md` -> `Setting up dev environment`-ish. */
function humanize(markdownPath) {
    const base = markdownPath.split("/").pop() ?? markdownPath;
    const words = base.replace(/\.md$/, "").replace(/_/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Display title for a page: frontmatter `title`, else the first H1, else a
 * humanized filename.
 *
 * The title is only used for the stub's <title> tag and fallback text. It is not
 * the authoritative docs title -- the framed Cloudflare page supplies that.
 */
function titleFor(markdownPath) {
    const source = readFileSync(join(DOCS_DIR, markdownPath), "utf8");
    const fromFrontmatter = frontmatterTitle(source);
    if (fromFrontmatter) return fromFrontmatter;

    const heading = source.match(/^#\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();

    return humanize(markdownPath);
}

if (!statSync(DOCS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`error: no docs directory at ${DOCS_DIR}`);
    console.error("Pass --docs-root <path> if the documentation repo is elsewhere.");
    process.exit(1);
}

const pages = markdownFiles(DOCS_DIR)
    .map((markdownPath) => ({ path: urlPathFor(markdownPath), title: titleFor(markdownPath) }))
    // Sort so the committed file has a stable, reviewable diff.
    .sort((a, b) => a.path.localeCompare(b.path));

// Two markdown files can map to the same URL only via a case-insensitive
// collision or a `a/index.md` + `a.md` pair. Either would produce one stub
// overwriting the other, so fail rather than silently dropping a page.
const seen = new Map();
for (const page of pages) {
    const previous = seen.get(page.path);
    if (previous) {
        console.error(`error: ${previous} and ${page.path} map to the same URL`);
        process.exit(1);
    }
    seen.set(page.path, page.title);
}

const payload = {
    $comment:
        "Generated by scripts/sync-docs-paths.mjs from the documentation repo. Do not edit by hand -- re-run the script.",
    pages,
};

if (STDOUT_ONLY) {
    // Machine-readable output only -- the test parses this verbatim.
    process.stdout.write(JSON.stringify(payload));
} else {
    writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 4)}\n`);
    console.log(`sync-docs-paths: wrote ${pages.length} pages to src/lib/docsPaths.json`);
}
