import { AlertCircle, Check, Loader2, UserKey } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { SUBTEAM_CHANNELS } from "../lib/eventChannels";
import {
    beginLogin,
    clearSession,
    completeLogin,
    createEvent,
    loadSession,
    ManageError,
    type ManageSession,
} from "../lib/eventManage";
import { announceDropdownOpen, useCloseOnOtherDropdownOpen } from "./calendarDropdown";

/**
 * "Add event" control for the calendar page, plus the login it depends on.
 *
 * Only officers may create events, and the Worker enforces that -- this
 * component's job is to make the flow legible, not to be the security boundary.
 * It therefore renders the sign-in affordance for everyone and surfaces the
 * Worker's 403 as "only officers can add events" rather than pre-hiding the
 * control (hiding it would leave a visitor who DOES have the role with no way
 * to discover the feature, and the browser cannot evaluate Discord roles).
 *
 * WHY THERE IS NO GENERIC "DELETE" HERE: creating is the requested feature.
 * Events are edited and deleted in Discord, where the audit-log signal the
 * read path depends on already exists.
 */

/** General-member channel: public, for the whole team. */
const MEMBER_EVENTS_CHANNEL_ID = "1550594275580837921";

/**
 * The officer voice channel, spelled out rather than looked up.
 *
 * It also lives in `ALWAYS_VISIBLE_CHANNEL_IDS` (the filter must never hide
 * it) and as `DEFAULT_OFFICERS_CHANNEL_ID` in the Worker. This form needs it
 * for a different question -- "will this event be hidden from the public
 * calendar" -- so the id is stated once here with the reason it is known.
 *
 * WARNING: Keep in sync with `OFFICERS_CHANNEL_ID` in worker/wrangler.jsonc.
 * A stale value only mislabels the warning hint; the Worker still classifies
 * the event correctly from its own config.
 */
const OFFICER_EVENTS_CHANNEL_ID = "1550594891766308997";

/** Channel options, in picker order: subteams first, then the whole-team ones. */
const CHANNEL_OPTIONS: { id: string; label: string }[] = [
    ...SUBTEAM_CHANNELS.map(({ id, label }) => ({ id, label })),
    { id: MEMBER_EVENTS_CHANNEL_ID, label: "General members" },
    { id: OFFICER_EVENTS_CHANNEL_ID, label: "Officers only" },
];

/**
 * Field label text, with a marker when the field is required.
 *
 * The asterisk is drawn by CSS (`.calendar-add__label--required::after`) rather
 * than rendered as a DOM node. That is deliberate: the marker is decorative --
 * the input's native `required` attribute is what assistive technology
 * announces -- and keeping it out of the DOM means each field's accessible name
 * stays exactly its label text instead of becoming "Starts *".
 */
function FieldLabel({ children, required = false }: { children: React.ReactNode; required?: boolean }) {
    return (
        <span className={required ? "calendar-add__label calendar-add__label--required" : "calendar-add__label"}>
            {children}
        </span>
    );
}

/** Recurrence choices, limited to what Discord's API accepts. */
type RepeatChoice = "none" | "weekly" | "biweekly" | "monthly" | "daily";

const REPEAT_LABELS: Record<RepeatChoice, string> = {
    none: "Does not repeat",
    weekly: "Every week",
    biweekly: "Every other week",
    monthly: "Every month (same weekday)",
    daily: "Every weekday",
};

export interface EventCreatorProps {
    /** Called after a successful create so the page can refresh its events. */
    onCreated?: () => void;
}

/**
 * Convert a `datetime-local` value to an ISO instant.
 *
 * `new Date("2026-11-05T19:00")` is parsed as LOCAL time by the spec, which is
 * what the input means, and `toISOString()` converts it to UTC for Discord.
 * Guarded because an empty or partial value yields an Invalid Date.
 */
function localInputToIso(value: string): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Build the recurrence payload for the chosen option.
 *
 * The weekday comes from the event's own start date (`getDay()` is Sunday = 0
 * while Discord counts Monday = 0), so "every week" means the day the user
 * actually picked instead of forcing a second choice.
 */
function buildRecurrence(
    choice: RepeatChoice,
    startLocal: string,
): {
    frequency: "DAILY" | "WEEKLY" | "MONTHLY";
    interval?: number;
    byWeekday?: number[];
    byNWeekday?: { n: number; day: number }[];
} | null {
    if (choice === "none") return null;
    const date = new Date(startLocal);
    if (Number.isNaN(date.getTime())) return null;
    // JS: Sunday 0..Saturday 6. Discord: Monday 0..Sunday 6.
    const discordWeekday = (date.getDay() + 6) % 7;

    switch (choice) {
        case "weekly":
            return { frequency: "WEEKLY", interval: 1, byWeekday: [discordWeekday] };
        case "biweekly":
            return { frequency: "WEEKLY", interval: 2, byWeekday: [discordWeekday] };
        case "daily":
            // Discord only accepts certain weekday sets for DAILY; Mon-Fri is
            // one of them.
            return { frequency: "DAILY", interval: 1, byWeekday: [0, 1, 2, 3, 4] };
        case "monthly": {
            // Ordinal weekday within the month, e.g. "3rd Wednesday". Derived
            // from the chosen date so the first occurrence matches what the
            // user picked.
            const n = Math.floor((date.getDate() - 1) / 7) + 1;
            return { frequency: "MONTHLY", interval: 1, byNWeekday: [{ n, day: discordWeekday }] };
        }
    }
}

export default function EventCreator({ onCreated }: EventCreatorProps) {
    const [session, setSession] = useState<ManageSession | null>(() => loadSession());
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    /**
     * A refusal from the Worker ("not a member" or "no officer role").
     *
     * Held separately from `error` because it renders as an explained block
     * with a remedy and a "try another account" button, not a one-line
     * message -- the person hitting it is usually signed in to the wrong
     * Discord account and needs to be told that.
     */
    const [denied, setDenied] = useState<ManageError | null>(null);
    const panelId = useId();
    const close = useCallback(() => setOpen(false), []);
    useCloseOnOtherDropdownOpen("calendar-add-event", close);

    // Form fields. Kept as strings so the inputs stay uncontrolled-looking and
    // an invalid intermediate value (a half-typed date) never crashes render.
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [startLocal, setStartLocal] = useState("");
    const [endLocal, setEndLocal] = useState("");
    const [channelId, setChannelId] = useState(CHANNEL_OPTIONS[0]?.id ?? "");
    const [noChannel, setNoChannel] = useState(false);
    const [location, setLocation] = useState("");
    const [repeat, setRepeat] = useState<RepeatChoice>("none");

    const isExternal = noChannel;

    /**
     * Finish a login if Discord just redirected back with `?code=`.
     *
     * The code is single-use and short-lived, so the query string is cleared
     * immediately -- leaving it in the address bar invites a refresh to replay
     * a spent code, which fails confusingly.
     */
    useEffect(() => {
        const params = new URLSearchParams(globalThis.location.search);
        const code = params.get("code");
        const state = params.get("state");
        if (!code || !state) return;

        params.delete("code");
        params.delete("state");
        params.delete("iss");
        const cleanUrl = `${globalThis.location.pathname}${params.toString() ? `?${params}` : ""}${globalThis.location.hash}`;
        globalThis.history.replaceState({}, "", cleanUrl);

        setBusy(true);
        completeLogin(code, state)
            .then((next) => {
                setSession(next);
                setDenied(null);
                setOpen(true);
            })
            .catch((err: unknown) => {
                // A permission refusal is a explained state (wrong account, or
                // no officer role) rather than a terse error line.
                if (err instanceof ManageError && err.remedy !== null) {
                    setDenied(err);
                    setOpen(true);
                    setError(null);
                } else {
                    setError(err instanceof ManageError ? err.message : "Login failed. Please try again.");
                    setOpen(true);
                }
            })
            .finally(() => setBusy(false));
    }, []);

    const handleLogin = async () => {
        setError(null);
        setDenied(null);
        setBusy(true);
        try {
            // Navigates away on success, so there is nothing to do afterwards.
            await beginLogin();
        } catch (err) {
            setBusy(false);
            setError(err instanceof ManageError ? err.message : "Could not start the Discord login.");
        }
    };

    const handleLogOut = () => {
        clearSession();
        setSession(null);
        setOpen(false);
        setNotice(null);
        setError(null);
        setDenied(null);
    };

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!session) return;

        setError(null);
        setNotice(null);
        setDenied(null);

        const start = localInputToIso(startLocal);
        if (!start) {
            setError("Pick a start date and time.");
            return;
        }
        const end = localInputToIso(endLocal);

        setBusy(true);
        try {
            const trimmedLocation = location.trim();
            const result = await createEvent(session, {
                name,
                description: description.trim() || null,
                start,
                end,
                channelId: isExternal ? null : channelId,
                location: trimmedLocation || null,
                recurrence: buildRecurrence(repeat, startLocal),
            });

            const where = result.officerOnly ? " (officers only)" : "";
            setNotice(`Created "${result.event?.name ?? name}"${where}.`);
            // Reset the fields that should not carry over to the next event.
            setName("");
            setDescription("");
            setStartLocal("");
            setEndLocal("");
            setLocation("");
            setRepeat("none");
            onCreated?.();
        } catch (err) {
            if (err instanceof ManageError) {
                if (err.status === 401) {
                    // The token expired or was rejected: drop it so the UI
                    // offers "sign in" rather than retrying a dead token.
                    clearSession();
                    setSession(null);
                }
                if (err.remedy !== null) {
                    // Lost the officer role since signing in -- explain it
                    // rather than showing a bare "Only officers" string.
                    setDenied(err);
                    setError(null);
                } else {
                    setError(err.message);
                }
            } else {
                setError("Could not create the event. Please try again.");
            }
        } finally {
            setBusy(false);
        }
    };

    const toggle = () => {
        setError(null);
        setNotice(null);
        setOpen((wasOpen) => {
            if (!wasOpen) announceDropdownOpen("calendar-add-event");
            return !wasOpen;
        });
    };

    const panelTitle = useMemo(() => (session ? `Add an event as ${session.name}` : "Add an event"), [session]);

    return (
        <div className="calendar-add">
            <button
                type="button"
                className="btn btn--sm calendar-add__toggle"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={toggle}
                disabled={busy && !session}
            >
                <UserKey size={16} aria-hidden="true" />
                {session ? "Add event" : "Officer sign-in"}
            </button>

            {open && (
                <div className="calendar-add__panel" id={panelId}>
                    <h3 className="calendar-add__title">{panelTitle}</h3>

                    {!session ? (
                        <>
                            {/* A refusal already explains what to do and offers
                                its own sign-in button, so the generic intro
                                would be a second, contradictory call to action. */}
                            {!denied && (
                                <p className="calendar-add__intro">
                                    Adding events to the calendar requires signing in with Discord. Only officers can
                                    create events.
                                </p>
                            )}
                            {!denied && (
                                <button type="button" className="btn" onClick={handleLogin} disabled={busy}>
                                    {busy ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : null}
                                    {busy ? "Opening Discord..." : "Sign in with Discord"}
                                </button>
                            )}
                        </>
                    ) : (
                        <form className="calendar-add__form" onSubmit={handleSubmit}>
                            <label className="calendar-add__field">
                                <FieldLabel required>Event name</FieldLabel>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    maxLength={100}
                                    required
                                    autoComplete="off"
                                />
                            </label>

                            <label className="calendar-add__field">
                                <FieldLabel>Description (optional)</FieldLabel>
                                <textarea
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    maxLength={1000}
                                    rows={3}
                                />
                            </label>

                            <label className="calendar-add__field">
                                <FieldLabel required>Starts</FieldLabel>
                                <input
                                    type="datetime-local"
                                    value={startLocal}
                                    onChange={(e) => setStartLocal(e.target.value)}
                                    required
                                />
                            </label>

                            {/* An event with no Discord channel needs an end time,
                                so the same field flips between optional and
                                required. The marker, the native attribute, and
                                the visible "(optional)" wording all follow the
                                one `isExternal` decision. */}
                            <label className="calendar-add__field">
                                <FieldLabel required={isExternal}>Ends{isExternal ? "" : " (optional)"}</FieldLabel>
                                <input
                                    type="datetime-local"
                                    value={endLocal}
                                    onChange={(e) => setEndLocal(e.target.value)}
                                    required={isExternal}
                                />
                            </label>

                            <label className="calendar-add__field">
                                <FieldLabel>Repeats</FieldLabel>
                                <select value={repeat} onChange={(e) => setRepeat(e.target.value as RepeatChoice)}>
                                    {(Object.keys(REPEAT_LABELS) as RepeatChoice[]).map((choice) => (
                                        <option key={choice} value={choice}>
                                            {REPEAT_LABELS[choice]}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <label className="calendar-add__checkbox">
                                <input
                                    type="checkbox"
                                    checked={noChannel}
                                    onChange={(e) => setNoChannel(e.target.checked)}
                                />
                                <span>This event is not in a Discord voice channel</span>
                            </label>

                            {isExternal ? (
                                <label className="calendar-add__field">
                                    <FieldLabel required>Location</FieldLabel>
                                    <input
                                        type="text"
                                        value={location}
                                        onChange={(e) => setLocation(e.target.value)}
                                        maxLength={100}
                                        required
                                        placeholder="Lavery Hall 335, or a link"
                                    />
                                </label>
                            ) : (
                                <>
                                    <label className="calendar-add__field">
                                        <FieldLabel>Discord channel</FieldLabel>
                                        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                                            {CHANNEL_OPTIONS.map((option) => (
                                                <option key={option.id} value={option.id}>
                                                    {option.label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="calendar-add__field">
                                        <FieldLabel>Location (optional)</FieldLabel>
                                        <input
                                            type="text"
                                            value={location}
                                            onChange={(e) => setLocation(e.target.value)}
                                            maxLength={100}
                                            placeholder="Shown on the calendar"
                                        />
                                    </label>
                                </>
                            )}

                            {isExternal && (
                                <p className="calendar-add__hint">
                                    An event with no channel needs a location and an end time.
                                </p>
                            )}
                            {!isExternal && channelId === OFFICER_EVENTS_CHANNEL_ID && (
                                <p className="calendar-add__hint">
                                    This event will be hidden from the public calendar and appear only on the officers
                                    calendar.
                                </p>
                            )}

                            <div className="calendar-add__actions">
                                <button type="submit" className="btn btn--sm" disabled={busy}>
                                    {busy ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : null}
                                    {busy ? "Creating..." : "Create event"}
                                </button>
                                <button type="button" className="btn btn--sm" onClick={handleLogOut} disabled={busy}>
                                    Sign out
                                </button>
                            </div>
                        </form>
                    )}

                    {/* A permission refusal. Rendered instead of the form when
                        there is no usable session, so the person is not left
                        staring at a form whose submit will only fail again. */}
                    {denied && (
                        <div className="calendar-add__denied" role="alert">
                            <p className="calendar-add__denied-title">
                                <AlertCircle size={16} aria-hidden="true" />
                                {denied.reason === "not-a-member"
                                    ? "That Discord account is not on the team server"
                                    : "That Discord account is not an officer"}
                            </p>
                            <p className="calendar-add__denied-body">{denied.remedy}</p>
                            {/* Switching accounts only helps when the wrong
                                account was used. A missing role is fixed in
                                Discord, so offering a re-login there would send
                                the user round a loop that cannot succeed. */}
                            {denied.reason === "not-a-member" && (
                                <button type="button" className="btn btn--sm" onClick={handleLogin} disabled={busy}>
                                    {busy ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : null}
                                    {busy ? "Opening Discord..." : "Sign in with a different account"}
                                </button>
                            )}
                        </div>
                    )}

                    {error && (
                        <p className="calendar-add__error" role="alert">
                            <AlertCircle size={16} aria-hidden="true" />
                            {error}
                        </p>
                    )}
                    {notice && (
                        <p className="calendar-add__notice" role="status">
                            <Check size={16} aria-hidden="true" />
                            {notice}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
