/**
 * The half of the OAuth flow that runs in the browser after Discord redirects
 * back.
 *
 * WHY THIS IS SHARED. Two pages can now complete a login: the calendar and the
 * gallery. Each has its own redirect URI registered (a single URI cannot serve
 * both without stranding the user on the other page), so both pages receive
 * `?code=...&state=...` and both must exchange it. That exchange involves a
 * single-use code, a history rewrite, and three distinct failure shapes -- all
 * things that must not be implemented twice, because the two copies would drift
 * and one of them would end up replaying a spent code.
 *
 * WHAT THIS DOES NOT DO: decide what to render. It returns the outcome and the
 * caller shows it in its own UI, which is why this returns data instead of
 * setting state.
 */

import { completeLogin, ManageError, type ManageSession } from "./eventManage";

/** What happened when a `?code=` redirect was processed. */
export type LoginCompletion =
    | { kind: "none" }
    | { kind: "success"; session: ManageSession }
    /** A permission refusal, with the remedy already worded. */
    | { kind: "denied"; error: ManageError }
    | { kind: "failed"; message: string };

/**
 * Read `?code=`/`?state=` from the current URL and, if present, complete the
 * login.
 *
 * The query string is cleared BEFORE the exchange, and unconditionally. The
 * authorization code is single-use and short-lived, so leaving it in the address
 * bar invites a refresh to replay a spent code -- which fails with a confusing
 * message that looks like the login itself is broken. Clearing first also
 * means the URL is already clean if the exchange throws.
 *
 * `search`/`pathname`/`history` are read from `globalThis.location`, or passed
 * in for tests (jsdom's `location` cannot be assigned).
 */
export async function completeLoginFromUrl(
    location: { search: string; pathname: string; hash: string } = globalThis.location,
    replaceState: (url: string) => void = (url) => globalThis.history.replaceState({}, "", url),
): Promise<LoginCompletion> {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const state = params.get("state");

    // `error` is Discord's own refusal (e.g. the user clicked "Cancel" on the
    // consent screen). Handling it here means the caller shows a message rather
    // than silently doing nothing.
    const discordError = params.get("error");

    if (!code || !state) {
        if (discordError) {
            params.delete("error");
            params.delete("error_description");
            params.delete("state");
            replaceState(`${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`);
            return { kind: "failed", message: "Discord sign-in was cancelled." };
        }
        return { kind: "none" };
    }

    // Clear the code from the address bar immediately -- see the note above.
    params.delete("code");
    params.delete("state");
    params.delete("iss");
    replaceState(`${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`);

    try {
        const session = await completeLogin(code, state);
        return { kind: "success", session };
    } catch (err) {
        if (err instanceof ManageError && err.remedy !== null) {
            // A refusal is an EXPLAINED state (wrong account, or no officer
            // role), not a terse error line, so it is reported separately and
            // the caller renders it with its remedy.
            return { kind: "denied", error: err };
        }
        return {
            kind: "failed",
            message: err instanceof ManageError ? err.message : "Login failed. Please try again.",
        };
    }
}
