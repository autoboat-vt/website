interface FooterLink {
    href: string;
    label: string;
    external: boolean;
}

const FOOTER_LINKS: FooterLink[] = [
    { href: "mailto:autoboat@vt.edu", label: "Email", external: false },
    {
        href: "https://giving.adv.vt.edu/gift?fund=821082&amt=25&frequency=onetime&desc=AutoBoat%20Design%20Team",
        label: "Donate",
        external: true
    },
    { href: "https://discord.gg/e34cdWdKbG", label: "Discord", external: true },
    { href: "https://github.com/autoboat-vt", label: "GitHub", external: true },
    {
        href: "https://www.linkedin.com/company/abvt",
        label: "LinkedIn",
        external: true
    }
];

export default function Footer() {
    return (
        <footer className="footer">
            <div className="footer__inner">
                <nav className="footer__links">
                    {FOOTER_LINKS.map((link) => (
                        <a
                            key={link.label}
                            href={link.href}
                            {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                        >
                            {link.label}
                            {link.external && <span className="visually-hidden"> (opens in a new tab)</span>}
                        </a>
                    ))}
                </nav>
                <small>AutoBoat @ Virginia Tech</small>
            </div>
        </footer>
    );
}
