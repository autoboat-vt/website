import { AlertCircle, EyeOff, GripVertical, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GalleryUpload from "../components/GalleryUpload";
import ImageModal from "../components/ImageModal";
import { loadSession, ManageError, type ManageSession } from "../lib/eventManage";
import {
    type GalleryImage as DriveImage,
    fetchGalleryManifest,
    type GalleryManifest,
    galleryImageUrl,
    saveGalleryOrder,
    setPhotoHidden,
} from "../lib/galleryClient";
import { ALL_GALLERY_IMAGES } from "../lib/galleryImages";
import { applyTileOrder, buildGalleryTiles, driveIdsOf, galleryStatusNote, moveWithin } from "../lib/galleryView";

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
    /**
     * The officer's drag-to-reorder state.
     *
     * Only DEFINES behaviour when a session exists -- a visitor's tiles are not
     * draggable at all, so these stay null for them.
     */
    const [dragKey, setDragKey] = useState<string | null>(null);
    const [overKey, setOverKey] = useState<string | null>(null);
    /** A failed order save, shown above the grid. */
    const [orderError, setOrderError] = useState<string | null>(null);
    /**
     * When the last drag ended, in epoch ms.
     *
     * WARNING: A state flag cannot do this job. `dragEnd` clears the drag state and
     * the browser then dispatches `click`, so by the time the click handler runs
     * the drag looks long finished -- an `if (dragKey) return` guard is dead
     * code. A short time window is the only reliable signal, and it must be a
     * ref: storing it in state would re-render the grid on every drag for a
     * value only the click handler reads.
     */
    const lastDragEndRef = useRef(0);
    /**
     * Set while a reorder save is in flight.
     *
     * Deliberately NOT used to disable the whole grid: the save is optimistic, so
     * the officer keeps dragging and each drop supersedes the last. Blocking
     * input here would make a slow connection feel broken.
     */
    const [savingOrder, setSavingOrder] = useState(false);

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
    /**
     * A local override of the tile order, applied while a drag is being saved.
     *
     * WHY IT EXISTS. The grid is derived from `manifest`, and a refetch after a
     * save takes a round trip -- during which the photos would snap back to the
     * old order and then jump again. Holding the reordered list here keeps the
     * drop looking instant. It is cleared whenever a fresh manifest arrives.
     */
    const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

    // A new manifest supersedes any local override, so the page converges on the
    // server's answer rather than a stale optimistic one.
    useEffect(() => {
        setPendingOrder(null);
    }, [manifest]);

    const renderedTiles = useMemo(() => {
        if (pendingOrder === null) return tiles;
        return applyTileOrder(tiles, pendingOrder);
    }, [tiles, pendingOrder]);

    /**
     * Reorder by dragging one photo onto another.
     *
     * Only Drive photos move, and only for a signed-in officer. A visitor's tiles
     * are not draggable (see the grid markup), so this cannot be reached without
     * a session -- and the Worker checks the token again on the write anyway.
     */
    const reorderTo = useCallback(
        (fromKey: string, toKey: string) => {
            if (!session || fromKey === toKey) return;

            const fromIndex = renderedTiles.findIndex((tile) => tile.key === fromKey);
            const toIndex = renderedTiles.findIndex((tile) => tile.key === toKey);
            if (fromIndex < 0 || toIndex < 0) return;
            // Dropping onto a curated tile would put a photo into a section the
            // server cannot reorder, so it is ignored rather than silently
            // saved as a no-op.
            if (!renderedTiles[fromIndex]?.driveId || !renderedTiles[toIndex]?.driveId) return;

            const next = moveWithin(renderedTiles, fromIndex, toIndex);
            const ids = driveIdsOf(next);
            setPendingOrder(ids);
            setOrderError(null);
            setSavingOrder(true);

            saveGalleryOrder(session, ids)
                .then(() => {
                    // Refetch so the manifest (and therefore every other viewer)
                    // reflects the new order, then drop the local override.
                    refresh();
                })
                .catch((err: unknown) => {
                    // Roll back to the server's order: showing a saved-looking
                    // arrangement that was not stored is worse than a jump.
                    setPendingOrder(null);
                    setOrderError(err instanceof Error ? err.message : "Could not save the new order.");
                })
                .finally(() => setSavingOrder(false));
        },
        [renderedTiles, session, refresh],
    );

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
                {/* Only an officer can reorder, so only an officer is told they
                    can. Showing this to a visitor would advertise a control that
                    does nothing. */}
                {session && driveCount > 1 && (
                    <p className="gallery-status gallery-status--hint" role="note">
                        <GripVertical size={14} aria-hidden="true" />
                        Drag a photo to reorder the gallery.
                        {savingOrder ? " Saving..." : ""}
                    </p>
                )}
                {orderError && (
                    <p className="gallery-status gallery-status--error" role="alert">
                        <AlertCircle size={14} aria-hidden="true" />
                        {orderError}
                    </p>
                )}
            </div>
            {/* Two columns on mobile (matching the Our Team gallery) rather
                than one: the list is ~38 photos, and a single full-width
                column turns the page into an ~11,000px scroll. */}
            <div className="photo-container mx-auto grid max-w-275 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 px-4 pb-50 max-[620px]:grid-cols-2 max-[620px]:gap-2">
                {renderedTiles.map((photo) => {
                    // Only DRIVE tiles are draggable, and only for an officer.
                    // A curated photo is part of the site's design and has no
                    // server-side position to change, so making it draggable
                    // would promise something the save cannot honour.
                    const canReorder = Boolean(session && photo.driveId);
                    const isDragging = dragKey === photo.key;
                    const isDropTarget = overKey === photo.key && dragKey !== null && dragKey !== photo.key;

                    return (
                        <button
                            key={photo.key}
                            type="button"
                            draggable={canReorder}
                            className={[
                                "group block cursor-pointer border-none bg-none p-0 m-0 focus-visible:rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fontcolor",
                                canReorder ? "gallery-tile--draggable" : "",
                                isDragging ? "gallery-tile--dragging" : "",
                                isDropTarget ? "gallery-tile--drop-target" : "",
                            ]
                                .filter(Boolean)
                                .join(" ")}
                            onDragStart={(event) => {
                                if (!canReorder) return;
                                setDragKey(photo.key);
                                setOrderError(null);
                                // Firefox will not start a drag without data, and
                                // `effectAllowed` is what makes the cursor read as
                                // "move" instead of "copy".
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", photo.driveId ?? "");
                            }}
                            onDragOver={(event) => {
                                if (!canReorder || dragKey === null) return;
                                // preventDefault is what marks the tile a valid
                                // drop target; without it `drop` never fires.
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                // Guarded: dragover fires continuously, and an
                                // unguarded setState re-renders the whole grid on
                                // every pointer move.
                                if (overKey !== photo.key) setOverKey(photo.key);
                            }}
                            onDrop={(event) => {
                                if (!canReorder) return;
                                event.preventDefault();
                                if (dragKey !== null) reorderTo(dragKey, photo.key);
                                setDragKey(null);
                                setOverKey(null);
                            }}
                            onDragEnd={() => {
                                // Always clear, including a cancelled drag (Escape,
                                // or dropped outside the grid) -- a stuck
                                // highlight makes the page look broken.
                                setDragKey(null);
                                setOverKey(null);
                                // Record the end so the click that follows a drag
                                // can be ignored. See `lastDragEndRef`.
                                lastDragEndRef.current = Date.now();
                            }}
                            onClick={() => {
                                // A drag is usually followed by a click, which
                                // would pop the lightbox for the photo the
                                // officer just moved. The window is short enough
                                // that a deliberate click is never swallowed.
                                if (Date.now() - lastDragEndRef.current < 250) return;
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
                                    /* A dragged image intercepts the browser's own
                                       drag preview without this. */
                                    draggable={false}
                                    className="block aspect-4/3 w-full object-cover transition-[transform,box-shadow] duration-300 group-hover:scale-[1.04] group-hover:shadow-[0_8px_16px_rgba(0,0,0,0.12)] dark:group-hover:shadow-[0_8px_16px_rgba(0,0,0,0.3)]"
                                />
                            </div>
                        </button>
                    );
                })}
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
