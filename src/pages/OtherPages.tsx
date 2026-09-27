import { ArrowRight, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * A feature page that isn't in the main navigation but is still public.
 * The route exists regardless of what's listed here -- this array only
 * controls what the Other Pages page advertises.
 */
interface FeaturePage {
    /**
     * An in-app route (e.g. `/gallery`) for internal entries, or a full URL
     * (e.g. `https://autoboat-vt.github.io/documentation`) when `external` is
     * set.
     */
    to: string;
    title: string;
    description: string;
    /**
     * True for a destination on a different host, which is rendered as an
     * `<a target="_blank">` instead of a react-router `<Link>`.
     *
     * WARNING: This flag is what selects the element, so it must match the
     * shape of `to`. A `Link` pointing at an absolute external URL would be
     * treated as an in-app path.
     */
    external?: boolean;
}

const FEATURE_PAGES: FeaturePage[] = [
    {
        to: "/live",
        title: "Live Map",
        description:
            "Real-time GPS positions, waypoints, and telemetry from our boats. Most of the time these are simulation runs; the real boats only appear during testing and competitions.",
    },
    {
        to: "/calendar",
        title: "Calendar",
        description:
            "Meeting times, work sessions, and competition dates, pulled straight from our Discord server. You can also subscribe to it from your own calendar app.",
    },
    {
        to: "/gallery",
        title: "Gallery",
        description: "Photos of the team at work in the Ware Lab and out on the water.",
    },
    {
        // External: the docs site is a separate GitHub Pages deployment, not a
        // route in this app. `external: true` renders it as a plain <a>.
        to: "https://autoboat-vt.github.io/documentation",
        title: "Documentation",
        description: "Technical write-ups, build logs, and guides for our boats and software, maintained by the team.",
        external: true,
    },
];

export default function OtherPages() {
    return (
        <section className="section mx-auto grid max-w-275 gap-4 px-4 py-16">
            {/* The card grid is the whole page now -- keep an accessible page
                heading for screen readers without rendering a visible intro. */}
            <h1 className="sr-only">Other Pages</h1>
            <div className="grid gap-4 min-[700px]:grid-cols-2 min-[1000px]:grid-cols-3">
                {FEATURE_PAGES.map((page) => {
                    // Shared so the internal and external branches cannot drift
                    // apart visually.
                    //
                    // The card keeps the frosted `bg-card` panel it has always
                    // had; the color lives on the affordance instead.
                    const cardClass =
                        "group flex flex-col gap-3 rounded-2xl border border-cardborder bg-card p-6 text-left text-fontcolor no-underline backdrop-blur-md transition-[border-color] duration-200 hover:border-fontcolor/20 hover:text-fontcolor focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fontcolor";
                    const body = (
                        <>
                            <h3 className="m-0 font-heading text-xl font-extrabold">{page.title}</h3>
                            <p className="m-0 text-[0.95rem] leading-relaxed text-hovercolor">{page.description}</p>
                            {/* Styled as a button, but deliberately a <span>:
                                the whole card is already the <a>, and nesting
                                an interactive element inside a link is invalid.
                                The maroon fill + white text matches the Header
                                nav pill and the Home page buttons. NOTE: the
                                `hover:*` utilities are load-bearing -- the
                                shared `.btn:hover` rule flips the fill to
                                `--color-fontcolor` (near-black) and the global
                                `a:hover` flips the text, both of which would
                                break the white-on-maroon pairing. The hover fill
                                is burnt orange (`hover:bg-accent-2`), chosen by
                                the maintainer -- see the note on
                                `--color-accent-2` in app.css for the measured
                                contrast. */}
                            <span className="btn btn--sm mt-auto w-fit border-transparent bg-accent font-bold text-white hover:border-transparent hover:bg-accent-2 hover:text-white">
                                {page.external ? "Visit" : "Open"} {page.title}
                                {page.external ? (
                                    <ExternalLink size={16} aria-hidden="true" />
                                ) : (
                                    <ArrowRight size={16} aria-hidden="true" />
                                )}
                            </span>
                        </>
                    );

                    // External destinations leave the site, so they get a plain
                    // anchor with the same new-tab treatment as Footer.tsx.
                    // In-app destinations stay react-router <Link>s so client
                    // navigation and SPA routing keep working.
                    return page.external ? (
                        <a key={page.to} href={page.to} target="_blank" rel="noopener noreferrer" className={cardClass}>
                            {body}
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                    ) : (
                        <Link key={page.to} to={page.to} className={cardClass}>
                            {body}
                        </Link>
                    );
                })}
            </div>
        </section>
    );
}
