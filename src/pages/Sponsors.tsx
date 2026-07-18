import { ArrowRight, Check, ExternalLink, Heart, Mail } from "lucide-react";
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
            "Annual impact report"
        ]
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
            "Private team demo & lab tour"
        ]
    },
    {
        id: "silver",
        name: "Silver",
        contribution: "$2,500+",
        accent: "#94a3b8",
        benefits: ["Logo on website", "Logo on team apparel", "Invitation to lab tour"]
    },
    {
        id: "bronze",
        name: "Bronze",
        contribution: "$1,000+",
        accent: "#a16207",
        benefits: ["Logo on website", "Recognition in team communications"]
    }
];

const SPONSORS: Sponsor[] = [
    {
        name: "Virginia Tech College of Engineering",
        tier: "platinum",
        website: "https://eng.vt.edu/",
        description:
            "Our foundational sponsor, providing lab space, resources, and ongoing support that makes everything we do possible."
    }
];

const TIER_ACCENT_BG: Record<TierId, string> = {
    platinum: "bg-[linear-gradient(135deg,#6b7280_0%,#4b5563_100%)]",
    gold: "bg-[linear-gradient(135deg,#eab308_0%,#ca8a04_100%)]",
    silver: "bg-[linear-gradient(135deg,#cbd5e1_0%,#94a3b8_100%)]",
    bronze: "bg-[linear-gradient(135deg,#d97706_0%,#92400e_100%)]"
};

// Light-mode accent colors work on the cream card background; dark-mode
// variants use brighter shades so tier names and check icons stay legible
// on the translucent dark card (WCAG AA contrast on #1f1e1d).
const TIER_ACCENT_TEXT: Record<TierId, string> = {
    platinum: "text-[#6b7280] dark:text-[#9ca3af]",
    gold: "text-[#eab308] dark:text-[#facc15]",
    silver: "text-[#64748b] dark:text-[#94a3b8]",
    bronze: "text-[#a16207] dark:text-[#fbbf24]"
};

function SponsorCard({ sponsor }: { sponsor: Sponsor }) {
    const tier = SPONSOR_TIERS.find((t) => t.id === sponsor.tier);

    return (
        <div className="group flex flex-col overflow-hidden rounded-2xl border border-black/6 bg-white/45 backdrop-blur-md transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.1)] dark:border-white/8 dark:bg-[rgba(30,29,28,0.5)] dark:hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.5)]">
            <div className={`flex h-32 items-center justify-center ${TIER_ACCENT_BG[sponsor.tier]}`}>
                {sponsor.logo ? (
                    <img
                        src={sponsor.logo}
                        alt={`${sponsor.name} logo`}
                        loading="lazy"
                        className="max-h-20 max-w-[80%] object-contain"
                    />
                ) : (
                    <span className="px-4 text-center text-lg font-bold text-white">{sponsor.name}</span>
                )}
            </div>
            <div className="flex flex-1 flex-col p-6">
                <div className="mb-3 flex items-center justify-between gap-3">
                    {sponsor.website ? (
                        <a
                            href={sponsor.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 font-heading text-lg font-extrabold no-underline transition-colors hover:text-hovercolor"
                        >
                            {sponsor.name}
                            <ExternalLink size={14} className="opacity-60" />
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                    ) : (
                        <h3 className="font-heading text-lg font-extrabold">{sponsor.name}</h3>
                    )}
                    {tier && (
                        <span
                            className={`shrink-0 rounded-full px-3 py-0.5 text-xs font-bold uppercase tracking-wide text-white ${TIER_ACCENT_BG[sponsor.tier]}`}
                        >
                            {tier.name}
                        </span>
                    )}
                </div>
                {sponsor.description && <p className="text-[0.95rem] leading-relaxed text-hovercolor">{sponsor.description}</p>}
            </div>
        </div>
    );
}

function TierCard({ tier }: { tier: SponsorTier }) {
    return (
        <div className="flex flex-col rounded-2xl border border-black/6 bg-white/45 p-6 backdrop-blur-md dark:border-white/8 dark:bg-[rgba(30,29,28,0.5)]">
            <div className="mb-4 flex items-baseline justify-between gap-2">
                <h3 className={`font-heading text-xl font-extrabold ${TIER_ACCENT_TEXT[tier.id]}`}>{tier.name}</h3>
                <span className="text-sm font-semibold text-hovercolor">{tier.contribution}</span>
            </div>
            <span className={`mb-4 h-1 w-full rounded-full ${TIER_ACCENT_BG[tier.id]}`} aria-hidden="true" />
            <ul className="m-0 flex-1 list-none space-y-2 p-0">
                {tier.benefits.map((benefit) => (
                    <li key={benefit} className="flex items-start gap-2 text-[0.95rem] leading-relaxed">
                        <Check size={16} className={`mt-0.5 shrink-0 ${TIER_ACCENT_TEXT[tier.id]}`} strokeWidth={3} />
                        <span>{benefit}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default function Sponsors() {
    return (
        <>
            <section className="hero hero--one">
                <div className="hero__title">
                    <h1>Our Sponsors</h1>
                    <p className="hero__subtitle">Partnering with the builders of tomorrow</p>
                </div>
                <div className="hero__scroll" aria-hidden="true">
                    <span className="hero__scroll-arrow"></span>
                </div>
            </section>

            <section className="section mx-auto grid max-w-275 gap-8 px-4 py-16">
                <Card>
                    <h3>Thank You</h3>
                    <p>
                        AutoBoat at Virginia Tech is a student-led design team that designs, builds, and competes with autonomous
                        robotic sailboats and high-power electric motorboats. None of this would be possible without the
                        generosity of our sponsors, who provide the funding, materials, and mentorship that power our work. We are
                        deeply grateful for their support.
                    </p>
                </Card>

                <div id="current-sponsors">
                    <h2 className="mb-6 text-center font-heading text-[clamp(22px,3vw,36px)] font-extrabold">Current Sponsors</h2>
                    <div className="mx-auto grid max-w-275 grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6 px-4">
                        {SPONSORS.map((sponsor) => (
                            <SponsorCard key={sponsor.name} sponsor={sponsor} />
                        ))}
                    </div>
                </div>

                <div id="sponsorship-tiers">
                    <h2 className="mb-2 text-center font-heading text-[clamp(22px,3vw,36px)] font-extrabold">
                        Sponsorship Tiers
                    </h2>
                    <p className="mx-auto mb-8 max-w-2xl text-center text-hovercolor">
                        We offer tiered sponsorship packages to fit any budget. Contributions may be monetary or in-kind
                        (materials, components, manufacturing, or services). All sponsors are recognized on our website; higher
                        tiers receive additional visibility on our vessels and team apparel.
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
                        Your sponsorship directly funds hull fabrication, electronics, sensors, batteries, and competition travel.
                        In return, you gain visibility and a direct recruiting pipeline to talented Virginia Tech engineering
                        students.
                    </p>
                    <p className="mb-6">
                        To discuss sponsorship opportunities, reach out to us at{" "}
                        <a href="mailto:autoboat@vt.edu">autoboat@vt.edu</a>. If you'd like to make a direct donation, you can do
                        so via Virginia Tech's giving portal below.
                    </p>
                    <div className="cta-actions mt-6 flex flex-wrap gap-4">
                        <a
                            href="https://giving.adv.vt.edu/gift?fund=821082&amt=25&frequency=onetime&desc=AutoBoat%20Design%20Team"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn inline-flex items-center justify-center gap-2 rounded-lg border-none bg-[linear-gradient(135deg,#373533_0%,#171615_100%)] px-6 py-3 text-base font-semibold text-bgcolor no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-[linear-gradient(135deg,#4d4a47_0%,#2b2928_100%)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)] active:translate-y-0 dark:bg-[linear-gradient(135deg,#ffffff_0%,#e2ded5_100%)] dark:hover:bg-[linear-gradient(135deg,#ffffff_0%,#f0eee6_100%)]"
                        >
                            <Heart size={18} className="btn__icon" />
                            Make a Gift / Donate
                            <ArrowRight size={18} className="btn__icon" />
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        <a
                            href="mailto:autoboat@vt.edu"
                            className="btn inline-flex items-center justify-center gap-2 rounded-lg border border-fontcolor bg-transparent px-6 py-3 text-base font-semibold text-fontcolor no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-fontcolor hover:text-bgcolor hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] active:translate-y-0"
                        >
                            <Mail size={18} className="btn__icon" />
                            Contact Us
                        </a>
                    </div>
                </Card>
            </section>
        </>
    );
}
