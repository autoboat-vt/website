import { Ban, CalendarDays, ExternalLink, Loader2, MapPin, Repeat, Trash2, X } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { describeRecurrence, type ExpandedOccurrence, isLocationUrl } from "../lib/discord";
import { deleteEvent, loadSession, ManageError, type ManageSession } from "../lib/eventManage";
import EventMap from "./EventMap";

interface EventModalProps {
    occurrence: ExpandedOccurrence | null;
    onClose: () => void;
    /** Called after a successful delete so the page can refresh its events. */
    onDeleted?: () => void;
}

function formatLongDate(d: Date): string {
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function formatTime(d: Date): string {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Render Discord **bold** markdown as <strong>, escaping everything else. */
function renderDiscordMarkdown(text: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    let rest = text;
    let key = 0;
    while (rest.length > 0) {
        const m = /\*\*(.+?)\*\*/.exec(rest);
        if (!m) {
            out.push(rest);
            break;
        }
        if (m.index > 0) out.push(rest.slice(0, m.index));
        out.push(<strong key={key++}>{m[1]}</strong>);
        rest = rest.slice(m.index + m[0].length);
    }
    return out;
}

export default function EventModal({ occurrence, onClose, onDeleted }: EventModalProps) {
    const closeBtnRef = useRef<HTMLButtonElement>(null);
    const lastActiveRef = useRef<HTMLElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [mounted, setMounted] = useState(false);

    /**
     * The signed-in officer, or null.
     *
     * Read once on mount rather than threaded down from the page: the session
     * is only needed by this control, and a page-level prop would make every
     * calendar render depend on the management module.
     */
    const [session] = useState<ManageSession | null>(() => loadSession());
    /** The confirmation step. Deleting is irreversible, so it takes two clicks. */
    const [confirming, setConfirming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    // Opening a different event must not inherit the previous one's pending
    // confirmation -- otherwise a second click could delete the wrong event.
    // Keyed on the event id alone: the handlers are stable and must not retrigger
    // this reset.
    const currentEventId = occurrence?.event.id;
    useEffect(() => {
        setConfirming(false);
        setDeleting(false);
        setDeleteError(null);
    }, [currentEventId]);

    // Mirror ImageModal's two-phase mount so enter/exit transitions play.
    useEffect(() => {
        if (occurrence) {
            setMounted(true);
            const raf = requestAnimationFrame(() => setIsOpen(true));
            return () => cancelAnimationFrame(raf);
        }
        setIsOpen(false);
        if (mounted) {
            const t = setTimeout(() => setMounted(false), 200);
            return () => clearTimeout(t);
        }
    }, [occurrence, mounted]);

    useEffect(() => {
        if (!occurrence) return;

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
    }, [occurrence, onClose]);

    if (!mounted || !occurrence) return null;

    const { event, start } = occurrence;
    const recurrence = describeRecurrence(event);
    // Two independent notions of cancelled: this occurrence alone (from the
    // description's `Cancelled:` note) vs. the whole series (Discord status).
    // Both deserve a notice so the modal never shows a cancelled meeting as
    // if it were still on.
    const isCancelled = occurrence.isCancelled || event.status === "canceled";
    const cancelLabel = event.status === "canceled" ? "This event was cancelled" : "This occurrence was cancelled";

    const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
    };

    const handleDelete = async () => {
        if (!session) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteEvent(session, event.id);
            onDeleted?.();
            onClose();
        } catch (err) {
            setDeleting(false);
            setConfirming(false);
            setDeleteError(
                err instanceof ManageError
                    ? (err.remedy ?? err.message)
                    : "Could not delete the event. Please try again.",
            );
        }
    };

    return (
        <div
            className={`event-modal${isOpen ? " is-open" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={event.name}
            onClick={handleBackdropClick}
            onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) onClose();
            }}
        >
            <div className="event-modal__panel">
                <button
                    type="button"
                    className="event-modal__close"
                    aria-label="Close"
                    onClick={onClose}
                    ref={closeBtnRef}
                >
                    <X size={18} />
                </button>

                <div className="event-modal__body">
                    <h3 className="event-modal__title">{event.name}</h3>
                    {isCancelled && (
                        <p className="event-modal__cancelled" role="status">
                            <Ban size={15} aria-hidden="true" />
                            {cancelLabel}
                        </p>
                    )}
                    <div className="event-modal__meta">
                        <span className="event-modal__meta-row">
                            <CalendarDays size={15} className="event-modal__meta-icon" aria-hidden="true" />
                            {formatLongDate(start)} at {formatTime(start)}
                        </span>
                        {recurrence && (
                            <span className="event-modal__meta-row">
                                <Repeat size={15} className="event-modal__meta-icon" aria-hidden="true" />
                                {recurrence}
                            </span>
                        )}
                        <span className="event-modal__meta-row">
                            <MapPin size={15} className="event-modal__meta-icon" aria-hidden="true" />
                            {event.location == null ? (
                                "No location specified"
                            ) : isLocationUrl(event.location) ? (
                                // A link (Zoom room, Discord channel, Maps pin).
                                // Rendering it as an anchor beats geocoding it,
                                // which could never resolve.
                                <a
                                    href={event.location}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="event-modal__location-link"
                                >
                                    {event.location}
                                    <ExternalLink size={12} aria-hidden="true" />
                                    <span className="sr-only"> (opens in a new tab)</span>
                                </a>
                            ) : (
                                event.location
                            )}
                        </span>
                    </div>

                    {/* Only a physical place gets a map; a link renders as an
                        anchor in the row above instead. */}
                    {event.location && !isLocationUrl(event.location) && <EventMap location={event.location} />}

                    {event.description && (
                        <p className="event-modal__description">{renderDiscordMarkdown(event.description)}</p>
                    )}

                    {/* Officer-only. Rendered only for a signed-in session, so a
                        visitor never sees a control that can only fail; the
                        Worker is still the gate (see worker/src/permissions.ts). */}
                    {session && (
                        <div className="event-modal__manage">
                            {deleteError && (
                                <p className="event-modal__delete-error" role="alert">
                                    {deleteError}
                                </p>
                            )}
                            {confirming ? (
                                <div className="event-modal__confirm">
                                    <p className="event-modal__confirm-text">
                                        {/* A recurring record is ONE Discord event, so this
                                            removes the whole series, not just the
                                            occurrence that was clicked. */}
                                        {recurrence
                                            ? "Delete this event and every occurrence of it? This cannot be undone."
                                            : "Delete this event? This cannot be undone."}
                                    </p>
                                    <div className="event-modal__confirm-actions">
                                        <button
                                            type="button"
                                            className="btn btn--sm event-modal__danger"
                                            onClick={handleDelete}
                                            disabled={deleting}
                                        >
                                            {deleting ? (
                                                <Loader2 className="animate-spin" size={14} aria-hidden="true" />
                                            ) : (
                                                <Trash2 size={14} aria-hidden="true" />
                                            )}
                                            {deleting ? "Deleting..." : "Yes, delete"}
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn--sm"
                                            onClick={() => setConfirming(false)}
                                            disabled={deleting}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    className="btn btn--sm event-modal__delete"
                                    onClick={() => setConfirming(true)}
                                >
                                    <Trash2 size={14} aria-hidden="true" />
                                    Delete event
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
