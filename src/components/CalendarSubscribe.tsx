import { CalendarPlus, Check, ChevronDown, Copy, Link as LinkIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { FaApple, FaGoogle, FaMicrosoft } from "react-icons/fa6";
import { EVENTS_ICS_URL, googleCalendarSubscribeUrl, outlookSubscribeUrl, webcalUrl } from "../lib/discord";

/**
 * "Subscribe" affordance for the calendar page.
 *
 * The events themselves come from Discord, but there's no way to add a
 * Discord scheduled-events list to a personal calendar. The Worker publishes
 * the same events as an iCalendar feed (`GET /calendar.ics`), and this
 * component surfaces the three ways to consume it:
 *
 *  - `webcals://` -> hands the URL to the OS calendar app (Apple Calendar,
 *                    Outlook desktop). This is a true *subscription*: the
 *                    app re-fetches the feed on its own schedule.
 *  - Google Calendar "Add by URL" deep link.
 *  - Outlook on the web "add from web" deep link.
 *
 * A "copy feed URL" button covers every other client (Thunderbird, Fastmail,
 * Proton, ...) that takes a URL, and a direct `.ics` link lets a user import
 * a one-time snapshot instead of subscribing.
 */

/** One provider card. `icon` is a brand glyph; the label is split into a
 * primary action and a hint describing what the link actually does. */
interface Provider {
    key: string;
    href: string;
    label: string;
    hint: string;
    icon: React.ComponentType<{ size?: number }>;
    /** External links open in a new tab; `webcals://` must NOT (a new tab
     * would linger as a blank page after the OS handler takes over). */
    external: boolean;
    testId?: string;
    /** Optional click hook (used to pre-copy the feed URL for Google). */
    onClick?: () => void;
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
     * Copy the feed URL to the clipboard.
     *
     * Also used as the click handler for the Google link: Google's "Add by
     * URL" dialog has no query-param way to pre-fill the feed, so we copy it
     * on the way out and the user just pastes. Returns whether the copy
     * succeeded so callers can decide whether to react.
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

    // Google's add-by-URL dialog can't be pre-filled via query params, so copy
    // the feed URL on click; it's already on the clipboard for the next screen.
    // No preventDefault -- let the navigation proceed.
    const handleGoogleClick = async () => {
        if (await copyFeedUrl()) flashCopied();
    };

    const webcal = webcalUrl();

    const providers: Provider[] = [
        {
            key: "webcal",
            href: webcal,
            label: "Apple / Outlook",
            hint: "Add to this device",
            icon: FaApple,
            external: false,
            testId: "subscribe-webcal",
        },
        {
            key: "google",
            href: googleCalendarSubscribeUrl(),
            label: "Google Calendar",
            hint: "Opens Add by URL (link copied)",
            icon: FaGoogle,
            external: true,
            onClick: handleGoogleClick,
        },
        {
            key: "outlook",
            href: outlookSubscribeUrl(),
            label: "Outlook Web",
            hint: "Subscribe from the web",
            icon: FaMicrosoft,
            external: true,
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
                                    onClick={p.onClick}
                                    {...(p.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                                >
                                    <span className="calendar-subscribe__provider-icon" aria-hidden="true">
                                        <Icon size={17} />
                                    </span>
                                    <span className="calendar-subscribe__provider-text">
                                        <span className="calendar-subscribe__provider-label">{p.label}</span>
                                        <span className="calendar-subscribe__provider-hint">{p.hint}</span>
                                    </span>
                                    {p.external && <span className="sr-only"> (opens in a new tab)</span>}
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
                            Google Calendar can't be pre-filled from a link, so the button above copies this URL and
                            opens Google's "Add by URL" dialog. In any other app, look for "Add calendar from URL" and
                            paste it there.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
