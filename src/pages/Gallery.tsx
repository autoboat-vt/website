import { useState } from "react";
import ImageModal from "../components/ImageModal";

interface GalleryImage {
    src: string;
    alt: string;
}

const PHOTOS: GalleryImage[] = Array.from({ length: 15 }, (_, i) => ({
    src: `/images/gallery/${i + 1}.webp`,
    alt: `#${i + 1}`,
}));

export default function Gallery() {
    const [modalImage, setModalImage] = useState<GalleryImage | null>(null);

    return (
        <>
            <div className="mx-4 my-8 mt-6 mb-6 text-center">
                <span className="kicker">In the Shop & On the Water</span>
                <h3 className="font-heading text-[clamp(22px,3vw,36px)] font-extrabold">Gallery</h3>
            </div>
            <div className="photo-container mx-auto grid max-w-275 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 px-4 pb-50 max-[620px]:grid-cols-1">
                {PHOTOS.map((photo) => (
                    <button
                        key={photo.src}
                        type="button"
                        className="group block cursor-zoom-in border-none bg-none p-0 m-0 focus-visible:rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fontcolor"
                        onClick={() => setModalImage(photo)}
                    >
                        <div className="relative overflow-hidden rounded-lg">
                            <img
                                src={photo.src}
                                alt={photo.alt}
                                loading="lazy"
                                className="block aspect-4/3 w-full object-cover transition-[transform,box-shadow] duration-300 group-hover:scale-[1.04] group-hover:shadow-[0_8px_16px_rgba(0,0,0,0.12)] dark:group-hover:shadow-[0_8px_16px_rgba(0,0,0,0.3)]"
                            />
                            {/* Accent gradient overlay on hover */}
                            <div
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                                style={{
                                    background: "linear-gradient(to top, rgba(134,31,65,0.35) 0%, transparent 60%)",
                                }}
                            />
                        </div>
                    </button>
                ))}
            </div>
            <ImageModal src={modalImage?.src} alt={modalImage?.alt} onClose={() => setModalImage(null)} />
        </>
    );
}
