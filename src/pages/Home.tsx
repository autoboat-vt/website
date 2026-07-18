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
    { id: "business", label: "Business", dot: "business" }
];

function DiscordIcon() {
    return (
        <svg
            className="btn__icon mr-1.5 inline-block align-middle"
            width="20"
            height="20"
            viewBox="0 0 127.14 96.36"
            fill="currentColor"
            role="img"
            aria-label="Discord logo"
        >
            <path d="M107.7,8.07A105.15,105.15,0,0,0,77.26,0a77.19,77.19,0,0,0-3.3,6.83A96.67,96.67,0,0,0,53.22,6.83,77.19,77.19,0,0,0,49.88,0,105.15,105.15,0,0,0,19.44,8.07C3.66,31.58-1.95,54.65,1,77.53a105.53,105.53,0,0,0,32,16.15,77.7,77.7,0,0,0,6.72-10.93,68.6,68.6,0,0,1-10.64-5.12c.91-.67,1.81-1.37,2.65-2.1a75.22,75.22,0,0,0,62,0c.84.73,1.74,1.43,2.65,2.1a68.6,68.6,0,0,1-10.64,5.12,77.7,77.7,0,0,0,6.72,10.93,105.53,105.53,0,0,0,32-16.15C129.66,50.24,123.75,27.34,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53S36.18,40.36,42.45,40.36,53.83,46,53.83,53,48.72,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.24,60,73.24,53S78.41,40.36,84.69,40.36,96.07,46,96.07,53,91,65.69,84.69,65.69Z" />
        </svg>
    );
}

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

            <section className="section mx-auto grid max-w-275 gap-8 px-4 py-16">
                <Card>
                    <h3>About</h3>
                    <p>
                        Founded in 2012, AutoBoat at VT is a student-led engineering design team in the Ware Lab that designs and
                        manufactures fully autonomous robotic sailboats and high-power electric motor boats for the International
                        Robotic Sailing Regatta and Promoting Electric Propulsion (PEP) competitions. We design and build our
                        hulls, electronics, and software from scratch.
                    </p>
                </Card>

                <Card>
                    <h3>Why Join AutoBoat?</h3>
                    <p>
                        On AutoBoat, you will gain hands-on experience in robotics, naval architecture, electronics, and software
                        development while working on cutting-edge technology. The skills you learn are invaluable to employers for
                        internships and jobs; you'll also have the freedom to work on the projects that excite you.
                    </p>
                </Card>

                <Card>
                    <h3>Our Subteams</h3>
                    <p>
                        The team is divided into 4 subteams. Click any subteam below to learn more about what we do and see our
                        work:
                    </p>
                    <div className="subteam-grid my-6 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
                        {SUBTEAMS.map((s) => (
                            <Link
                                key={s.id}
                                to={`/ourteam#${s.id}`}
                                className="subteam-badge flex items-center gap-3 rounded-lg border border-black/5 bg-black/3 px-4 py-3 text-base font-semibold text-fontcolor no-underline transition-[background,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-black/10 hover:bg-black/6 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-fontcolor dark:border-white/5 dark:bg-white/3 dark:hover:border-white/10 dark:hover:bg-white/6"
                            >
                                <span
                                    className={`subteam-badge__dot subteam-badge__dot--${s.dot} h-2.5 w-2.5 rounded-full`}
                                ></span>
                                {s.label}
                            </Link>
                        ))}
                    </div>
                    <p>
                        We are always looking for new members to join the team throughout the year, so don't hesitate to reach
                        out! There is no experience required; we'll teach you everything you need to know.
                    </p>
                </Card>

                <Card>
                    <h3>Join Our Discord Server!</h3>
                    <p className="mb-6">If you would like to get updates on what we are up to, join our Discord server.</p>
                    <div className="cta-actions mt-6 flex flex-wrap gap-4">
                        <a
                            href="https://discord.gg/e34cdWdKbG"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn inline-flex items-center justify-center gap-2 rounded-lg border-none bg-[#5865f2] px-6 py-3 text-base font-semibold text-white no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-[#4752c4] hover:shadow-[0_4px_12px_rgba(88,101,242,0.25)] active:translate-y-0"
                        >
                            <DiscordIcon />
                            Join Discord
                        </a>
                    </div>
                </Card>

                <Card>
                    <h3>Sponsor AutoBoat</h3>
                    <p>
                        We're always looking for sponsors to help us build better boats. If you or your organization are
                        interested in partnering with us, please reach out.
                    </p>
                    <p className="mb-6">If you are an individual looking to make a direct donation, please see the below link.</p>
                    <div className="cta-actions mt-6 flex flex-wrap gap-4">
                        <a
                            href="https://giving.adv.vt.edu/gift?fund=821082&amt=25&frequency=onetime&desc=AutoBoat%20Design%20Team"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn inline-flex items-center justify-center gap-2 rounded-lg border-none bg-[linear-gradient(135deg,#373533_0%,#171615_100%)] px-6 py-3 text-base font-semibold text-bgcolor no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-[linear-gradient(135deg,#4d4a47_0%,#2b2928_100%)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)] active:translate-y-0 dark:bg-[linear-gradient(135deg,#ffffff_0%,#e2ded5_100%)] dark:hover:bg-[linear-gradient(135deg,#ffffff_0%,#f0eee6_100%)]"
                        >
                            Make a Gift / Donate
                            <ArrowRight size={18} className="btn__icon" />
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                        <a
                            href="mailto:autoboat@vt.edu"
                            className="btn inline-flex items-center justify-center gap-2 rounded-lg border border-fontcolor bg-transparent px-6 py-3 text-base font-semibold text-fontcolor no-underline transition-[background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-fontcolor hover:text-bgcolor hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] active:translate-y-0"
                        >
                            Email Sponsorship
                        </a>
                    </div>
                </Card>
            </section>
        </>
    );
}
