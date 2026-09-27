/**
 * Mutual exclusion for the calendar header's dropdown panels.
 *
 * Two dropdowns live in the calendar header (Subscribe and Filter). Both panels
 * are absolutely positioned and centered on `.calendar-header`, so if both were
 * open at once they would occupy the same rectangle and look like a rendering
 * bug. They are separate components with their own open state, so the
 * coordination is done with a document-level event rather than by threading
 * state through the page.
 *
 * The event carries the id of the panel that just opened; every other panel
 * closes itself.
 */

import { useEffect } from "react";

const OPEN_EVENT = "autoboat:calendar-dropdown-open";

/** Tell the other panels that `id` has opened, so they can close. */
export function announceDropdownOpen(id: string): void {
    document.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: id }));
}

/**
 * Close this panel whenever a *different* panel opens.
 *
 * `close` is called on a later event, not during render, so it is safe to pass
 * a `setState` updater directly.
 */
export function useCloseOnOtherDropdownOpen(id: string, close: () => void): void {
    useEffect(() => {
        const onOtherOpen = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== id) close();
        };
        document.addEventListener(OPEN_EVENT, onOtherOpen);
        return () => document.removeEventListener(OPEN_EVENT, onOtherOpen);
    }, [id, close]);
}
