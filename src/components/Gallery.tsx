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
        <section className="gallery mt-6 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" aria-label={ariaLabel}>
            {images.map((img) => {
                const clickable = !!onImageClick;
                return clickable ? (
                    <button
                        key={img.src}
                        type="button"
                        className="block cursor-zoom-in border-none bg-none p-0 m-0 focus-visible:rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fontcolor"
                        onClick={() => onImageClick?.(img)}
                    >
                        <img
                            src={img.src}
                            alt={img.alt}
                            loading="lazy"
                            className="block aspect-4/3 w-full rounded-lg object-cover transition-[transform,box-shadow] duration-300 hover:scale-[1.04] hover:shadow-[0_8px_16px_rgba(0,0,0,0.12)] dark:hover:shadow-[0_8px_16px_rgba(0,0,0,0.3)]"
                        />
                    </button>
                ) : (
                    <img
                        key={img.src}
                        src={img.src}
                        alt={img.alt}
                        loading="lazy"
                        className="block aspect-4/3 w-full rounded-lg object-cover transition-[transform,box-shadow] duration-300 hover:scale-[1.04] hover:shadow-[0_8px_16px_rgba(0,0,0,0.12)] dark:hover:shadow-[0_8px_16px_rgba(0,0,0,0.3)]"
                    />
                );
            })}
        </section>
    );
}
