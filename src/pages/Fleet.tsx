import Card from "../components/Card";

interface VesselSpec {
    label: string;
    value: string;
}

interface Hotspot {
    top: string;
    left: string;
    title: string;
    text: string;
    topTooltip?: boolean;
}

interface Vessel {
    name: string;
    subtitle: string;
    badge: string;
    badgeType: "active" | "todo";
    image: string;
    imageAlt: string;
    loading: "eager" | "lazy";
    description: string;
    specs: VesselSpec[];
    hotspots: Hotspot[];
    reverse: boolean;
}

const VESSELS: Vessel[] = [
    {
        name: "Theseus",
        subtitle: "Autonomous Motorboat",
        badge: "Active Vessel",
        badgeType: "active",
        image: "/images/gallery/14.webp",
        imageAlt: "Autonomous Motorboat - Theseus",
        loading: "eager",
        description:
            "Theseus is our high speed autonomous electric motorboat built for Promoting Electric Propulsion (PEP) races and obstacle avoidance. It features a high power electric powertrain, hydrodynamic fittings to optimize hull speed, and real-time computer vision buoy/boat tracking systems.",
        specs: [
            { label: "Length", value: "2 Meters" },
            { label: "Max Speed", value: "15 Knots" },
            { label: "Powertrain", value: "8kW Brushless DC" },
            { label: "Battery", value: "48V LiPo" },
            { label: "Sensors", value: "Compass, GPS, Camera, IMU" },
            { label: "Hull Material", value: "Fiberglass" }
        ],
        hotspots: [
            {
                top: "68%",
                left: "82%",
                title: "Propeller",
                text: "High-pitch underwater propeller optimized for maximum electric torque and speed."
            },
            {
                top: "65%",
                left: "78%",
                title: "Dual Rudder System",
                text: "High torque rudder system driven by a 4 bar linkage for quick turns."
            },
            {
                top: "60%",
                left: "68%",
                title: "Watertight Powertrain and Electronics",
                text: "Waterproof electronics and powertrain compartment housing the 8KW brushless DC motor, 48V LiPO batteries, and navigation hardware."
            },
            {
                top: "57%",
                left: "56%",
                title: "Navigation Sensors",
                text: "GPS, Compass, Camera, and IMU sensors for autonomous pathfinding."
            }
        ],
        reverse: false
    },
    {
        name: "Lumpy",
        subtitle: "Autonomous Sailboat",
        badge: "Active Vessel",
        badgeType: "active",
        image: "/images/gallery/13.webp",
        imageAlt: "Autonomous Sailboat - Lumpy",
        loading: "lazy",
        description:
            "Lumpy is our current autonomous sailing vessel, designed to compete in the International Robotic Sailing Regatta (also known as SailBOT). It features a fiberglass hull, custom-built rigging, and an extremely robust autonomous navigation software package that chooses optimal sailing routes and avoids obstacles in the water.",
        specs: [
            { label: "Length", value: "2 Meters" },
            { label: "Battery", value: "24V LiPo" },
            { label: "Sensors", value: "Anemometer, GPS, IMU, Compass, Camera" },
            { label: "Hull Material", value: "Fiberglass" }
        ],
        hotspots: [
            {
                top: "17%",
                left: "58%",
                topTooltip: true,
                title: "Carbon Fiber Mast",
                text: "Lightweight and high strength mast supporting the main sail amd jib rigging."
            },
            {
                top: "45%",
                left: "55%",
                title: "Main Sail",
                text: "Custom aerodynamic wing sail optimized for high lift-to-drag ratios."
            },
            {
                top: "48%",
                left: "68%",
                title: "The Jib",
                text: "Front triangular sail used to capture crosswinds and improve maneuverability."
            },
            {
                top: "85%",
                left: "58%",
                title: "Fiberglass Weighted Keel",
                text: "Weighted hydrodynamic keel using steel shot, which provides self righting stability and resists drifting."
            },
            {
                top: "70%",
                left: "60%",
                title: "Navigation Sensors",
                text: "Anemometer, GPS, IMU, Compass, and Camera sensors for autonomous pathfinding."
            }
        ],
        reverse: true
    },
    {
        name: "JetSki",
        subtitle: "Autonomous JetSki Project",
        badge: "In Development",
        badgeType: "todo",
        image: "/images/gallery/16.webp",
        imageAlt: "Autonomous Jetski - Concept Render",
        loading: "lazy",
        description:
            "Our newest engineering challenge: converting a standard jetski hull into a fully autonomous, electric jet propulsion vessel. The team is currently designing custom semi solid state battery packs, a robust and safe electrical system to manage the immense power required to drive the jetski, and jet impeller drive coupling.",
        specs: [],
        hotspots: [],
        reverse: false
    }
];

function Hotspot({ hotspot }: { hotspot: Hotspot }) {
    return (
        <div className={`hotspot${hotspot.topTooltip ? " hotspot--top" : ""}`} style={{ top: hotspot.top, left: hotspot.left }}>
            <div className="hotspot__pin"></div>
            <div className="hotspot__tooltip">
                <h4>{hotspot.title}</h4>
                <p>{hotspot.text}</p>
            </div>
        </div>
    );
}

function FleetCard({ vessel }: { vessel: Vessel }) {
    const imageCol = (
        <div className="fleet-card__image-col">
            <span className={`fleet-card__badge fleet-card__badge--${vessel.badgeType}`}>{vessel.badge}</span>
            <div className="fleet-image-container">
                <img src={vessel.image} alt={vessel.imageAlt} loading={vessel.loading} />
                {vessel.hotspots.map((h) => (
                    <Hotspot key={h.title} hotspot={h} />
                ))}
            </div>
        </div>
    );

    const infoCol = (
        <div className="fleet-card__info-col">
            <h2 className="fleet-card__title">{vessel.name}</h2>
            <span className="fleet-card__subtitle">{vessel.subtitle}</span>
            <p>{vessel.description}</p>
            {vessel.specs.length > 0 && (
                <div className="fleet-card__specs">
                    {vessel.specs.map((spec) => (
                        <div key={spec.label} className="fleet-card__spec-item">
                            <strong>{spec.label}</strong>
                            {spec.value}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <Card className={`fleet-card${vessel.reverse ? " fleet-card--reverse" : ""}`}>
            {vessel.reverse ? (
                <>
                    {infoCol}
                    {imageCol}
                </>
            ) : (
                <>
                    {imageCol}
                    {infoCol}
                </>
            )}
        </Card>
    );
}

export default function Fleet() {
    return (
        <section className="section" id="fleet-section">
            <h1 style={{ textAlign: "center", marginBottom: "2rem" }}>Our Fleet</h1>
            {VESSELS.map((vessel) => (
                <FleetCard key={vessel.name} vessel={vessel} />
            ))}
        </section>
    );
}
