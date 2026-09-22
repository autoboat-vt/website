import type { LucideIcon } from "lucide-react";
import { ArrowRight, CalendarDays, Images, Radio } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * A feature page that isn't in the main navigation but is still public.
 * The route exists regardless of what's listed here -- this array only
 * controls what the Other Pages page advertises.
 */
interface FeaturePage {
    to: string;
    title: string;
    description: string;
    icon: LucideIcon;
}

const FEATURE_PAGES: FeaturePage[] = [
    {
        to: "/live",
        title: "Live Map",
        description:
            "Real-time GPS positions, waypoints, and telemetry from our boats. Most of the time these are simulation runs; the real boats only appear during testing and competitions.",
        icon: Radio,
    },
    {
        to: "/calendar",
        title: "Calendar",
        description:
            "Meeting times, work sessions, and competition dates, pulled straight from our Discord server. You can also subscribe to it from your own calendar app.",
        icon: CalendarDays,
    },
    {
        to: "/gallery",
        title: "Gallery",
        description: "Photos of the team at work in the Ware Lab and out on the water.",
        icon: Images,
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
                    const Icon = page.icon;
                    return (
                        <Link
                            key={page.to}
                            to={page.to}
                            className="group flex flex-col gap-3 rounded-2xl border border-cardborder bg-card p-6 text-left text-fontcolor no-underline backdrop-blur-md transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-fontcolor/20 hover:text-fontcolor focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fontcolor"
                        >
                            <Icon size={28} strokeWidth={1.75} className="text-accent" aria-hidden="true" />
                            <h3 className="m-0 font-heading text-xl font-extrabold">{page.title}</h3>
                            <p className="m-0 text-[0.95rem] leading-relaxed text-hovercolor">{page.description}</p>
                            <span className="mt-auto inline-flex items-center gap-1.5 pt-2 font-heading text-sm font-bold text-accent">
                                Open {page.title}
                                <ArrowRight
                                    size={16}
                                    className="transition-transform duration-200 group-hover:translate-x-0.5"
                                    aria-hidden="true"
                                />
                            </span>
                        </Link>
                    );
                })}
            </div>
        </section>
    );
}
