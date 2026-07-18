interface GalleryImage {
    src: string;
    alt: string;
}

interface GalleryProps {
    images: GalleryImage[];
    onImageClick?: (image: GalleryImage) => void;
    ariaLabel?: string;
}

/**
 * Container for gallery grids. Clicking an image opens the lightbox modal
 * when `onImageClick` is provided. Clickable images are rendered as buttons
 * for keyboard accessibility.
 */
export default function Gallery({ images, onImageClick, ariaLabel = "Gallery" }: GalleryProps) {
    return (
        <section className="gallery" aria-label={ariaLabel}>
            {images.map((img) => {
                const clickable = !!onImageClick;
                return clickable ? (
                    <button key={img.src} type="button" className="gallery__button" onClick={() => onImageClick?.(img)}>
                        <img src={img.src} alt={img.alt} loading="lazy" />
                    </button>
                ) : (
                    <img key={img.src} src={img.src} alt={img.alt} loading="lazy" />
                );
            })}
        </section>
    );
}
