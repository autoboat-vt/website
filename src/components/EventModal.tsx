import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { CalendarEvent, ExpandedOccurrence } from "../lib/discord";
import { discordEventUrl } from "../lib/discord";

interface EventModalProps {
    occurrence: ExpandedOccurrence | null;
    onClose: () => void;
}

function formatLongDate(d: Date): string {
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function formatTime(d: Date): string {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatTimeRange(start: Date, end: Date): string {
    if (end.getTime() === start.getTime()) return formatTime(start);
    return `${formatTime(start)} - ${formatTime(end)}`;
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

function statusLabel(status: CalendarEvent["status"]): string {
    switch (status) {
        case "scheduled":
            return "Scheduled";
        case "active":
            return "Happening now";
        case "completed":
            return "Completed";
        case "canceled":
            return "Canceled";
    }
}

export default function EventModal({ occurrence, onClose }: EventModalProps) {
    const closeBtnRef = useRef<HTMLButtonElement>(null);
    const lastActiveRef = useRef<HTMLElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [mounted, setMounted] = useState(false);

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

    const { event, start, end } = occurrence;

    const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
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
                    &times;
                </button>

                {event.image && <img className="event-modal__image" src={event.image} alt="" />}

                <div className="event-modal__body">
                    <h3 className="event-modal__title">{event.name}</h3>
                    <div className="event-modal__meta">
                        <span className="event-modal__date">{formatLongDate(start)}</span>
                        <span className="event-modal__time">{formatTimeRange(start, end)}</span>
                    </div>

                    <div className="event-modal__badges">
                        <span className={`event-modal__badge event-modal__badge--${event.status}`}>
                            {statusLabel(event.status)}
                        </span>
                        {event.isRecurring && <span className="event-modal__badge">Recurring</span>}
                        {event.location && (
                            <span className="event-modal__badge event-modal__badge--location">{event.location}</span>
                        )}
                        {event.userCount != null && (
                            <span className="event-modal__badge">{event.userCount} interested</span>
                        )}
                    </div>

                    {event.description && (
                        <p className="event-modal__description">{renderDiscordMarkdown(event.description)}</p>
                    )}

                    <div className="event-modal__actions">
                        <a
                            className="btn btn--primary btn-sm"
                            href={discordEventUrl(event)}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Open in Discord
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                    </div>
                </div>
            </div>
        </div>
    );
}
