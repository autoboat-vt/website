import { ArrowRight, ArrowUpRight, Heart, Landmark, Mail } from "lucide-react";
import Card from "../components/Card";

type TierId = "platinum" | "gold" | "silver" | "bronze";

interface Sponsor {
    name: string;
    tier: TierId;
    logo?: string;
    website?: string;
    description?: string;
}

interface SponsorTier {
    id: TierId;
    name: string;
    contribution: string;
    accent: string;
    benefits: string[];
}

const SPONSOR_TIERS: SponsorTier[] = [
    {
        id: "platinum",
        name: "Platinum",
        contribution: "$10,000+",
        accent: "#6b7280",
        benefits: [
            "Large logo on vessel hull",
            "Premium placement on website & team apparel",
            "Direct recruiting access to team members",
            "Named vessel or major component",
            "Private team demo & lab tour",
            "Annual impact report",
        ],
    },
    {
        id: "gold",
        name: "Gold",
        contribution: "$5,000+",
        accent: "#eab308",
        benefits: [
            "Logo on vessel hull",
            "Logo on website & team apparel",
            "Recruiting access to team members",
            "Private team demo & lab tour",
        ],
    },
    {
        id: "silver",
        name: "Silver",
        contribution: "$2,500+",
        accent: "#94a3b8",
        benefits: ["Logo on website", "Logo on team apparel", "Invitation to lab tour"],
    },
    {
        id: "bronze",
        name: "Bronze",
        contribution: "$1,000+",
        accent: "#a16207",
        benefits: ["Logo on website", "Recognition in team communications"],
    },
];

const SPONSORS: Sponsor[] = [
    {
        name: "Virginia Tech College of Engineering",
        tier: "platinum",
        website: "https://eng.vt.edu/",
        description:
            "Our foundational sponsor, providing lab space, resources, and ongoing support that makes everything we do possible.",
    },
];

const TIER_ACCENT_BG: Record<TierId, string> = {
    platinum: "bg-[linear-gradient(135deg,#6b7280_0%,#4b5563_100%)]",
    gold: "bg-[linear-gradient(135deg,#eab308_0%,#ca8a04_100%)]",
    silver: "bg-[linear-gradient(135deg,#cbd5e1_0%,#94a3b8_100%)]",
    bronze: "bg-[linear-gradient(135deg,#d97706_0%,#92400e_100%)]",
};

const TIER_ACCENT_TEXT: Record<TierId, string> = {
    platinum: "text-[#6b7280] dark:text-[#9ca3af]",
    gold: "text-[#eab308] dark:text-[#facc15]",
    silver: "text-[#64748b] dark:text-[#94a3b8]",
    bronze: "text-[#a16207] dark:text-[#fbbf24]",
};

function SponsorCard({ sponsor }: { sponsor: Sponsor }) {
    const tier = SPONSOR_TIERS.find((t) => t.id === sponsor.tier);

    return (
        <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-black/6 bg-white/45 text-left backdrop-blur-md transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-1 hover:shadow-[0_25px_50px_-15px_rgba(134,31,65,0.18)] hover:border-accent/30 dark:border-white/8 dark:bg-[rgba(30,29,28,0.5)] dark:hover:shadow-[0_25px_50px_-15px_rgba(229,117,31,0.25)] dark:hover:border-accent-2/30">
            {/* Accent glow that appears on hover */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                    background: "radial-gradient(circle at 50% 0%, rgba(229,117,31,0.08) 0%, transparent 70%)",
                }}
            />
            {/* Top accent band */}
            <div
                className={`relative flex h-36 items-center justify-center overflow-hidden ${TIER_ACCENT_BG[sponsor.tier]}`}
            >
                <div
                    className="absolute inset-0 opacity-30"
                    style={{
                        backgroundImage:
                            "radial-gradient(circle at 25% 25%, rgba(255,255,255,0.3) 0%, transparent 50%), radial-gradient(circle at 75% 75%, rgba(255,255,255,0.15) 0%, transparent 50%)",
                    }}
                    aria-hidden="true"
                />
                {sponsor.logo ? (
                    <img
                        src={sponsor.logo}
                        alt={`${sponsor.name} logo`}
                        loading="lazy"
                        className="relative max-h-20 max-w-[75%] object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.15)]"
                    />
                ) : (
                    <Landmark
                        size={48}
                        strokeWidth={1.5}
                        className="relative text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.2)]"
                        aria-hidden="true"
                    />
                )}
                {/* Tier badge — pinned to bottom-left of the band */}
                {tier && (
                    <span className="absolute bottom-3 left-4 rounded-full bg-black/25 px-3 py-1 text-xs font-bold uppercase tracking-[0.08em] text-white backdrop-blur-sm">
                        {tier.name}
                    </span>
                )}
            </div>
            <div className="flex flex-1 flex-col p-6">
                <h3 className="mb-2 font-heading text-lg font-extrabold leading-tight">
                    {sponsor.website ? (
                        <a
                            href={sponsor.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-start gap-1.5 no-underline transition-colors hover:text-hovercolor"
                        >
                            {sponsor.name}
                            <ArrowUpRight
                                size={16}
                                className="mt-0.5 shrink-0 opacity-50 transition-opacity group-hover:opacity-100"
                            />
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                    ) : (
                        sponsor.name
                    )}
                </h3>
                {sponsor.description && (
                    <p className="text-[0.95rem] leading-relaxed text-hovercolor">{sponsor.description}</p>
                )}
            </div>
        </div>
    );
}

function TierCard({ tier }: { tier: SponsorTier }) {
    return (
        <div className="flex flex-col rounded-2xl border border-black/6 bg-white/45 p-6 text-left backdrop-blur-md dark:border-white/8 dark:bg-[rgba(30,29,28,0.5)]">
            <div className="mb-4 flex items-baseline justify-between gap-2">
                <h3 className={`font-heading text-xl font-extrabold ${TIER_ACCENT_TEXT[tier.id]}`}>{tier.name}</h3>
                <span className="text-sm font-semibold text-hovercolor">{tier.contribution}</span>
            </div>
            <span className={`mb-4 h-1 w-full rounded-full ${TIER_ACCENT_BG[tier.id]}`} aria-hidden="true" />
            <ul className="m-0 flex-1 list-none space-y-2 p-0">
                {tier.benefits.map((benefit) => (
                    <li key={benefit} className="relative flex items-start gap-2 pl-4 text-[0.95rem] leading-relaxed">
                        <span
                            className={`absolute left-0 top-[0.62em] h-1.5 w-1.5 shrink-0 rounded-full ${TIER_ACCENT_BG[tier.id]}`}
                            aria-hidden="true"
                        />
                        <span className="flex-1 min-w-0">{benefit}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default function Sponsors() {
    return (
        <section className="section mx-auto grid max-w-275 gap-8 px-4 py-16">
            <Card>
                <h3>Thank You</h3>
                <p>
                    AutoBoat at Virginia Tech is a student-led design team that designs, builds, and competes with
                    autonomous robotic sailboats and high-power electric motorboats. None of this would be possible
                    without the generosity of our sponsors, who provide the funding, materials, and mentorship that
                    power our work. We are deeply grateful for their support.
                </p>
            </Card>

            <div id="current-sponsors">
                <div className="text-center">
                    <h2 className="mb-6 font-heading text-[clamp(22px,3vw,36px)] font-extrabold">Our Sponsors</h2>
                </div>
                <div className="mx-auto grid max-w-275 grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6 px-4">
                    {SPONSORS.map((sponsor) => (
                        <SponsorCard key={sponsor.name} sponsor={sponsor} />
                    ))}
                </div>
            </div>

            <div id="sponsorship-tiers" className="blueprint-grid -mx-4 rounded-2xl px-4 py-8">
                <div className="text-center">
                    <h2 className="mb-2 font-heading text-[clamp(22px,3vw,36px)] font-extrabold">Partnership Levels</h2>
                </div>
                <p className="mx-auto mb-8 max-w-2xl text-center text-hovercolor">
                    We offer tiered sponsorship packages to fit any budget. Contributions may be monetary or in-kind
                    (materials, components, manufacturing, or services). All sponsors are recognized on our website;
                    higher tiers receive additional visibility on our vessels and team apparel.
                </p>
                <div className="mx-auto grid max-w-275 grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-6 px-4">
                    {SPONSOR_TIERS.map((tier) => (
                        <TierCard key={tier.id} tier={tier} />
                    ))}
                </div>
            </div>

            <Card id="become-a-sponsor">
                <h3>Become a Sponsor</h3>
                <p className="mb-2">
                    Your sponsorship directly funds hull fabrication, electronics, sensors, batteries, and competition
                    travel. In return, you gain visibility and a direct recruiting pipeline to talented Virginia Tech
                    engineering students.
                </p>
                <p className="mb-6">
                    To discuss sponsorship opportunities, reach out to us at{" "}
                    <a href="mailto:autoboat@vt.edu">autoboat@vt.edu</a>. If you'd like to make a direct donation, you
                    can do so via Virginia Tech's giving portal below.
                </p>
                <div className="cta-actions mt-6 flex flex-wrap gap-4">
                    <a
                        href="https://giving.adv.vt.edu/gift?fund=821082&amt=25&frequency=onetime&desc=AutoBoat%20Design%20Team"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn inline-flex items-center justify-center gap-2 rounded-lg border-none bg-[linear-gradient(135deg,var(--color-accent)_0%,var(--color-accent-2)_100%)] px-6 py-3 text-base font-semibold text-white no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(134,31,65,0.3)] active:translate-y-0"
                    >
                        <Heart size={18} className="btn__icon" />
                        Make a Gift / Donate
                        <ArrowRight size={18} className="btn__icon" />
                        <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                    <a
                        href="mailto:autoboat@vt.edu"
                        className="btn inline-flex items-center justify-center gap-2 rounded-lg border border-accent bg-transparent px-6 py-3 text-base font-semibold text-fontcolor no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-accent hover:text-white hover:shadow-[0_4px_12px_rgba(134,31,65,0.15)] active:translate-y-0"
                    >
                        <Mail size={18} className="btn__icon" />
                        Contact Us
                    </a>
                </div>
            </Card>
        </section>
    );
}
