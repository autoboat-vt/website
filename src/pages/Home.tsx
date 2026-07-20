import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import Card from "../components/Card";

interface Subteam {
    id: string;
    label: string;
    dot: string;
}

const SUBTEAMS: Subteam[] = [
    { id: "software", label: "Software", dot: "software" },
    { id: "electronics", label: "Electronics", dot: "electronics" },
    { id: "vehicle-dynamics", label: "Vehicle Dynamics", dot: "mechanical" },
    { id: "business", label: "Business", dot: "business" },
];

export default function Home() {
    return (
        <>
            <section className="hero hero--one">
                <div className="hero__title">
                    <h1>AutoBoat @ Virginia Tech</h1>
                    <p className="hero__subtitle">Autonomous Electric Motorboats and Sailboats</p>
                </div>
                <div className="hero__scroll" aria-hidden="true">
                    <span className="hero__scroll-arrow"></span>
                </div>
            </section>

            <section className="section mx-auto grid max-w-275 gap-4 px-4 py-16">
                <Card>
                    <h3>About</h3>
                    <p>
                        Founded in 2012, AutoBoat at VT is a student-led engineering design team in the Ware Lab that
                        designs and manufactures fully autonomous robotic sailboats and high-power electric motor boats
                        for the International Robotic Sailing Regatta and Promoting Electric Propulsion (PEP)
                        competitions. We design and build our hulls, electronics, and software from scratch.
                    </p>
                </Card>

                <Card>
                    <h3>Why Join AutoBoat?</h3>
                    <p>
                        On AutoBoat, you will gain hands-on experience in robotics, naval architecture, electronics, and
                        software development while working on cutting-edge technology. The skills you learn are
                        invaluable to employers for internships and jobs; you'll also have the freedom to work on the
                        projects that excite you.
                    </p>
                </Card>

                <Card>
                    <h3>Getting Involved</h3>
                    <p>
                        The team is divided into four subteams. Click any subteam below to learn more about what we do
                        and see our work:
                    </p>
                    <div className="subteam-grid my-6 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                        {SUBTEAMS.map((s) => (
                            <Link
                                key={s.id}
                                to={`/ourteam#${s.id}`}
                                className={`subteam-badge subteam-badge--home flex items-center gap-3 rounded-lg border border-black/5 bg-black/3 px-4 py-3 text-base font-semibold text-fontcolor no-underline transition-[background,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-black/10 hover:bg-black/6 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-fontcolor dark:border-white/5 dark:bg-white/3 dark:hover:border-white/10 dark:hover:bg-white/6 subteam-card--${s.dot}`}
                            >
                                <span
                                    className={`subteam-badge__dot subteam-badge__dot--${s.dot} h-2.5 w-2.5 rounded-full`}
                                ></span>
                                {s.label}
                            </Link>
                        ))}
                    </div>
                    <p>
                        We are always looking for new members to join the team throughout the year, so don't hesitate to
                        reach out! There is no experience required; we'll teach you everything you need to know.
                    </p>
                </Card>

                <Card>
                    <h3>Sponsor AutoBoat</h3>
                    <p>
                        We're always looking for sponsors to help us build better boats. If you or your organization are
                        interested in partnering with us, please reach out.
                    </p>
                    <p className="mb-6">
                        If you are an individual looking to make a direct donation, please see the below link.
                    </p>
                    <div className="cta-actions mt-6 flex flex-wrap gap-4">
                        <a
                            href="https://giving.adv.vt.edu/gift?fund=821082&amt=25&frequency=onetime&desc=AutoBoat%20Design%20Team"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn inline-flex items-center justify-center gap-2 rounded-lg border border-black/10 bg-white px-6 py-3 text-base font-semibold text-fontcolor no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-black/3 hover:border-black/20 hover:shadow-[0_4px_12px_rgba(0,0,0,0.05)] active:translate-y-0 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10 dark:hover:border-white/20 dark:hover:shadow-[0_4px_12px_rgba(255,255,255,0.05)]"
                        >
                            Make a Gift / Donate
                            <ArrowRight size={18} className="btn__icon" />
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        <a
                            href="mailto:autoboat@vt.edu"
                            className="btn inline-flex items-center justify-center gap-2 rounded-lg border border-accent bg-transparent px-6 py-3 text-base font-semibold text-fontcolor no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-accent hover:text-white hover:shadow-[0_4px_12px_rgba(134,31,65,0.15)] active:translate-y-0"
                        >
                            Email Sponsorship
                        </a>
                    </div>
                </Card>
            </section>
        </>
    );
}
