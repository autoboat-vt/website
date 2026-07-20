import { Menu, Moon, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useTheme } from "../hooks/useTheme";

interface NavLinkItem {
    to: string;
    label: string;
    end?: boolean;
}

const NAV_LINKS: NavLinkItem[] = [
    { to: "/", label: "About", end: true },
    { to: "/ourteam", label: "Meet the Team" },
    { to: "/fleet", label: "Our Fleet" },
    { to: "/sponsors", label: "Sponsors" },
    { to: "/live", label: "Live Map" },
];

export default function Header() {
    const [open, setOpen] = useState(false);
    const [animating, setAnimating] = useState(false);
    const { theme, toggleTheme } = useTheme();

    const closeMenu = () => {
        if (animating) return;
        setAnimating(true);
        setOpen(false);
        setTimeout(() => setAnimating(false), 300);
    };

    const toggleMenu = () => {
        if (animating) return;
        setAnimating(true);
        setOpen((prev) => !prev);
        setTimeout(() => setAnimating(false), 300);
    };

    useEffect(() => {
        document.body.style.overflow = open ? "hidden" : "";
        return () => {
            document.body.style.overflow = "";
        };
    }, [open]);

    return (
        <header>
            <nav
                className={`nav relative grid h-(--nav-height) grid-cols-[48px_1fr_auto] items-center bg-transparent px-4 min-[1200px]:grid-cols-[200px_1fr_200px]${open ? " nav--open" : ""}`}
                id="site-nav"
            >
                <div className="nav__brand flex min-w-0 items-center justify-self-start gap-2">
                    <Link
                        to="/"
                        aria-label="AutoBoat Home"
                        className="nav__logo inline-block h-8 w-8"
                        onClick={closeMenu}
                    >
                        <img
                            className="block h-8 w-8 rounded-md bg-white object-contain p-0.5"
                            src="/images/favicon.ico"
                            alt=""
                            aria-hidden="true"
                            width="32"
                            height="32"
                            loading="eager"
                            fetchPriority="high"
                            decoding="sync"
                        />
                    </Link>
                    <Link
                        to="/"
                        onClick={closeMenu}
                        className="hidden whitespace-nowrap font-heading font-bold text-fontcolor no-underline min-[1200px]:inline"
                    >
                        AutoBoat
                    </Link>
                </div>

                <div
                    className="nav__links flex items-center justify-self-center gap-6 whitespace-nowrap max-[1099px]:gap-5 max-[999px]:gap-4 max-[749px]:gap-3 max-[599px]:gap-2 max-[499px]:gap-1.5"
                    id="site-links"
                    aria-hidden={!open}
                >
                    {NAV_LINKS.map((link) => (
                        <NavLink
                            key={link.to}
                            to={link.to}
                            end={link.end}
                            className={({ isActive }) =>
                                `nav__link rounded-lg px-4 py-2 font-heading font-bold no-underline transition-[background-color,color] duration-200 ease-out max-[1099px]:px-3 max-[1099px]:py-1.5 max-[999px]:px-2.5 max-[999px]:py-1.5 max-[749px]:px-2 max-[749px]:py-1 max-[749px]:text-sm max-[599px]:px-1.5 max-[599px]:py-1 max-[499px]:px-1 max-[499px]:py-0.5 max-[499px]:text-xs${
                                    isActive
                                        ? " is-active bg-accent text-white hover:bg-accent hover:text-white"
                                        : " text-fontcolor hover:bg-black/5 dark:hover:bg-white/10"
                                }`
                            }
                            onClick={closeMenu}
                        >
                            {link.label}
                        </NavLink>
                    ))}
                </div>

                <div className="nav__actions flex items-center justify-self-end gap-2">
                    <button
                        className="nav__theme-toggle inline-flex h-9 w-9 items-center justify-center rounded-lg border-none bg-transparent text-fontcolor transition-colors duration-150 hover:bg-black/5 hover:text-hovercolor focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:hover:bg-white/10"
                        type="button"
                        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                        onClick={toggleTheme}
                    >
                        {theme === "dark" ? (
                            <Sun size={20} strokeWidth={2.25} />
                        ) : (
                            <Moon size={20} strokeWidth={2.25} />
                        )}
                    </button>

                    <button
                        className={`nav__toggle hidden rounded-lg border-none px-1 leading-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current max-[499px]:flex max-[499px]:items-center max-[499px]:gap-1.5${
                            open ? " bg-accent text-white" : " bg-transparent text-fontcolor hover:text-hovercolor"
                        }`}
                        type="button"
                        aria-label="Toggle menu"
                        aria-controls="site-links"
                        aria-expanded={open}
                        onClick={toggleMenu}
                    >
                        <span className="nav__icon block h-7 w-7" aria-hidden="true">
                            {open ? <X size={28} strokeWidth={2.5} /> : <Menu size={28} strokeWidth={2.5} />}
                        </span>
                    </button>
                </div>
            </nav>
        </header>
    );
}
