import { CalendarPlus, Check, Copy, Link as LinkIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { EVENTS_ICS_URL, googleCalendarSubscribeUrl, outlookSubscribeUrl, webcalUrl } from "../lib/discord";

/**
 * "Subscribe" affordance for the calendar page.
 *
 * The events themselves come from Discord, but there's no way to add a
 * Discord scheduled-events list to a personal calendar. The Worker publishes
 * the same events as an iCalendar feed (`GET /calendar.ics`), and this
 * component surfaces the three ways to consume it:
 *
 *  - `webcal://`  -> hands the URL to the OS calendar app (Apple Calendar,
 *                    Outlook desktop). This is a true *subscription*: the
 *                    app re-fetches the feed on its own schedule.
 *  - Google Calendar "Add by URL" deep link.
 *  - Outlook on the web "add from web" deep link.
 *
 * A "copy feed URL" button covers every other client (Thunderbird, Fastmail,
 * Proton, ...) that takes a URL, and a direct `.ics` link lets a user import
 * a one-time snapshot instead of subscribing.
 */
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

    const handleCopy = async () => {
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
            setCopied(true);
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard permission denied -- leave the URL visible to copy by
            // hand rather than showing an error for a convenience action.
            setCopied(false);
        }
    };

    const webcal = webcalUrl();

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
            </button>

            {open && (
                <div className="calendar-subscribe__panel" id={panelId}>
                    <p className="calendar-subscribe__intro">
                        Add the AutoBoat calendar to your own calendar app. It updates automatically as events change in
                        Discord.
                    </p>

                    <div className="calendar-subscribe__links">
                        <a className="btn btn--sm" href={webcal} data-testid="subscribe-webcal">
                            Apple / Outlook
                        </a>
                        <a
                            className="btn btn--sm"
                            href={googleCalendarSubscribeUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Google Calendar
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        <a
                            className="btn btn--sm"
                            href={outlookSubscribeUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Outlook Web
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        <a className="btn btn--sm" href={EVENTS_ICS_URL} download="autoboat.ics">
                            Download .ics
                        </a>
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

                    <p className="calendar-subscribe__hint">
                        In another calendar app, look for "Add calendar from URL" and paste the link above.
                    </p>
                </div>
            )}
        </div>
    );
}
