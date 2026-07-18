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
}

const SUBTEAM_NAV: SubteamNavItem[] = [
    { id: "software", label: "Software", dot: "software" },
    { id: "electronics", label: "Electronics", dot: "electronics" },
    { id: "vehicle-dynamics", label: "Vehicle Dynamics", dot: "mechanical" },
    { id: "business", label: "Business", dot: "business" }
];

const SUBTEAMS: Subteam[] = [
    {
        id: "software",
        label: "Software",
        dot: "software",
        title: "Software",
        description:
            "The Software Subteam develops the autonomous navigation systems, computer vision algorithms, and control software that enable our boats to sail and navigate independently. We work with Python, C++, ROS (Robot Operating System), Gazebo, YOLO, and Docker to create an intelligent autopilot software package. We also develop custom groundstation software to control and monitor our boats from the shore, and we maintain and work on the codebase for our website. We are looking for competent full stack software engineers who are interested in working on autonomous systems! If you would like to check out some of our code, most of it is open source! and is available on our GitHub.",
        images: [
            { src: "/images/our_team_images/software/computer_vision1.webp", alt: "Computer Vision System" },
            { src: "/images/our_team_images/software/groundstation.webp", alt: "Ground Station Software" },
            { src: "/images/our_team_images/software/simulation.webp", alt: "Simulation Environment" },
            { src: "/images/our_team_images/electronics/electronics2.webp", alt: "Electronics 2" }
        ],
        githubLink: true
    },
    {
        id: "electronics",
        label: "Electronics",
        dot: "electronics",
        title: "Electronics",
        description:
            "The Electronics Subteam develops the infrastructure to bridge the barrier between software algorithms and the real-world contraints of our boats. We design and manufacture custom PCBs, collect data from sensors and actuators, and develop low-level firmware to interface with motors, pumps, and other electromechanical systems. Our workflow includes PCB design in KiCAD, electronics simulations in LTSpice, embedded programming in C++, and prototype development using tools like oscilloscopes and logic analyzers. We are building the nervous system of the boat, its veins and tendons. If you're into electronics, embedded systems, or just like to solder, we will happily welcome you to our team!",
        images: [
            { src: "/images/our_team_images/electronics/electronics1.webp", alt: "Electronics 1" },
            { src: "/images/our_team_images/electronics/electronics3.webp", alt: "Electronics 3" },
            { src: "/images/our_team_images/electronics/electronics4.webp", alt: "Electronics 4" },
            { src: "/images/our_team_images/electronics/electronics5.webp", alt: "Electronics 5" },
            { src: "/images/our_team_images/electronics/electronics6.webp", alt: "Electronics 6" }
        ]
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
            { src: "/images/our_team_images/mechanical/mech3.webp", alt: "Mechanical assembly work" }
        ]
    },
    {
        id: "business",
        label: "Business",
        dot: "business",
        title: "Business",
        description:
            "The Business subteam handles team outreach, sponsorship acquisition, budget management, and public relations. This team maintains relationships with sponsors, creates promotional materials, and manage team finances.",
        images: []
    }
];

interface DescriptionProps {
    text: string;
    githubLink?: boolean;
}

// Renders description text with an inline GitHub link when applicable
function Description({ text, githubLink }: DescriptionProps) {
    if (!githubLink) return <p className="subteam-description">{text}</p>;

    const parts = text.split("GitHub.");
    return (
        <p className="subteam-description">
            {parts[0]}
            <a href="https://github.com/autoboat-vt" target="_blank" rel="noopener noreferrer">
                GitHub<span className="visually-hidden"> (opens in a new tab)</span>
            </a>
            {parts.length > 1 ? `.${parts.slice(1).join("")}` : ""}
        </p>
    );
}

export default function OurTeam() {
    const [modalImage, setModalImage] = useState<GalleryImage | null>(null);

    // Apply the page-ourteam class to <body> for scoped gallery styles
    useEffect(() => {
        document.body.classList.add("page-ourteam");
        return () => document.body.classList.remove("page-ourteam");
    }, []);

    return (
        <div className="page-ourteam">
            <section className="section" id="toc">
                <Card>
                    <h3>Subteams</h3>
                    <nav className="subteam-grid">
                        {SUBTEAM_NAV.map((s) => (
                            <a key={s.id} href={`#${s.id}`} className="subteam-badge">
                                <span className={`subteam-badge__dot subteam-badge__dot--${s.dot}`}></span>
                                {s.label}
                            </a>
                        ))}
                    </nav>
                </Card>
            </section>

            <div id="subteams-section">
                {SUBTEAMS.map((subteam) => (
                    <Card key={subteam.id} id={subteam.id}>
                        <h3 className="subteam-title">{subteam.title}</h3>
                        <Description text={subteam.description} githubLink={subteam.githubLink} />
                        {subteam.images.length > 0 && (
                            <Gallery
                                images={subteam.images}
                                ariaLabel={`${subteam.title} gallery`}
                                onImageClick={(img) => setModalImage(img)}
                            />
                        )}
                    </Card>
                ))}
            </div>

            <ImageModal src={modalImage?.src} alt={modalImage?.alt} onClose={() => setModalImage(null)} />
        </div>
    );
}
