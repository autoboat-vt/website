import { AlertCircle, Check, EyeOff, ImagePlus, Loader2, LogIn, LogOut, RotateCcw, UserKey } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { beginLogin, clearSession, loadSession, ManageError, type ManageSession } from "../lib/eventManage";
import {
    ACCEPT_ATTRIBUTE,
    type GalleryImage as DriveImage,
    fetchHiddenPhotos,
    GalleryError,
    galleryImageUrl,
    setPhotoHidden,
    uploadImage,
    validateFileLocally,
} from "../lib/galleryClient";
import { toWebp } from "../lib/imageConvert";
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
    const panelId = useId();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const busy = status === "uploading";

    /** Read the removed-photos list, keeping the previous list on failure. */
    const reloadHidden = useCallback(async (current: ManageSession | null) => {
        if (!current) {
            setHidden([]);
            return;
        }
        try {
            setHidden(await fetchHiddenPhotos(current));
        } catch {
            // A failed read leaves the list as it was rather than claiming
            // nothing is removed, which would look like the photos came back.
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
     * WARNING: a SUCCESSFUL login leaves the panel closed. It used to open it,
     * which the officer never asked for -- they clicked "Officer sign-in", and
     * expanding the upload form on the way back reads as the "Add photos"
     * button having been clicked for them. The confirmation they get instead is
     * the toggle's own label, which flips from "Officer sign-in" to "Add
     * photos"; the form waits to be asked for.
     *
     * A refusal or a failed exchange still opens it, because those messages have
     * nowhere else to render -- a silent refusal would look like the login did
     * nothing at all.
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
            // Convert BEFORE uploading, so the Drive copy and the R2 mirror are
            // both WebP. A failed conversion returns the original, which is why
            // this cannot block the upload.
            const converted = await toWebp(file);
            const result = await uploadImage(session, converted.file);
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
