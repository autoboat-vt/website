import { AlertCircle, Check, ImagePlus, Loader2, LogIn, LogOut, UserKey } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { beginLogin, clearSession, loadSession, ManageError, type ManageSession } from "../lib/eventManage";
import { ACCEPT_ATTRIBUTE, GalleryError, uploadImage, validateFileLocally } from "../lib/galleryClient";
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
    const panelId = useId();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const busy = status === "uploading";

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
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
