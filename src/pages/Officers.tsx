import { Lock, ShieldAlert } from "lucide-react";
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
 * login by design. Do not link to it from any public page.
 *
 * The warning banner is deliberate: the most likely way this leaks is an
 * officer pasting the link into Discord or a public channel without realizing
 * it carries no auth.
 */
export default function Officers() {
    return (
        <>
            {/* Accessible heading without a visible intro block. The banner and
                the Calendar each render their own layout container, so this
                page is a fragment rather than a wrapping <section> -- nesting
                two `.section` elements doubled the vertical padding. */}
            <h1 className="sr-only">Officers Calendar</h1>

            {/* `.section` so the banner inherits the site's horizontal rhythm,
                plus `.officers-banner-section` to widen it to match the
                calendar Card below (otherwise the banner sits at 1100px while
                the Card is 1248px, and the edges visibly disagree). */}
            <section className="section officers-banner-section mx-auto grid max-w-275 px-4">
                <div className="officers-banner" role="note">
                    <ShieldAlert size={18} aria-hidden="true" className="officers-banner__icon" />
                    <div>
                        <p className="officers-banner__title">
                            <Lock size={13} aria-hidden="true" className="officers-banner__lock" />
                            Officer-only events included
                        </p>
                        <p className="officers-banner__text">
                            This view shows events the public calendar hides. The page is unlisted but not password
                            protected, so anyone with this link can read it. Keep the link inside the officer team, and
                            use the subscribe button below for the officer feed.
                        </p>
                    </div>
                </div>
            </section>

            <Calendar variant="officer" />
        </>
    );
}
