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
        <footer className="relative border-t border-black/6 bg-transparent px-4 py-8 dark:border-white/10">
            <div className="mx-auto flex max-w-275 flex-col items-center text-center font-semibold text-fontcolor">
                <nav className="mb-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-4">
                    {FOOTER_LINKS.map((link) => (
                        <a
                            key={link.label}
                            href={link.href}
                            className="rounded-lg border border-black/6 bg-black/3 px-3.5 py-1.5 text-[0.95rem] font-semibold text-fontcolor no-underline transition-[background-color,color,border-color,transform] duration-200 hover:-translate-y-px hover:border-fontcolor hover:bg-fontcolor hover:text-bgcolor dark:border-white/6 dark:bg-white/3"
                            {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                        >
                            {link.label}
                            {link.external && <span className="sr-only"> (opens in a new tab)</span>}
                        </a>
                    ))}
                </nav>
                <small className="text-fontcolor">AutoBoat @ Virginia Tech</small>
            </div>
        </footer>
    );
}
