import { useState } from "react";
import ImageModal from "../components/ImageModal";

interface GalleryImage {
    src: string;
    alt: string;
}

const PHOTOS: GalleryImage[] = Array.from({ length: 15 }, (_, i) => ({
    src: `/images/gallery/${i + 1}.webp`,
    alt: `#${i + 1}`
}));

export default function Gallery() {
    const [modalImage, setModalImage] = useState<GalleryImage | null>(null);

    return (
        <>
            <h3 className="section-header">Gallery</h3>
            <div id="photo-container">
                {PHOTOS.map((photo) => (
                    <button key={photo.src} type="button" className="photo-button" onClick={() => setModalImage(photo)}>
                        <img src={photo.src} alt={photo.alt} loading="lazy" />
                    </button>
                ))}
            </div>
            <ImageModal src={modalImage?.src} alt={modalImage?.alt} onClose={() => setModalImage(null)} />
        </>
    );
}
