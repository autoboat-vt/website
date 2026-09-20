import { CalendarPlus, Check, ChevronDown, Copy, Link as LinkIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { FaCalendar } from "react-icons/fa6";
import { EVENTS_ICS_URL, webcalUrl } from "../lib/discord";

/**
 * "Subscribe" affordance for the calendar page.
 *
 * The events come from Discord, but there's no way to add a Discord
 * scheduled-events list to a personal calendar. The Worker publishes the same
 * events as an iCalendar feed (`GET /calendar.ics`), and this panel offers
 * the two ways to consume it:
 *
 *  - `webcals://` -> hands the URL to the OS calendar app (Apple Calendar,
 *                    Outlook desktop). This is a true *subscription*: the app
 *                    re-fetches the feed on its own schedule.
 *  - Copy / download the feed URL, for every other client (Google Calendar,
 *                    Thunderbird, Fastmail, Proton, ...) that takes a URL.
 *
 * There is deliberately no Google or Outlook deep link: Google's
 * `calendar/render?cid=` handler is broken for external feeds (Google support
 * confirmed users must add via Settings > Add calendar > From URL instead),
 * and Outlook's addfromweb endpoint is similarly unreliable. Users of those
 * apps paste the feed URL from the row below instead.
 */

/** The single provider card: the OS calendar handler. */
interface Provider {
    key: string;
    href: string;
    label: string;
    hint: string;
    icon: React.ComponentType<{ size?: number }>;
    testId?: string;
}

export default function CalendarSubscribe() {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const panelId = useId();
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        };
    }, []);

    /**
     * Copy the feed URL to the clipboard. Returns whether the copy succeeded
     * so the caller can decide whether to show the "Copied" confirmation.
     */
    const copyFeedUrl = async (): Promise<boolean> => {
        try {
            // navigator.clipboard is undefined on insecure origins (http://)
            // and in jsdom; fall back to a hidden textarea + execCommand so
            // the button still works in those environments.
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(EVENTS_ICS_URL);
            } else {
                const textarea = document.createElement("textarea");
                textarea.value = EVENTS_ICS_URL;
                textarea.setAttribute("readonly", "");
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand("copy");
                document.body.removeChild(textarea);
            }
            return true;
        } catch {
            // Clipboard permission denied. Callers fall back to showing the
            // URL for manual copying rather than surfacing an error.
            return false;
        }
    };

    const flashCopied = () => {
        setCopied(true);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    };

    const handleCopy = async () => {
        if (await copyFeedUrl()) flashCopied();
    };

    const providers: Provider[] = [
        {
            key: "webcal",
            href: webcalUrl(),
            label: "Open in your calendar app",
            hint: "Outlook, Thunderbird, Apple Calendar, etc.",
            icon: FaCalendar,
            testId: "subscribe-webcal",
        },
    ];

    return (
        <div className={`calendar-subscribe${open ? " calendar-subscribe--open" : ""}`}>
            <button
                type="button"
                className="btn btn--sm calendar-subscribe__toggle"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen((v) => !v)}
            >
                <CalendarPlus size={16} aria-hidden="true" />
                Subscribe
                <ChevronDown size={15} className="calendar-subscribe__chevron" aria-hidden="true" />
            </button>

            {open && (
                <div className="calendar-subscribe__panel" id={panelId}>
                    <div className="calendar-subscribe__header">
                        <h3 className="calendar-subscribe__title">Subscribe to this calendar</h3>
                        <p className="calendar-subscribe__intro">
                            Add the AutoBoat calendar to your own calendar app. It updates automatically as events
                            change in Discord.
                        </p>
                    </div>

                    <div className="calendar-subscribe__providers">
                        {providers.map((p) => {
                            const Icon = p.icon;
                            return (
                                <a
                                    key={p.key}
                                    className="calendar-subscribe__provider"
                                    href={p.href}
                                    data-testid={p.testId}
                                >
                                    <span className="calendar-subscribe__provider-icon" aria-hidden="true">
                                        <Icon size={17} />
                                    </span>
                                    <span className="calendar-subscribe__provider-text">
                                        <span className="calendar-subscribe__provider-label">{p.label}</span>
                                        <span className="calendar-subscribe__provider-hint">{p.hint}</span>
                                    </span>
                                </a>
                            );
                        })}
                    </div>

                    <div className="calendar-subscribe__divider">
                        <span>or add it by URL</span>
                    </div>

                    <div className="calendar-subscribe__url-row">
                        <LinkIcon size={14} aria-hidden="true" className="calendar-subscribe__url-icon" />
                        <code className="calendar-subscribe__url">{EVENTS_ICS_URL}</code>
                        <button
                            type="button"
                            className="calendar-subscribe__copy"
                            onClick={handleCopy}
                            aria-label={copied ? "Feed URL copied" : "Copy feed URL"}
                        >
                            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                            <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
                        </button>
                    </div>

                    <div className="calendar-subscribe__footer">
                        <a className="calendar-subscribe__download" href={EVENTS_ICS_URL} download="autoboat.ics">
                            Download .ics
                        </a>
                        <p className="calendar-subscribe__hint">
                            In Google Calendar, Thunderbird, or another app, choose "Add calendar from URL" (Google:
                            Settings &gt; Add calendar &gt; From URL) and paste this link.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
