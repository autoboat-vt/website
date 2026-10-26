/**
 * Per-photo permalinks on the site's own domain.
 *
 * WHY THESE EXIST SEPARATELY FROM THE PAGE TESTS. The page test proves the
 * lightbox opens; these pin the string-building and parsing rules, which is where
 * a subtle bug is invisible on screen -- a permalink that percent-encodes twice,
 * or a pathname parser that throws on a stray `%`, still "works" for a
 * well-behaved id and fails only for a real one from Drive.
 *
 * WARNING: These assert the SITE domain. The `<img src>` is still a Worker URL
 * (`galleryImageUrl`), because the site host is plain S3 on VT's DNS and cannot
 * serve the bytes. If a test here starts expecting an image URL, one of the two
 * concepts has been conflated.
 */

import {
    galleryImageUrl,
    galleryPermalinkPath,
    galleryPermalinkUrl,
    photoIdFromPathname,
} from "../../lib/galleryClient";
import { SITE_URL } from "../../lib/seo";

describe("galleryPermalinkPath", () => {
    it("puts the photo on the gallery path", () => {
        expect(galleryPermalinkPath("abc123")).toBe("/gallery/abc123");
    });

    it("percent-encodes ids that are not URL-safe", () => {
        // Drive ids are URL-safe today, but the Worker accepts a character set
        // and this must not assume the narrower one.
        expect(galleryPermalinkPath("a/b?c#d")).toBe("/gallery/a%2Fb%3Fc%23d");
    });
});

describe("galleryPermalinkUrl", () => {
    it("uses the site origin, not the Worker origin", () => {
        // This is the whole point of the feature.
        const url = galleryPermalinkUrl("abc123", SITE_URL);
        expect(url).toBe("https://autoboat.aoe.vt.edu/gallery/abc123");
        expect(url).not.toContain("workers.dev");
    });

    it("tolerates a trailing slash on the site url", () => {
        // A doubled slash would still route, but it is not the canonical form
        // and it makes the copied link look wrong.
        expect(galleryPermalinkUrl("abc123", "https://example.com/")).toBe("https://example.com/gallery/abc123");
    });
});

describe("photoIdFromPathname", () => {
    it.each([
        ["/gallery/abc123", "abc123"],
        ["/gallery/abc123/", "abc123"],
        ["/GALLERY/abc123", "abc123"],
        // The id round-trips through encodeURIComponent, so the parser decodes.
        ["/gallery/a%2Fb", "a/b"],
    ])("reads %s as %s", (pathname, expected) => {
        expect(photoIdFromPathname(pathname)).toBe(expected);
    });

    it.each(["/gallery", "/gallery/", "/", "/gallery/a/b", "/calendar/officers", ""])(
        "returns null for %s",
        (pathname) => {
            // A multi-segment path is not a photo id; treating it as one would
            // make /calendar/officers look like a photo.
            expect(photoIdFromPathname(pathname)).toBeNull();
        },
    );

    it("returns null rather than throwing on a malformed escape", () => {
        // decodeURIComponent throws a URIError on a lone `%`. Inside a render
        // that is a blank page, so it must be caught here.
        expect(() => photoIdFromPathname("/gallery/%")).not.toThrow();
        expect(photoIdFromPathname("/gallery/%")).toBeNull();
    });
});

describe("the two URL kinds stay distinct", () => {
    it("keys the image URL on the Worker and the permalink on the site", () => {
        const image = galleryImageUrl("abc123");
        const link = galleryPermalinkUrl("abc123", SITE_URL);

        expect(image).not.toBe(link);
        expect(image).toContain("/gallery/image/abc123");
        expect(link).toContain("/gallery/abc123");
        // The permalink must never be an image route, or a shared link would
        // download a file instead of opening the gallery.
        expect(link).not.toContain("/gallery/image/");
    });

    it("serves bytes from the Worker unless VITE_GALLERY_IMAGE_BASE says otherwise", () => {
        // WHY THIS IS THE CURRENT BEHAVIOUR: autoboat.aoe.vt.edu is plain Amazon
        // S3 on VT's DNS, so it has no /gallery/image/<id> object and no
        // Cloudflare route in front of it. Pointing <img src> at the site domain
        // today would break every tile. `galleryImageUrl` is the single place
        // that decision lives, so when the domain is fronted by Cloudflare this
        // assertion is the one to flip.
        expect(galleryImageUrl("abc123")).toContain("workers.dev/gallery/image/abc123");
    });
});

describe("VITE_GALLERY_IMAGE_BASE override", () => {
    // `IMAGE_BASE` is captured at module load, so the env var has to be set
    // before the module is imported. `jest.isolateModules` gives each case a
    // fresh copy of the module graph.
    const ORIGINAL = (globalThis as { __VITE_GALLERY_IMAGE_BASE__?: string }).__VITE_GALLERY_IMAGE_BASE__;

    afterEach(() => {
        (globalThis as { __VITE_GALLERY_IMAGE_BASE__?: string }).__VITE_GALLERY_IMAGE_BASE__ = ORIGINAL;
    });

    function loadWithBase(base: string | undefined) {
        (globalThis as { __VITE_GALLERY_IMAGE_BASE__?: string }).__VITE_GALLERY_IMAGE_BASE__ = base;
        let mod: typeof import("../../lib/galleryClient") | undefined;
        jest.isolateModules(() => {
            mod = require("../../lib/galleryClient") as typeof import("../../lib/galleryClient");
        });
        return mod as typeof import("../../lib/galleryClient");
    }

    it("moves the image bytes to the configured origin", () => {
        // The escape hatch: when the site domain is fronted by Cloudflare, the
        // bytes move with an env var and no source edit.
        const mod = loadWithBase("https://autoboat.aoe.vt.edu/gallery");
        expect(mod.galleryImageUrl("abc123")).toBe("https://autoboat.aoe.vt.edu/gallery/image/abc123");
    });

    it("trims a trailing slash so the path does not double up", () => {
        const mod = loadWithBase("https://autoboat.aoe.vt.edu/gallery/");
        expect(mod.galleryImageUrl("abc123")).toBe("https://autoboat.aoe.vt.edu/gallery/image/abc123");
    });

    it("falls back to the Worker when the base is blank", () => {
        // The shipped default. A "blank means unset" rule is what keeps an empty
        // env var from producing a relative `"/image/abc123"`.
        const mod = loadWithBase("");
        expect(mod.galleryImageUrl("abc123")).toContain("workers.dev/gallery/image/abc123");
    });

    it("still percent-encodes the id when overridden", () => {
        const mod = loadWithBase("https://example.com/gallery");
        expect(mod.galleryImageUrl("a/b")).toBe("https://example.com/gallery/image/a%2Fb");
    });
});
