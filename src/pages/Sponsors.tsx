import { ArrowRight, ArrowUpRight, Heart, Landmark, Mail } from "lucide-react";
import Card from "../components/Card";

interface Sponsor {
    name: string;
    logo?: string;
    website?: string;
    description?: string;
}

const SPONSORS: Sponsor[] = [
    {
        name: "Virginia Tech College of Engineering",
        website: "https://eng.vt.edu/",
        description:
            "Our foundational sponsor, providing lab space, resources, and ongoing support that makes everything we do possible.",
    },
    {
        name: "Polymaker",
        logo: "/images/sponsors/polymaker.svg",
        website: "https://polymaker.com",
        description:
            "Supplies the 3D printing filament we use for rapid prototyping and printed parts across the boat, from mounts and housings to fit-check jigs in the shop.",
    },
];

function SponsorCard({ sponsor }: { sponsor: Sponsor }) {
    return (
        <div className="group relative flex w-70 flex-col overflow-hidden rounded-2xl border border-cardborder bg-card text-left backdrop-blur-md">
            {/* Top accent band */}
            <div className="relative flex h-36 items-center justify-center overflow-hidden border-b border-black/5 bg-white">
                <div
                    className="absolute inset-0 opacity-10"
                    style={{
                        backgroundImage:
                            "radial-gradient(circle at 25% 25%, rgba(0,0,0,0.05) 0%, transparent 50%), radial-gradient(circle at 75% 75%, rgba(0,0,0,0.02) 0%, transparent 50%)",
                    }}
                    aria-hidden="true"
                />
                {sponsor.logo ? (
                    <img
                        src={sponsor.logo}
                        alt={`${sponsor.name} logo`}
                        loading="lazy"
                        className="relative max-h-20 max-w-[75%] object-contain"
                    />
                ) : (
                    <Landmark size={48} strokeWidth={1.5} className="relative text-accent/80" aria-hidden="true" />
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
                            <ArrowUpRight size={16} className="mt-0.5 shrink-0 opacity-60" />
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
                <div className="mx-auto flex max-w-275 flex-wrap justify-center gap-6 px-4">
                    {SPONSORS.map((sponsor) => (
                        <SponsorCard key={sponsor.name} sponsor={sponsor} />
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
                    <a href="mailto:autoboat@vt.edu" className="text-fontcolor underline decoration-current">
                        autoboat@vt.edu
                    </a>
                    . If you'd like to make a direct donation, you can do so via Virginia Tech's giving portal below.
                </p>
                <div className="cta-actions mt-6 flex flex-wrap gap-4">
                    <a
                        href="https://giving.adv.vt.edu/gift?fund=821082&amt=25&frequency=onetime&desc=AutoBoat%20Design%20Team"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn--primary"
                    >
                        <Heart size={18} className="btn__icon" />
                        Make a Gift / Donate
                        <ArrowRight size={18} className="btn__icon" />
                        <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                    <a href="mailto:autoboat@vt.edu" className="btn btn--outline">
                        <Mail size={18} className="btn__icon" />
                        Contact Us
                    </a>
                </div>
            </Card>
        </section>
    );
}
