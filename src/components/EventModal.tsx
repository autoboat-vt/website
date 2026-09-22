import { CalendarDays, MapPin, Repeat, X } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { describeRecurrence, type ExpandedOccurrence } from "../lib/discord";
import EventMap from "./EventMap";

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

    const { event, start } = occurrence;
    const recurrence = describeRecurrence(event);

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
                    <X size={18} />
                </button>

                <div className="event-modal__body">
                    <h3 className="event-modal__title">{event.name}</h3>
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
                            {event.location ?? "No location specified"}
                        </span>
                    </div>

                    {event.location && <EventMap location={event.location} />}

                    {event.description && (
                        <p className="event-modal__description">{renderDiscordMarkdown(event.description)}</p>
                    )}
                </div>
            </div>
        </div>
    );
}
