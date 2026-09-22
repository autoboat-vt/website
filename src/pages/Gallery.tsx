import { useState } from "react";
import ImageModal from "../components/ImageModal";
import { ALL_GALLERY_IMAGES, type GalleryImage } from "../lib/galleryImages";

export default function Gallery() {
    const [modalImage, setModalImage] = useState<GalleryImage | null>(null);

    return (
        <>
            {/* mt-14 (56px) puts the title at roughly the same distance below
                the nav as the first Card on the sibling pages (~56-115px).
                It sat at 24px with the old mt-6, which read as cramped against
                the header. */}
            <div className="mx-4 mt-14 mb-8 text-center">
                <h2 className="font-heading text-[clamp(22px,3vw,36px)] font-extrabold">Gallery</h2>
            </div>
            {/* Two columns on mobile (matching the Our Team gallery) rather
                than one: the list is ~38 photos, and a single full-width
                column turns the page into an ~11,000px scroll. */}
            <div className="photo-container mx-auto grid max-w-275 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 px-4 pb-50 max-[620px]:grid-cols-2 max-[620px]:gap-2">
                {ALL_GALLERY_IMAGES.map((photo) => (
                    <button
                        key={photo.src}
                        type="button"
                        className="group block cursor-pointer border-none bg-none p-0 m-0 focus-visible:rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fontcolor"
                        onClick={() => setModalImage(photo)}
                    >
                        {/* overflow-hidden clips the hover scale-up to the rounded corners. */}
                        <div className="overflow-hidden rounded-lg">
                            <img
                                src={photo.src}
                                alt={photo.alt}
                                loading="lazy"
                                className="block aspect-4/3 w-full object-cover transition-[transform,box-shadow] duration-300 group-hover:scale-[1.04] group-hover:shadow-[0_8px_16px_rgba(0,0,0,0.12)] dark:group-hover:shadow-[0_8px_16px_rgba(0,0,0,0.3)]"
                            />
                        </div>
                    </button>
                ))}
            </div>
            <ImageModal
                src={modalImage?.src}
                alt={modalImage?.alt}
                caption={modalImage?.caption}
                onClose={() => setModalImage(null)}
            />
        </>
    );
}
