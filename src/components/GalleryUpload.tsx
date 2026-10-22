import {
    AlertCircle,
    ArrowUpDown,
    Check,
    ChevronDown,
    ChevronUp,
    EyeOff,
    GripVertical,
    ImagePlus,
    Loader2,
    LogIn,
    LogOut,
    RotateCcw,
    UserKey,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { beginLogin, clearSession, loadSession, ManageError, type ManageSession } from "../lib/eventManage";
import {
    ACCEPT_ATTRIBUTE,
    type GalleryImage as DriveImage,
    fetchGalleryOrder,
    fetchHiddenPhotos,
    GalleryError,
    galleryImageUrl,
    saveGalleryOrder,
    setPhotoHidden,
    uploadImage,
    validateFileLocally,
} from "../lib/galleryClient";
import { completeLoginFromUrl } from "../lib/loginRedirect";

/**
 * Officer upload control for the gallery page.
 *
 * WHY IT REUSES THE CALENDAR'S SESSION. The Worker gates uploads on the same
 * `canCreateEvents` claim the calendar uses (see `worker/src/session.ts`), so an
 * officer signs in once and both write surfaces work. A second login system
 * would mean two tokens, two expiry rules, and two places to get the Discord
 * role check wrong.
 *
 * HOW THE LOGIN COMPLETES HERE. `/gallery/` is registered as its own Discord
 * redirect URI, so the sign-in started from this page comes back to this page
 * with `?code=`. That is deliberately better than bouncing through the calendar:
 * an officer who clicked "Add photos" should land back where they were, not on a
 * different page wondering whether it worked. The exchange itself is shared with
 * the calendar via `loginRedirect.ts` so the single-use code is handled once.
 */

export interface GalleryUploadProps {
    /** Called after a successful upload so the page can refresh its images. */
    onUploaded?: () => void;
}

/** What the panel is currently doing, so the button can be disabled correctly. */
type Status = "idle" | "uploading" | "done";

/**
 * The removed-photos list.
 *
 * WHY IT LIVES IN THIS PANEL: removing a photo and putting it back are the same
 * decision seen from two sides, and both are officer-only. Splitting them across
 * two controls would mean two places to be signed in at, and a restore control
 * nobody would find.
 *
 * WARNING: "Removed" means hidden from this page, NOT deleted. The Drive file is
 * untouched -- the copy here exists purely so removal is reversible.
 */
function RemovedPhotos({
    session,
    hidden,
    onChanged,
}: {
    session: ManageSession;
    hidden: DriveImage[];
    onChanged: () => void;
}) {
    const [restoring, setRestoring] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const headingId = useId();

    if (hidden.length === 0) return null;

    const restore = async (id: string) => {
        setRestoring(id);
        setError(null);
        try {
            await setPhotoHidden(session, id, false);
            onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not restore that photo.");
        } finally {
            setRestoring(null);
        }
    };

    return (
        <section className="gallery-upload__removed" aria-labelledby={headingId}>
            <h4 className="gallery-upload__removed-title" id={headingId}>
                <EyeOff size={14} aria-hidden="true" />
                Removed from the gallery ({hidden.length})
            </h4>
            <p className="gallery-upload__removed-note">
                These are hidden from the public page, not deleted from Drive.
            </p>
            <ul className="gallery-upload__removed-list">
                {hidden.map((image) => (
                    <li key={image.id} className="gallery-upload__removed-item">
                        <img
                            src={galleryImageUrl(image.id)}
                            alt=""
                            loading="lazy"
                            className="gallery-upload__removed-thumb"
                        />
                        <span className="gallery-upload__removed-name">{image.name}</span>
                        <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => restore(image.id)}
                            disabled={restoring !== null}
                        >
                            <RotateCcw size={14} aria-hidden="true" />
                            {restoring === image.id ? "Restoring..." : "Restore"}
                        </button>
                    </li>
                ))}
            </ul>
            {error && (
                <p className="gallery-upload__error" role="alert">
                    <AlertCircle size={14} aria-hidden="true" />
                    {error}
                </p>
            )}
        </section>
    );
}

/**
 * The reorder list: drag to move, or use the arrow buttons.
 *
 * WHY BOTH. Native HTML5 drag-and-drop does not fire on touch devices at all --
 * `dragstart` simply never happens on a phone -- so drag alone would make the
 * list unusable on mobile, which is where officers are most likely to be. The
 * buttons are therefore not a redundant nicety: they are the touch path AND the
 * keyboard path (a `<li>` with `draggable` is not focusable and cannot be
 * dragged from the keyboard). Keeping them also means the list degrades to
 * something usable if a browser suppresses drag.
 *
 * WHY IT SAVES ON EVERY MOVE rather than behind a Save button: the alternative
 * is an officer making several moves and losing them by closing the panel, and
 * "unsaved changes" is a state nobody asked for. Each move writes the full order,
 * which is idempotent, so a retry after a failure is safe.
 */
function ReorderPhotos({
    session,
    photos,
    onChanged,
}: {
    session: ManageSession;
    photos: DriveImage[];
    onChanged: () => void;
}) {
    const [order, setOrder] = useState<DriveImage[]>(photos);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Index being dragged, or null. */
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    /** Index the dragged row is currently hovering over, for the drop indicator. */
    const [overIndex, setOverIndex] = useState<number | null>(null);
    const headingId = useId();

    // The parent refetches the list when something else changes (an upload, a
    // restore), so the local copy has to follow or the panel shows a stale order.
    useEffect(() => {
        setOrder(photos);
    }, [photos]);

    if (photos.length < 2) return null;

    /** Persist a new local order, rolling back on failure. */
    const persist = async (next: DriveImage[]) => {
        const previous = order;
        // Optimistic: apply locally first so the move feels immediate.
        setOrder(next);
        setBusy(true);
        setError(null);
        try {
            await saveGalleryOrder(
                session,
                next.map((image) => image.id),
            );
            // The page's grid has to follow, or the panel and the gallery
            // disagree about the order.
            onChanged();
        } catch (err) {
            setOrder(previous);
            setError(err instanceof Error ? err.message : "Could not save the new order.");
        } finally {
            setBusy(false);
        }
    };

    /** Move the row at `from` to position `to`. */
    const moveTo = (from: number, to: number) => {
        if (busy) return;
        if (from === to) return;
        if (from < 0 || from >= order.length || to < 0 || to >= order.length) return;

        const next = [...order];
        const [moved] = next.splice(from, 1);
        if (moved === undefined) return;
        next.splice(to, 0, moved);
        void persist(next);
    };

    return (
        <section className="gallery-upload__reorder" aria-labelledby={headingId}>
            <h4 className="gallery-upload__reorder-title" id={headingId}>
                <ArrowUpDown size={14} aria-hidden="true" />
                Photo order
            </h4>
            <p className="gallery-upload__reorder-note">
                Drag a photo to reposition it, or use the arrows. First photo appears first on the page; new uploads are
                added at the end.
            </p>
            <ol className="gallery-upload__reorder-list">
                {order.map((image, index) => {
                    const isDragging = dragIndex === index;
                    // Only show a drop line where the drop would actually change
                    // something -- not on the row being dragged, and not when the
                    // target is where it already is.
                    const isDropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;
                    return (
                        <li
                            key={image.id}
                            className={[
                                "gallery-upload__reorder-item",
                                isDragging ? "is-dragging" : "",
                                isDropTarget ? "is-drop-target" : "",
                            ]
                                .filter(Boolean)
                                .join(" ")}
                            draggable={!busy}
                            onDragStart={(event) => {
                                setDragIndex(index);
                                setError(null);
                                // Firefox refuses to start a drag unless some data
                                // is set, and `effectAllowed` is what makes the
                                // cursor read as "move" rather than "copy".
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", image.id);
                            }}
                            onDragOver={(event) => {
                                // preventDefault is what marks this row as a valid
                                // drop target; without it `drop` never fires.
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                // Guarded so the state is only set when the target
                                // actually changes -- `dragover` fires repeatedly
                                // and unguarded setState here causes a re-render
                                // storm while the pointer moves.
                                if (overIndex !== index) setOverIndex(index);
                            }}
                            onDrop={(event) => {
                                event.preventDefault();
                                if (dragIndex !== null) moveTo(dragIndex, index);
                                setDragIndex(null);
                                setOverIndex(null);
                            }}
                            onDragEnd={() => {
                                // Always clear, including on a cancelled drag
                                // (dropped outside the list, or Escape).
                                setDragIndex(null);
                                setOverIndex(null);
                            }}
                        >
                            {/* Drag affordance. Decorative: the row itself is the
                                draggable element and the buttons are the
                                accessible path, so this must not be announced. */}
                            <span className="gallery-upload__reorder-grip" aria-hidden="true">
                                <GripVertical size={14} />
                            </span>
                            <img
                                src={galleryImageUrl(image.id)}
                                alt=""
                                loading="lazy"
                                /* The browser's own drag image is the whole row,
                                   which is a tall strip. A plain image preview is
                                   easier to aim with. */
                                className="gallery-upload__reorder-thumb"
                            />
                            <span className="gallery-upload__reorder-name">
                                <span className="gallery-upload__reorder-index">{index + 1}.</span> {image.name}
                            </span>
                            <div className="gallery-upload__reorder-actions">
                                <button
                                    type="button"
                                    className="btn btn--sm gallery-upload__reorder-btn"
                                    onClick={() => moveTo(index, index - 1)}
                                    disabled={index === 0 || busy}
                                    // The visible glyph is a caret; the accessible
                                    // name has to say WHICH photo moves, because
                                    // "Move up" alone is meaningless out of context.
                                    aria-label={`Move ${image.name} earlier`}
                                >
                                    <ChevronUp size={14} aria-hidden="true" />
                                </button>
                                <button
                                    type="button"
                                    className="btn btn--sm gallery-upload__reorder-btn"
                                    onClick={() => moveTo(index, index + 1)}
                                    disabled={index === order.length - 1 || busy}
                                    aria-label={`Move ${image.name} later`}
                                >
                                    <ChevronDown size={14} aria-hidden="true" />
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ol>
            {error && (
                <p className="gallery-upload__error" role="alert">
                    <AlertCircle size={14} aria-hidden="true" />
                    {error}
                </p>
            )}
        </section>
    );
}

export default function GalleryUpload({ onUploaded }: GalleryUploadProps) {
    const [session, setSession] = useState<ManageSession | null>(() => loadSession());
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<Status>("idle");
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /**
     * A permission refusal from the Worker.
     *
     * Held separately because it renders as an explained block naming the
     * Discord account that was refused, not a one-line red message -- the usual
     * cause is signing in with a personal account instead of the school one.
     */
    const [denied, setDenied] = useState<ManageError | null>(null);
    /**
     * Photos the team has hidden from the public gallery.
     *
     * Held here rather than in the page because restoring is an officer action,
     * and this panel is where officer actions live. `onUploaded` doubles as the
     * "something changed" signal so the page's grid refreshes too.
     */
    const [hidden, setHidden] = useState<DriveImage[]>([]);
    /** The visible photos, in display order, for the reorder list. */
    const [ordered, setOrdered] = useState<DriveImage[]>([]);
    const panelId = useId();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const busy = status === "uploading";

    /** Read the removed-photos list, keeping the previous list on failure. */
    const reloadHidden = useCallback(async (current: ManageSession | null) => {
        if (!current) {
            setHidden([]);
            setOrdered([]);
            return;
        }
        try {
            setHidden(await fetchHiddenPhotos(current));
        } catch {
            // A failed read leaves the list as it was rather than claiming
            // nothing is removed, which would look like the photos came back.
        }
        try {
            setOrdered(await fetchGalleryOrder(current));
        } catch {
            // Same reasoning: a stale list is better than an empty one, which
            // would read as "the gallery has no photos".
        }
    }, []);

    // Fetched when the panel opens, not on mount: an anonymous visitor should
    // not cause a 401 probe.
    useEffect(() => {
        if (open && session) void reloadHidden(session);
    }, [open, session, reloadHidden]);

    // A session that expired while this tab sat open should not present an
    // upload form that will only 401. Re-reading on focus keeps it honest
    // without a timer.
    useEffect(() => {
        const sync = () => setSession(loadSession());
        globalThis.addEventListener?.("focus", sync);
        return () => globalThis.removeEventListener?.("focus", sync);
    }, []);

    /**
     * Finish a login if Discord just redirected back to this page.
     *
     * The panel is opened on success so the officer sees the upload control
     * immediately -- coming back from Discord to a collapsed button would read
     * as "nothing happened".
     */
    useEffect(() => {
        const controller = new AbortController();
        completeLoginFromUrl()
            .then((result) => {
                if (controller.signal.aborted) return;
                switch (result.kind) {
                    case "success":
                        setSession(result.session);
                        setDenied(null);
                        setOpen(true);
                        break;
                    case "denied":
                        setDenied(result.error);
                        setOpen(true);
                        setError(null);
                        break;
                    case "failed":
                        setError(result.message);
                        setOpen(true);
                        break;
                    default:
                        break;
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setStatus("idle");
            });
        return () => controller.abort();
    }, []);

    const handleLogin = useCallback(async () => {
        setError(null);
        setDenied(null);
        try {
            // Navigates away. `/gallery/` is a registered redirect URI, so the
            // browser comes straight back to this page and the effect above
            // finishes the exchange here -- an officer who clicked "Add photos"
            // should land where they were, not on the calendar.
            await beginLogin(undefined, "/gallery/");
        } catch (err) {
            setError(err instanceof ManageError ? err.message : "Could not start the Discord login.");
        }
    }, []);

    const handleLogOut = () => {
        clearSession();
        setSession(null);
        setOpen(false);
        setMessage(null);
        setError(null);
        setDenied(null);
        setStatus("idle");
    };

    const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        // Clear immediately so choosing the SAME file twice still fires a
        // change event -- otherwise a retry after a transient failure does
        // nothing at all.
        event.target.value = "";
        if (!file || !session) return;

        setError(null);
        setMessage(null);
        setDenied(null);

        const localProblem = validateFileLocally(file);
        if (localProblem) {
            setError(localProblem);
            return;
        }

        setStatus("uploading");
        try {
            const result = await uploadImage(session, file);
            setStatus("done");
            setMessage(
                result.mirrored
                    ? `Added "${result.name}".`
                    : `Saved "${result.name}" to Drive. It will appear in a few minutes.`,
            );
            // An upload can un-hide a filename that was previously removed, so
            // the restore list may be stale as well as the grid.
            void reloadHidden(session);
            onUploaded?.();
        } catch (err) {
            setStatus("idle");
            if (err instanceof ManageError) {
                if (err.status === 401) {
                    // Dead token: drop it so the panel offers "sign in" rather
                    // than retrying something that can never succeed.
                    clearSession();
                    setSession(null);
                }
                if (err.remedy !== null) {
                    setDenied(err);
                } else {
                    setError(err.message);
                }
            } else if (err instanceof GalleryError) {
                setError(err.message);
            } else {
                setError("Could not upload that image. Please try again.");
            }
        }
    };

    return (
        <div className="gallery-upload">
            <button
                type="button"
                className="btn btn--sm gallery-upload__toggle"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => {
                    setOpen((wasOpen) => !wasOpen);
                    setMessage(null);
                    setError(null);
                    setDenied(null);
                }}
            >
                <ImagePlus size={16} aria-hidden="true" />
                {session ? "Add photos" : "Officer sign-in"}
            </button>

            {open && (
                <div className="gallery-upload__panel" id={panelId}>
                    <h3 className="gallery-upload__title">
                        {session ? `Add photos as ${session.name}` : "Add photos"}
                    </h3>

                    {!session ? (
                        <>
                            <p className="gallery-upload__intro">
                                Only officers can add photos. Sign in with Discord to continue.
                            </p>
                            {denied && (
                                <div className="gallery-upload__denied" role="alert">
                                    <p className="gallery-upload__denied-title">
                                        <AlertCircle size={15} aria-hidden="true" />
                                        Not allowed
                                    </p>
                                    <p className="gallery-upload__denied-body">{denied.remedy}</p>
                                </div>
                            )}
                            {error && (
                                <p className="gallery-upload__error" role="alert">
                                    <AlertCircle size={14} aria-hidden="true" />
                                    {error}
                                </p>
                            )}
                            <div className="gallery-upload__actions">
                                <button type="button" className="btn btn--sm" onClick={handleLogin}>
                                    <LogIn size={16} aria-hidden="true" />
                                    Sign in with Discord
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <p className="gallery-upload__intro">
                                Photos are added to the team&apos;s Google Drive folder and appear here shortly. JPEG,
                                PNG, WebP, GIF, or AVIF, up to 4.5&nbsp;MB.
                            </p>

                            {denied && (
                                <div className="gallery-upload__denied" role="alert">
                                    <p className="gallery-upload__denied-title">
                                        <AlertCircle size={15} aria-hidden="true" />
                                        Not allowed
                                    </p>
                                    <p className="gallery-upload__denied-body">{denied.remedy}</p>
                                </div>
                            )}

                            <input
                                ref={fileInputRef}
                                type="file"
                                accept={ACCEPT_ATTRIBUTE}
                                className="gallery-upload__file"
                                // Hidden rather than styled: the native control
                                // renders differently on every browser and
                                // cannot be themed, so the visible affordance is
                                // the button below.
                                hidden
                                onChange={handleFile}
                                disabled={busy}
                            />

                            <div className="gallery-upload__actions">
                                <button
                                    type="button"
                                    className="btn btn--sm"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={busy}
                                >
                                    {busy ? (
                                        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                                    ) : (
                                        <UserKey size={16} aria-hidden="true" />
                                    )}
                                    {busy ? "Uploading..." : "Choose a photo"}
                                </button>
                                <button type="button" className="btn btn--sm" onClick={handleLogOut} disabled={busy}>
                                    <LogOut size={16} aria-hidden="true" />
                                    Sign out
                                </button>
                            </div>

                            {/* aria-live so the outcome is announced; the icon and
                                color are only a visual cue. */}
                            {message && (
                                <p className="gallery-upload__notice" role="status" aria-live="polite">
                                    <Check size={14} aria-hidden="true" />
                                    {message}
                                </p>
                            )}
                            {error && (
                                <p className="gallery-upload__error" role="alert">
                                    <AlertCircle size={14} aria-hidden="true" />
                                    {error}
                                </p>
                            )}

                            {/* Renders nothing when there is nothing to reorder
                                (fewer than two visible photos). */}
                            <ReorderPhotos
                                session={session}
                                photos={ordered}
                                onChanged={() => {
                                    void reloadHidden(session);
                                    onUploaded?.();
                                }}
                            />

                            {/* Renders nothing when the list is empty, so the
                                panel does not grow a permanently-empty section. */}
                            <RemovedPhotos
                                session={session}
                                hidden={hidden}
                                onChanged={() => {
                                    void reloadHidden(session);
                                    // The grid has to re-render: a restored photo
                                    // reappears, and a photo hidden from the
                                    // lightbox has to stop being offered.
                                    onUploaded?.();
                                }}
                            />
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
