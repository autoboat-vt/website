import { AlertCircle, EyeOff, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import GalleryUpload from "../components/GalleryUpload";
import ImageModal from "../components/ImageModal";
import { loadSession, ManageError, type ManageSession } from "../lib/eventManage";
import {
    type GalleryImage as DriveImage,
    fetchGalleryManifest,
    type GalleryManifest,
    galleryImageUrl,
    setPhotoHidden,
} from "../lib/galleryClient";
import { ALL_GALLERY_IMAGES } from "../lib/galleryImages";
import { buildGalleryTiles, galleryStatusNote } from "../lib/galleryView";

/**
 * The public gallery.
 *
 * TWO SOURCES, ONE GRID. The curated photos in `src/lib/galleryImages.ts` are
 * part of the site's design and ship with the build. Everything else comes from
 * a Google Drive folder, resolved at runtime -- that is what lets officers add a
 * photo without a redeploy. They are merged here, Drive photos first.
 *
 * WHY A FAILED FETCH IS NOT AN ERROR PAGE. The curated photos are always
 * available, and they are a perfectly good gallery on their own. So a Drive
 * outage degrades to the curated set plus a short note rather than replacing the
 * page with an error. That also means this page cannot be "broken" by a Worker
 * problem -- which matters because the Worker is a different origin.
 */
export default function Gallery() {
    const [modalImage, setModalImage] = useState<{
        src: string;
        alt: string;
        caption?: string;
        driveId?: string;
    } | null>(null);
    const [manifest, setManifest] = useState<GalleryManifest | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    /** Bumped to re-run the fetch after an upload or a hide. */
    const [reloadToken, setReloadToken] = useState(0);
    /**
     * The current officer session, if any.
     *
     * Re-read on focus so a session that expired while the tab sat open stops
     * offering actions that would only 401.
     */
    const [session, setSession] = useState<ManageSession | null>(() => loadSession());
    /** Set while a hide request is in flight, to disable the button. */
    const [hiding, setHiding] = useState(false);
    /** A failed hide, shown inside the lightbox rather than replacing the page. */
    const [hideError, setHideError] = useState<string | null>(null);

    useEffect(() => {
        const sync = () => setSession(loadSession());
        globalThis.addEventListener?.("focus", sync);
        return () => globalThis.removeEventListener?.("focus", sync);
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        let active = true;

        setLoading(true);
        fetchGalleryManifest(controller.signal)
            .then((next) => {
                if (!active) return;
                setManifest(next);
                setLoadError(null);
            })
            .catch((err: unknown) => {
                if (!active) return;
                // An aborted request is this effect cleaning up, not a failure.
                if (err instanceof Error && err.name === "AbortError") return;
                setLoadError(err instanceof Error ? err.message : "Could not load photos from Google Drive.");
            })
            .finally(() => {
                if (active) setLoading(false);
            });

        return () => {
            active = false;
            controller.abort();
        };
    }, [reloadToken]);

    const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

    /**
     * Take the open photo off the public gallery.
     *
     * WARNING: HIDES, DOES NOT DELETE. The Drive file and its mirror stay put; the
     * photo can be restored with the "Add photos" panel. That is why there is no
     * confirmation dialog -- undoing it costs one click, so a modal would be
     * friction without protection.
     */
    const hideCurrent = useCallback(async () => {
        const driveId = modalImage?.driveId;
        if (!session || !driveId) return;
        setHiding(true);
        setHideError(null);
        try {
            await setPhotoHidden(session, driveId, true);
            setModalImage(null);
            refresh();
        } catch (err) {
            if (err instanceof ManageError && err.status === 401) {
                // Dead token: stop offering the action rather than retrying it.
                setSession(null);
            }
            setHideError(err instanceof Error ? err.message : "Could not remove that photo.");
        } finally {
            setHiding(false);
        }
    }, [modalImage, session, refresh]);

    const tiles = useMemo(() => {
        const drive: DriveImage[] = manifest?.images ?? [];
        return buildGalleryTiles(drive, ALL_GALLERY_IMAGES, galleryImageUrl);
    }, [manifest]);

    const statusNote = manifest ? galleryStatusNote(manifest.pending, manifest.warning) : null;
    const driveCount = manifest?.images.length ?? 0;

    return (
        <>
            {/* mt-14 (56px) puts the title at roughly the same distance below
                the nav as the first Card on the sibling pages (~56-115px).
                It sat at 24px with the old mt-6, which read as cramped against
                the header. */}
            <div className="mx-4 mt-14 mb-8 text-center">
                {/* sr-only: the visible "Gallery" text below is a section
                    heading (h2). Every page needs exactly one h1 for its
                    document outline, and this page's title is really the
                    same word, so an outline-only h1 avoids duplicating it
                    on screen. */}
                <h1 className="sr-only">Gallery</h1>
                <h2 className="font-heading text-[clamp(22px,3vw,36px)] font-extrabold">Gallery</h2>

                {/* The upload control sits with the heading rather than in the
                    nav: it is officer-only and useless to a visitor, so it
                    belongs on the page it acts on. It renders the sign-in
                    affordance for everyone -- the Worker is the gate, and
                    hiding it would leave an officer unable to discover it. */}
                <div className="mt-4 flex justify-center">
                    <GalleryUpload onUploaded={refresh} />
                </div>
                {statusNote && (
                    <p className="gallery-status" role="status" aria-live="polite">
                        <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                        {statusNote}
                    </p>
                )}
                {loadError && (
                    <p className="gallery-status gallery-status--error" role="status">
                        <AlertCircle size={14} aria-hidden="true" />
                        {loadError} Showing the team&apos;s featured photos.
                    </p>
                )}
            </div>
            {/* Two columns on mobile (matching the Our Team gallery) rather
                than one: the list is ~38 photos, and a single full-width
                column turns the page into an ~11,000px scroll. */}
            <div className="photo-container mx-auto grid max-w-275 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 px-4 pb-50 max-[620px]:grid-cols-2 max-[620px]:gap-2">
                {tiles.map((photo) => (
                    <button
                        key={photo.key}
                        type="button"
                        className="group block cursor-pointer border-none bg-none p-0 m-0 focus-visible:rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fontcolor"
                        onClick={() => {
                            setHideError(null);
                            setModalImage({
                                src: photo.src,
                                alt: photo.alt,
                                caption: photo.caption,
                                driveId: photo.driveId,
                            });
                        }}
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

            {/* The Drive-loading state lives BELOW the grid so the curated
                photos paint immediately instead of waiting on the Worker. */}
            {loading && driveCount === 0 && (
                <p className="gallery-status" role="status">
                    <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                    Loading photos from Google Drive...
                </p>
            )}

            <ImageModal
                src={modalImage?.src}
                alt={modalImage?.alt}
                caption={modalImage?.caption}
                onClose={() => {
                    setHideError(null);
                    setModalImage(null);
                }}
                actions={
                    // Only for a signed-in officer looking at a DRIVE photo. A
                    // curated tile has no `driveId`, so there is nothing the
                    // endpoint could hide.
                    session && modalImage?.driveId ? (
                        <>
                            <button
                                type="button"
                                className="btn btn--sm image-modal__action"
                                onClick={hideCurrent}
                                disabled={hiding}
                            >
                                <EyeOff size={15} aria-hidden="true" />
                                {hiding ? "Removing..." : "Remove from gallery"}
                            </button>
                            {hideError && (
                                <p className="image-modal__error" role="alert">
                                    {hideError}
                                </p>
                            )}
                        </>
                    ) : null
                }
            />
        </>
    );
}
