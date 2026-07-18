import { Heart, Mail } from "lucide-react";
import type { ComponentType } from "react";
import { FaDiscord, FaGithub, FaInstagram, FaLinkedin } from "react-icons/fa6";
import { Link } from "react-router-dom";

// Permissive icon type — lucide-react and react-icons components have
// different prop signatures, so we accept a loose common surface.
type IconType = ComponentType<{ size?: number | string; className?: string; [key: string]: unknown }>;

interface SocialLink {
    href: string;
    label: string;
    icon: IconType;
}

const SOCIAL_LINKS: SocialLink[] = [
    { href: "mailto:autoboat@vt.edu", label: "Email", icon: Mail },
    { href: "https://discord.gg/e34cdWdKbG", label: "Discord", icon: FaDiscord },
    { href: "https://www.instagram.com/autoboatvt", label: "Instagram", icon: FaInstagram },
    { href: "https://github.com/autoboat-vt", label: "GitHub", icon: FaGithub },
    { href: "https://www.linkedin.com/company/abvt", label: "LinkedIn", icon: FaLinkedin },
];

const NAV_LINKS = [
    { to: "/", label: "Home" },
    { to: "/fleet", label: "Fleet" },
    { to: "/ourteam", label: "Team" },
    { to: "/sponsors", label: "Sponsors" },
    { to: "/live", label: "Live Map" },
] as const;

const DONATE_URL = "https://giving.adv.vt.edu/gift?fund=821082&amt=25&frequency=onetime&desc=AutoBoat%20Design%20Team";

const YEAR = new Date().getFullYear();

export default function Footer() {
    return (
        <footer className="relative mt-8 border-t border-black/6 bg-transparent dark:border-white/10">
            {/* Accent gradient top bar */}
            <div
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent_0%,var(--color-accent)_30%,var(--color-accent-2)_70%,transparent_100%)]"
            />
            <div className="mx-auto max-w-275 px-4 py-6 min-[900px]:max-w-300 min-[900px]:py-4">
                <div className="flex flex-col items-center gap-4 min-[900px]:flex-row min-[900px]:items-center min-[900px]:justify-between min-[900px]:gap-6">
                    {/* Brand + tagline */}
                    <div className="flex flex-col items-center gap-2 text-center min-[900px]:items-start min-[900px]:text-left">
                        <Link to="/" className="flex items-center gap-2 no-underline" aria-label="AutoBoat home">
                            <img
                                src="/images/favicon.ico"
                                alt=""
                                aria-hidden="true"
                                width="24"
                                height="24"
                                loading="lazy"
                                className="block h-6 w-6 rounded-md object-contain dark:bg-white"
                            />
                            <span className="font-heading text-lg font-extrabold bg-[linear-gradient(135deg,var(--color-accent)_0%,var(--color-accent-2)_100%)] bg-clip-text text-transparent">
                                AutoBoat
                            </span>
                        </Link>
                        <p className="max-w-sm text-sm text-fontcolor/70 leading-relaxed">
                            Virginia Tech's autonomous surface vessel design team.
                        </p>
                    </div>

                    {/* Page links */}
                    <div className="flex flex-col items-center gap-2 min-[900px]:items-center">
                        <h2 className="m-0 text-xs font-bold uppercase tracking-wider text-fontcolor/50">Page Links</h2>
                        <nav
                            aria-label="Footer"
                            className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 min-[900px]:justify-center"
                        >
                            {NAV_LINKS.map((link) => (
                                <Link
                                    key={link.to}
                                    to={link.to}
                                    className="text-sm font-semibold text-fontcolor no-underline transition-colors duration-150 hover:text-accent"
                                >
                                    {link.label}
                                </Link>
                            ))}
                        </nav>
                    </div>

                    {/* Socials */}
                    <div className="flex flex-col items-center gap-2 min-[900px]:items-center">
                        <h2 className="m-0 text-xs font-bold uppercase tracking-wider text-fontcolor/50">Socials</h2>
                        <ul className="m-0 flex list-none items-center gap-4">
                            {SOCIAL_LINKS.map(({ href, label, icon: Icon }) => (
                                <li key={label}>
                                    <a
                                        href={href}
                                        target={href.startsWith("mailto:") ? undefined : "_blank"}
                                        rel={href.startsWith("mailto:") ? undefined : "noopener noreferrer"}
                                        className="inline-flex items-center justify-center text-fontcolor/70 transition-colors duration-150 hover:text-accent"
                                        aria-label={label}
                                    >
                                        <Icon size={18} strokeWidth={2.25} />
                                        <span className="sr-only">{label} (opens in a new tab)</span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {/* Donate CTA */}
                    <a
                        href={DONATE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 px-3 py-1 text-xs font-semibold text-fontcolor no-underline whitespace-nowrap transition-[background-color,color,border-color,transform] duration-200 hover:-translate-y-px hover:border-accent hover:bg-accent hover:text-white min-[900px]:px-4 min-[900px]:py-1.5 min-[900px]:text-sm"
                    >
                        <Heart size={14} strokeWidth={2.5} className="text-accent-2" />
                        Support AutoBoat
                        <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                </div>

                {/* Copyright */}
                <span className="mt-4 block text-center text-xs text-fontcolor/60 min-[900px]:mt-3">
                    © {YEAR} AutoBoat @ Virginia Tech
                </span>
            </div>
        </footer>
    );
}
