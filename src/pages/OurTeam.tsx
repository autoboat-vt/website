import { useEffect, useState } from "react";
import Card from "../components/Card";
import Gallery from "../components/Gallery";
import ImageModal from "../components/ImageModal";

interface GalleryImage {
    src: string;
    alt: string;
}

interface SubteamNavItem {
    id: string;
    label: string;
    dot: string;
}

interface Subteam extends SubteamNavItem {
    title: string;
    description: string;
    images: GalleryImage[];
    githubLink?: boolean;
    techStack: string[];
}

const SUBTEAMS: Subteam[] = [
    {
        id: "software",
        label: "Software",
        dot: "software",
        title: "Software",
        description:
            "The Software Subteam develops the autonomous navigation systems, computer vision algorithms, and control software that enable our boats to sail and navigate independently. We work with Python, C++, ROS (Robot Operating System), Gazebo, YOLO, and Docker to create an intelligent autopilot software package. We also develop custom groundstation software to control and monitor our boats from the shore, and we maintain and work on the codebase for our website. We are looking for competent full-stack software engineers who are interested in working on autonomous systems! If you would like to check out some of our code, most of it is open source and is available on our GitHub.",
        images: [
            { src: "/images/our_team_images/software/computer_vision1.webp", alt: "Computer Vision System" },
            { src: "/images/our_team_images/software/groundstation.webp", alt: "Ground Station Software" },
            { src: "/images/our_team_images/software/simulation.webp", alt: "Simulation Environment" },
            { src: "/images/our_team_images/electronics/electronics2.webp", alt: "Electronics 2" },
        ],
        githubLink: true,
        techStack: ["Python", "C++", "ROS", "Gazebo", "YOLO", "Docker", "Computer Vision", "Linux", "GitHub Actions"],
    },
    {
        id: "electronics",
        label: "Electronics",
        dot: "electronics",
        title: "Electronics",
        description:
            "The Electronics Subteam develops the infrastructure to bridge the barrier between software algorithms and the real-world constraints of our boats. We design and manufacture custom PCBs, collect data from sensors and actuators, and develop low-level firmware to interface with motors, pumps, and other electromechanical systems. Our workflow includes PCB design in KiCAD, electronics simulations in LTSpice, embedded programming in C++, and prototype development using tools like oscilloscopes and logic analyzers. We are building the nervous system of the boat, its veins and tendons. If you're into electronics, embedded systems, or just like to solder, we will happily welcome you to our team!",
        images: [
            { src: "/images/our_team_images/electronics/electronics1.webp", alt: "Electronics 1" },
            { src: "/images/our_team_images/electronics/electronics3.webp", alt: "Electronics 3" },
            { src: "/images/our_team_images/electronics/electronics4.webp", alt: "Electronics 4" },
            { src: "/images/our_team_images/electronics/electronics5.webp", alt: "Electronics 5" },
            { src: "/images/our_team_images/electronics/electronics6.webp", alt: "Electronics 6" },
        ],
        techStack: ["KiCAD", "LTSpice", "C++", "Embedded Systems", "PCB Design"],
    },
    {
        id: "vehicle-dynamics",
        label: "Vehicle Dynamics",
        dot: "mechanical",
        title: "Vehicle Dynamics",
        description:
            "The Vehicle Dynamics Subteam designs, builds, and optimizes the physical structure and propulsion systems of our vessels. We focus on the performance, durability, and maneuverability of the hull, rigging, and mechanical subsystems. Using Orca3D, Fusion 360, SailCad, and principles of airfoil and hydrodynamic theory, we design and optimize hull shapes and wingsails for speed, stability, and control. Our workflow includes CAD modeling, finite element analysis, material selection, fiberglass layups, structural repairs, weight distribution planning, and hands-on fabrication (utilizing 3D printing, CNC machining, laser cutting, and sail patterning/sewing). By transforming ideas into watertight systems, we serve as the physical backbone of the boat. Whether you're interested in naval architecture, aerodynamics, mechanical design, turning wrenches, or making hardware that just works, there's a place for you on our team!",
        images: [
            { src: "/images/our_team_images/navarch/michio_spray_paint.webp", alt: "Hull Design and Construction" },
            { src: "/images/our_team_images/mechanical/mech1.webp", alt: "Mechanical fabrication and assembly" },
            { src: "/images/our_team_images/sail/michio_sail.webp", alt: "Sail Design and Testing" },
            { src: "/images/our_team_images/navarch/boat1.webp", alt: "Vessel Hull 1" },
            { src: "/images/our_team_images/mechanical/mech2.webp", alt: "Mechanical design testing" },
            { src: "/images/our_team_images/sail/sail1.webp", alt: "Sail construction and rigging" },
            { src: "/images/our_team_images/navarch/boat2.webp", alt: "Vessel Hull 2" },
            { src: "/images/our_team_images/mechanical/mech3.webp", alt: "Mechanical assembly work" },
        ],
        techStack: ["Orca3D", "Fusion 360", "SailCad", "FEA", "Fiberglass", "3D Printing", "CNC"],
    },
    {
        id: "business",
        label: "Business",
        dot: "business",
        title: "Business",
        description:
            "The Business subteam handles team outreach, sponsorship acquisition, budget management, and public relations. This team maintains relationships with sponsors, creates promotional materials, and manage team finances.",
        images: [],
        techStack: ["Sponsorship", "Budgeting", "PR", "Marketing"],
    },
];

interface DescriptionProps {
    text: string;
    githubLink?: boolean;
}

function Description({ text, githubLink }: DescriptionProps) {
    if (!githubLink) return <p className="subteam-description">{text}</p>;

    const parts = text.split("GitHub.");
    return (
        <p className="subteam-description">
            {parts[0]}
            <a href="https://github.com/autoboat-vt" target="_blank" rel="noopener noreferrer">
                GitHub<span className="sr-only"> (opens in a new tab)</span>
            </a>
            {parts.length > 1 ? `.${parts.slice(1).join("")}` : ""}
        </p>
    );
}

export default function OurTeam() {
    const [modalImage, setModalImage] = useState<GalleryImage | null>(null);
    useEffect(() => {
        document.body.classList.add("page-ourteam");
        return () => document.body.classList.remove("page-ourteam");
    }, []);

    return (
        <div className="page-ourteam">
            <div id="subteams-section" className="section mx-auto grid max-w-275 gap-4 px-4 pt-10 pb-12">
                {SUBTEAMS.map((subteam, i) => (
                    <div key={subteam.id} className="contents">
                        <div
                            id={subteam.id}
                            className={`fleet-section-title mx-auto flex w-[min(1100px,90%)] flex-col items-center gap-3${i > 0 ? " mt-10" : ""}`}
                        >
                            <div className="flex w-full items-center gap-4">
                                <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
                                <h2 className="m-0! font-heading text-[clamp(20px,3vw,32px)] font-extrabold">
                                    <span
                                        className={`subteam-badge__dot subteam-badge__dot--${subteam.dot} mr-3 inline-block h-3 w-3 rounded-full align-middle`}
                                    ></span>
                                    {subteam.title}
                                </h2>
                                <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
                            </div>
                        </div>
                        <Card className={`subteam-card subteam-card--${subteam.dot} my-2! border-l-4! p-8!`}>
                            <Description text={subteam.description} githubLink={subteam.githubLink} />
                            {subteam.techStack.length > 0 && (
                                <div className="mt-4 flex flex-wrap gap-2">
                                    {subteam.techStack.map((tech) => (
                                        <span
                                            key={tech}
                                            className="rounded-full border border-black/8 bg-black/5 px-3 py-1 font-mono text-[0.75rem] font-medium text-fontcolor/80 dark:border-white/10 dark:bg-white/10 dark:text-fontcolor/80"
                                        >
                                            {tech}
                                        </span>
                                    ))}
                                </div>
                            )}
                            {subteam.images.length > 0 && (
                                <Gallery
                                    images={subteam.images}
                                    ariaLabel={`${subteam.title} gallery`}
                                    onImageClick={(img) => setModalImage(img)}
                                />
                            )}
                        </Card>
                    </div>
                ))}
            </div>

            <ImageModal src={modalImage?.src} alt={modalImage?.alt} onClose={() => setModalImage(null)} />
        </div>
    );
}
