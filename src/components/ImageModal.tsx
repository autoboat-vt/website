import { type MouseEvent, useEffect, useRef, useState } from "react";

interface ImageModalProps {
    src?: string;
    alt?: string;
    onClose: () => void;
}

/**
 * Lightbox modal for image previews. Mirrors the original `.image-modal`
 * behavior: click an image to open, click backdrop / close button / Escape to close.
 *
 * The `is-open` class is toggled (rather than always applied) so the opacity
 * transition actually plays on close. A short delay before unmount lets the
 * fade-out finish.
 */
export default function ImageModal({ src, alt, onClose }: ImageModalProps) {
    const closeBtnRef = useRef<HTMLButtonElement>(null);
    const lastActiveRef = useRef<HTMLElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [mounted, setMounted] = useState(false);

    // Mount/unmount with a delay to allow the close transition to play
    useEffect(() => {
        if (src) {
            setMounted(true);
            // Defer is-open to next frame so the enter transition plays
            const raf = requestAnimationFrame(() => setIsOpen(true));
            return () => cancelAnimationFrame(raf);
        }
        setIsOpen(false);
        if (mounted) {
            const t = setTimeout(() => setMounted(false), 200);
            return () => clearTimeout(t);
        }
    }, [src, mounted]);

    // Focus management + keyboard handling (active only while open)
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
            lastActiveRef.current?.focus?.();
        };
    }, [src, onClose]);

    if (!mounted) return null;

    const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
    };

    return (
        <div
            className={`image-modal${isOpen ? " is-open" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label="Image preview"
            onClick={handleBackdropClick}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onClose();
            }}
        >
            <div className="relative max-h-[85vh] max-w-[90vw]">
                <button
                    type="button"
                    className="absolute -top-10 right-0 cursor-pointer border-0 bg-transparent text-3xl leading-none text-white"
                    aria-label="Close preview"
                    onClick={onClose}
                    ref={closeBtnRef}
                >
                    &times;
                </button>
                <img className="max-h-[85vh] w-full rounded-lg object-contain" src={src} alt={alt} />
            </div>
        </div>
    );
}
