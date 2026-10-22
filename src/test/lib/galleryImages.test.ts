import { ALL_GALLERY_IMAGES, SUBTEAM_IMAGES } from "../../lib/galleryImages";

/**
 * Tests for the shared gallery image data.
 *
 * The subteam photography is rendered from one list in two places (inline on
 * Meet the Team and mixed into /gallery), so these tests guard the invariants
 * both pages rely on rather than any single rendering.
 */

const ALL_SUBTEAM_IMAGES = Object.values(SUBTEAM_IMAGES).flat();

describe("gallery image data", () => {
    it("has no duplicate src values", () => {
        // /gallery keys its tiles by `src`. A duplicate would silently drop a
        // tile and emit a React duplicate-key warning.
        const srcs = ALL_GALLERY_IMAGES.map((img) => img.src);
        const dupes = srcs.filter((src, i) => srcs.indexOf(src) !== i);
        expect(dupes).toEqual([]);
    });

    it("is exactly the flattened subteam images", () => {
        // The loose photo list was removed: general team photos now come from
        // the Drive folder at runtime, so this module is build-time content
        // only. Asserting equality (not just containment) is what catches a
        // re-added hard-coded list.
        expect(ALL_GALLERY_IMAGES).toEqual(ALL_SUBTEAM_IMAGES);
    });

    it("includes the subteam images so /gallery shows them", () => {
        // Every image on Meet the Team also appears on /gallery.
        for (const img of ALL_SUBTEAM_IMAGES) {
            expect(ALL_GALLERY_IMAGES).toContainEqual(img);
        }
    });

    it("points every image at the committed images folder", () => {
        // These are build-time assets, so a path into a Drive URL here would be
        // a bug -- Drive photos belong to the manifest, not this module.
        for (const img of ALL_GALLERY_IMAGES) {
            expect(img.src).toMatch(/^\/images\/.+\.webp$/);
        }
    });

    it("gives every image a non-empty alt", () => {
        // The src format is asserted above; this is about accessible names.
        for (const img of ALL_GALLERY_IMAGES) {
            expect(img.alt.trim().length).toBeGreaterThan(0);
        }
    });

    it("keys the subteam map by the ids used on the Meet the Team page", () => {
        // SUBTEAMS in OurTeam.tsx looks these up by `id`.
        expect(Object.keys(SUBTEAM_IMAGES).sort()).toEqual(
            ["business", "electronics", "software", "mechanical"].sort(),
        );
    });

    it("leaves the business subteam without photos", () => {
        // Business has no photography; `images: []` suppresses the gallery
        // block on Meet the Team entirely.
        expect(SUBTEAM_IMAGES.business).toEqual([]);
    });
});
