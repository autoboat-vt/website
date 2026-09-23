import Calendar from "./Calendar";

/**
 * Officers calendar (`/calendar/officers`).
 *
 * The same calendar component as `/calendar`, pointed at the Worker's
 * `/officers/events` route, which includes officer-only events the public
 * feed filters out. A separate thin page rather than a query parameter, so
 * every page keeps its own SPA fallback and the URL stays shareable.
 *
 * WARNING: The site path is `/calendar/officers` (nested under the public
 * `/calendar`), while the API it reads is `<worker-url>/officers/events`. The
 * two `/officers` strings are unrelated -- do not "harmonize" them.
 *
 * WARNING: This page is NOT access-controlled. It is off the nav, unlinked, and the
 * route is unguessable, but anyone with the URL sees it -- there is no key or
 * login by design. Do not link to it from any public page. The visible warning
 * banner was removed at the team's request; the constraint still applies, so
 * treat the link itself as the secret.
 */
export default function Officers() {
    return (
        <>
            <h1 className="sr-only">Officers Calendar</h1>

            <Calendar variant="officer" />
        </>
    );
}
