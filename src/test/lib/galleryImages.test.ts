import { ALL_GALLERY_IMAGES, GALLERY_PHOTOS, SUBTEAM_IMAGES } from "../../lib/galleryImages";

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

    it("combines the loose photos and every subteam's images", () => {
        expect(ALL_GALLERY_IMAGES).toHaveLength(GALLERY_PHOTOS.length + ALL_SUBTEAM_IMAGES.length);
    });

    it("includes the subteam images so /gallery shows them", () => {
        // The point of this change: every image on Meet the Team also appears
        // on /gallery.
        for (const img of ALL_SUBTEAM_IMAGES) {
            expect(ALL_GALLERY_IMAGES).toContainEqual(img);
        }
    });

    it("keeps the loose gallery photos first", () => {
        expect(ALL_GALLERY_IMAGES.slice(0, GALLERY_PHOTOS.length)).toEqual(GALLERY_PHOTOS);
    });

    it("gives every image a src and a non-empty alt", () => {
        for (const img of ALL_GALLERY_IMAGES) {
            expect(img.src).toMatch(/^\/images\/.+\.webp$/);
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
