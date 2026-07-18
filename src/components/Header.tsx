import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";

interface NavLinkItem {
    to: string;
    label: string;
    end?: boolean;
}

const NAV_LINKS: NavLinkItem[] = [
    { to: "/", label: "About", end: true },
    { to: "/ourteam", label: "Meet the Team" },
    { to: "/fleet", label: "Our Fleet" },
    { to: "/how-to-join", label: "How To Join" },
    { to: "/sponsors", label: "Sponsors" }
];

export default function Header() {
    const [open, setOpen] = useState(false);
    const [animating, setAnimating] = useState(false);

    // Close menu on route change
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

    // Lock body scroll when menu open on mobile
    useEffect(() => {
        document.body.style.overflow = open ? "hidden" : "";
        return () => {
            document.body.style.overflow = "";
        };
    }, [open]);

    return (
        <header>
            <nav className={`nav${open ? " nav--open" : ""}`} id="site-nav">
                <div className="nav__brand">
                    <Link
                        to="/"
                        aria-label="AutoBoat Home"
                        style={{ display: "inline-block", width: "32px", height: "32px" }}
                        onClick={closeMenu}
                    >
                        <img
                            className="nav__logo"
                            src="/images/favicon.ico"
                            alt=""
                            aria-hidden="true"
                            width="32"
                            height="32"
                            fetchPriority="high"
                            loading="eager"
                            decoding="sync"
                        />
                    </Link>
                    <Link to="/" onClick={closeMenu}>
                        AutoBoat
                    </Link>
                </div>

                <div className="nav__links" id="site-links" aria-hidden={!open}>
                    {NAV_LINKS.map((link) => (
                        <NavLink
                            key={link.to}
                            to={link.to}
                            end={link.end}
                            className={({ isActive }) => `nav__link${isActive ? " is-active" : ""}`}
                            onClick={closeMenu}
                        >
                            {link.label}
                        </NavLink>
                    ))}
                </div>

                <button
                    className="nav__toggle"
                    type="button"
                    aria-label="Toggle menu"
                    aria-controls="site-links"
                    aria-expanded={open}
                    onClick={toggleMenu}
                >
                    <svg
                        className="nav__icon"
                        width="32"
                        height="32"
                        viewBox="0 0 32 32"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                        focusable="false"
                    >
                        <rect y="6" width="32" height="4" rx="2" />
                        <rect y="14" width="32" height="4" rx="2" />
                        <rect y="22" width="32" height="4" rx="2" />
                    </svg>
                </button>
            </nav>
        </header>
    );
}
