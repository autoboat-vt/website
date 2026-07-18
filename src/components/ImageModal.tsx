import { type MouseEvent, useEffect, useRef } from "react";

interface ImageModalProps {
    src?: string;
    alt?: string;
    onClose: () => void;
}

/**
 * Lightbox modal for image previews. Mirrors the original `.image-modal`
 * behavior: click an image to open, click backdrop / close button / Escape to close.
 */
export default function ImageModal({ src, alt, onClose }: ImageModalProps) {
    const closeBtnRef = useRef<HTMLButtonElement>(null);
    const lastActiveRef = useRef<HTMLElement | null>(null);

    // Focus management + keyboard handling
    useEffect(() => {
        if (!src) return;

        lastActiveRef.current = document.activeElement as HTMLElement | null;
        closeBtnRef.current?.focus();

        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handleKey);

        return () => {
            document.removeEventListener("keydown", handleKey);
            // Restore focus to the element that opened the modal
            lastActiveRef.current?.focus?.();
        };
    }, [src, onClose]);

    if (!src) return null;

    const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
    };

    return (
        <div
            className="image-modal is-open"
            role="dialog"
            aria-modal="true"
            aria-label="Image preview"
            onClick={handleBackdropClick}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onClose();
            }}
        >
            <div className="modal-content">
                <button type="button" className="close-modal" aria-label="Close preview" onClick={onClose} ref={closeBtnRef}>
                    &times;
                </button>
                <img className="modal-image" src={src} alt={alt} />
            </div>
        </div>
    );
}
