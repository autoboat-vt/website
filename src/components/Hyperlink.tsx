import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * A branded "URL string" type — a string that has been validated as a URL.
 *
 * TypeScript has no built-in URL *string* type (the DOM `URL` class is for
 * parsing/manipulating, not typing). This brand gives compile-time protection
 * against passing arbitrary strings where a URL is expected, while still
 * being assignable wherever `string` is required.
 *
 * Use `url()` to create one (it validates at runtime).
 */
export type UrlString = string & { readonly __brand: "UrlString" };

/**
 * Validate a string as a URL and return it as a branded `UrlString`.
 *
 * Accepts any value `new URL()` accepts (http://, https://, mailto:, etc.)
 * as well as bare paths like "/ourteam" (treated as a route-relative URL
 * against the current origin, which is what react-router expects).
 *
 * @throws TypeError if `s` is not a valid URL.
 */
export function url(s: string): UrlString {
    if (s.startsWith("/")) {
        // Route-relative path — validate against current origin
        new URL(s, globalThis.location?.origin ?? "http://localhost");
    } else {
        new URL(s);
    }
    return s as UrlString;
}

interface HyperlinkProps {
    /** The URL or path. Internal paths start with "/" (e.g. "/ourteam"). Use `url()` to construct. */
    href: UrlString;
    /** The visible link text. */
    children: ReactNode;
    /** Optional hash anchor on an internal route (e.g. "software" → "/ourteam#software"). */
    hash?: string;
    /** Override the default underline styling. */
    className?: string;
    /**
     * Surrounding whitespace so you don't need `{" "}` in JSX.
     * - "before": leading space (e.g. `...on the <Hyperlink space="before">Meet the Team</Hyperlink> page.`)
     * - "after": trailing space (e.g. `<Hyperlink space="after">Meet the Team</Hyperlink> page.`)
     * - "around" / "both": spaces on both sides
     * - "none" (default): no surrounding spaces
     */
    space?: "before" | "after" | "around" | "both" | "none";
}

/**
 * Reusable inline hyperlink.
 *
 * - Internal paths (starting with "/") render as a react-router <Link> for SPA navigation.
 * - External URLs (http/https/mailto/etc.) render as an <a> that opens in a new tab
 *   with `rel="noopener noreferrer"` and an sr-only "opens in a new tab" announcement.
 *
 * @example
 * <Hyperlink href="/ourteam">Meet the Team</Hyperlink>
 * <Hyperlink href="https://example.com">External site</Hyperlink>
 * <Hyperlink href="/ourteam" hash="software">Software subteam</Hyperlink>
 */
export default function Hyperlink({ href, children, hash, className, space = "none" }: HyperlinkProps) {
    const linkClass = className ?? "text-fontcolor dark:text-white underline decoration-current";
    const isInternal = href.startsWith("/");
    const padBefore = space === "before" || space === "around" || space === "both" ? " " : "";
    const padAfter = space === "after" || space === "around" || space === "both" ? " " : "";

    if (isInternal) {
        const to = hash ? `${href}#${hash}` : href;
        return (
            <>
                {padBefore}
                <Link to={to} className={linkClass}>
                    {children}
                </Link>
                {padAfter}
            </>
        );
    }

    return (
        <>
            {padBefore}
            <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {children}
                <span className="sr-only"> (opens in a new tab)</span>
            </a>
            {padAfter}
        </>
    );
}
