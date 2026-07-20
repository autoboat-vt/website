import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import Card from "../components/Card";
import Hyperlink, { url } from "../components/Hyperlink";

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
                <a href="#about" className="hero__scroll" aria-label="Scroll to about section">
                    <span className="hero__scroll-arrow"></span>
                </a>
            </section>

            <section id="about" className="section mx-auto grid max-w-275 gap-4 px-4 py-16">
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
                        The team is divided into four subteams. To learn more about each subteam, click the links below
                        to jump to their respective sections on the
                        <Hyperlink href={url("/ourteam")} space="both">
                            Meet the Team
                        </Hyperlink>
                        page.
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
                    <div id="how-to-join-box" className="mt-4 flex flex-col items-center">
                        <Hyperlink
                            href={url(
                                "https://docs.google.com/forms/d/e/1FAIpQLScViTYzAYHl671SGp_dmYO9MvrleM3VWAem8Ep7FROBCVOB9Q/viewform?usp=sharing&ouid=116978117130571796595",
                            )}
                            className="btn mt-2 w-fit text-2xl px-4 py-2 bg-accent text-white border-transparent hover:bg-accent-2 hover:text-white hover:border-transparent"
                        >
                            Join Now!
                        </Hyperlink>
                    </div>
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
                    <div className="cta-actions mt-6 flex flex-wrap justify-center gap-4">
                        <Hyperlink
                            href={url(
                                "https://giving.adv.vt.edu/gift?fund=821082&amt=25&frequency=onetime&desc=AutoBoat%20Design%20Team",
                            )}
                            className="btn bg-accent text-white border-transparent hover:bg-accent-2 hover:text-white hover:border-transparent"
                        >
                            Make a Gift / Donate
                            <ArrowRight size={18} className="btn__icon" />
                        </Hyperlink>
                        <Hyperlink
                            href={url("mailto:autoboat@vt.edu")}
                            className="btn bg-accent text-white border-transparent hover:bg-accent-2 hover:text-white hover:border-transparent"
                        >
                            Email Sponsorship
                        </Hyperlink>
                    </div>
                </Card>
            </section>
        </>
    );
}
