/**
 * @jest-environment node
 *
 * Guards the agreement between `worker/wrangler.jsonc` and the binding names the
 * Worker code actually reads.
 *
 * WHY THIS EXISTS: a binding is a STRING on both sides with no shared type. The
 * deploy succeeds with any name in `binding`, and the code compiles against
 * whatever name it happens to use, so a rename on one side is invisible until
 * production. That is exactly how the gallery broke: `r2_buckets` was changed
 * to `autoboat_gallery` while the code still read `env.GALLERY_BUCKET`, so
 * `handleGetGalleryImage` saw `undefined`, returned 503 "gallery not
 * configured", and every tile on /gallery rendered broken even though the
 * manifest still listed the photos.
 *
 * WARNING: This is a PRODUCTION incident regression test. Do not delete it
 * because "the config is obviously right" -- the point is that it was obviously
 * right the last time too.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKER_DIR = resolve(__dirname, "../../../worker");

const wrangler = readFileSync(resolve(WORKER_DIR, "wrangler.jsonc"), "utf8");

/** Every `"binding": "NAME"` in the config, whatever the resource type. */
function declaredBindings(): Set<string> {
    const names = new Set<string>();
    for (const match of wrangler.matchAll(/"binding"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
        if (match[1]) names.add(match[1]);
    }
    return names;
}

/** The binding names declared under one top-level resource array. */
function bindingsInBlock(blockName: string): string[] {
    // The file is JSONC, so anchor on the array and stop at the closing bracket.
    // Values inside this region cannot contain a `]` before the block ends
    // because every entry is a flat object.
    const block = wrangler.match(new RegExp(`"${blockName}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    if (!block) throw new Error(`"${blockName}" block not found in worker/wrangler.jsonc`);
    return [...(block[1] as string).matchAll(/"binding"\s*:\s*"([^"]+)"/g)].map((m) => m[1] as string);
}

/**
 * Binding-shaped identifiers the Worker reads off `env` (`*_BUCKET`, `*_KV`).
 *
 * Deliberately narrower than "every `env.X`": vars and secrets (CACHE_TTL,
 * SESSION_SECRET, GOOGLE_PRIVATE_KEY, ...) are NOT bindings and legitimately
 * have no `binding` entry, so including them would make this test noise that
 * gets deleted rather than a signal.
 */
function readBindingSuffixIdentifiers(source: string): Set<string> {
    const names = new Set<string>();
    for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*(?:_BUCKET|_KV))\b/g)) {
        if (match[1]) names.add(match[1]);
    }
    return names;
}

describe("worker binding configuration", () => {
    it("binds the R2 bucket as GALLERY_BUCKET", () => {
        // The exact name the code reads. A rename here without a rename there
        // is the 503 that took the gallery down.
        expect(bindingsInBlock("r2_buckets")).toContain("GALLERY_BUCKET");
    });

    it("binds the KV namespace as EVENTS_KV", () => {
        // Same failure shape: an undefined KV leaves the calendar empty and the
        // gallery manifest unreadable, with no error surfaced to the visitor.
        expect(bindingsInBlock("kv_namespaces")).toContain("EVENTS_KV");
    });

    it("declares every bucket/KV binding the Worker reads off env", () => {
        const declared = declaredBindings();
        const used = new Set([
            ...readBindingSuffixIdentifiers(readFileSync(resolve(WORKER_DIR, "src/index.ts"), "utf8")),
            ...readBindingSuffixIdentifiers(readFileSync(resolve(WORKER_DIR, "src/gallerySync.ts"), "utf8")),
        ]);

        // Sanity-check the parsers: if both sides silently produced nothing,
        // the assertion below would pass with no coverage at all.
        expect(used.size).toBeGreaterThan(0);

        const missing = [...used].filter((name) => !declared.has(name));
        expect(missing).toEqual([]);
    });

    it("names the gallery bucket by its real name", () => {
        // The README's setup step and the deploy both refer to the bucket by
        // `bucket_name`; a rename would orphan the bytes already mirrored.
        expect(wrangler).toContain('"bucket_name": "autoboat-gallery"');
    });
});
