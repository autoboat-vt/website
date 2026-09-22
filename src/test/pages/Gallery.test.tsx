import { render, screen } from "@testing-library/react";
import { GALLERY_PHOTOS, SUBTEAM_IMAGES } from "../../lib/galleryImages";
import Gallery from "../../pages/Gallery";

/**
 * Tests for the Gallery page. It renders one tile per entry in the shared
 * image list, so the assertions are about count and coverage rather than
 * any particular photo.
 */

function renderGallery() {
    return render(<Gallery />);
}

describe("Gallery page", () => {
    it("renders a tile for every image in the shared list", () => {
        const { container } = renderGallery();

        expect(container.querySelectorAll(".photo-container img")).toHaveLength(
            GALLERY_PHOTOS.length + Object.values(SUBTEAM_IMAGES).flat().length,
        );
    });

    it("includes the Meet the Team subteam images", () => {
        const { container } = renderGallery();

        const srcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
        for (const img of Object.values(SUBTEAM_IMAGES).flat()) {
            expect(srcs).toContain(img.src);
        }
    });

    it("renders a captioned subteam photo so its caption reaches the lightbox", () => {
        renderGallery();

        // The computer vision shot is one of the captioned team images; its
        // alt text is what identifies it in the grid.
        expect(screen.getByAltText("Computer Vision System")).toBeInTheDocument();
    });
});
