import { type MouseEvent, useEffect, useRef, useState } from "react";
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
    status: "Active" | "In Development";
    image: string;
    imageAlt: string;
    objectPosition?: string;
    imageZoom?: number;
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
        status: "Active",
        image: "/images/gallery/14.webp",
        imageAlt: "Autonomous Motorboat - Theseus",
        objectPosition: "75% 70%",
        imageZoom: 1.75,
        loading: "eager",
        description:
            "Theseus is our high speed autonomous electric motorboat built for Promoting Electric Propulsion (PEP) races and obstacle avoidance. It features a high power electric powertrain, hydrodynamic fittings to optimize hull speed, and real-time computer vision buoy/boat tracking systems.",
        specs: [
            { label: "Length", value: "2 Meters" },
            { label: "Max Speed", value: "15 Knots" },
            { label: "Powertrain", value: "8kW Brushless DC" },
            { label: "Battery", value: "48V LiPo" },
            { label: "Sensors", value: "Compass, GPS, Camera, IMU" },
            { label: "Hull Material", value: "Fiberglass" },
        ],
        hotspots: [
            {
                top: "68%",
                left: "82%",
                title: "Propeller",
                text: "High-pitch underwater propeller optimized for maximum electric torque and speed.",
            },
            {
                top: "65%",
                left: "78%",
                title: "Dual Rudder System",
                text: "High torque rudder system driven by a 4 bar linkage for quick turns.",
            },
            {
                top: "60%",
                left: "68%",
                title: "Watertight Powertrain and Electronics",
                text: "Waterproof electronics and powertrain compartment housing the 8kW brushless DC motor, 48V LiPo batteries, and navigation hardware.",
            },
            {
                top: "57%",
                left: "56%",
                title: "Navigation Sensors",
                text: "GPS, Compass, Camera, and IMU sensors for autonomous pathfinding.",
            },
        ],
        reverse: false,
    },
    {
        name: "Lumpy",
        subtitle: "Autonomous Sailboat",
        status: "Active",
        image: "/images/gallery/13.webp",
        imageAlt: "Autonomous Sailboat - Lumpy",
        objectPosition: "35% 60%",
        loading: "lazy",
        description:
            "Lumpy is our current autonomous sailing vessel, designed to compete in the International Robotic Sailing Regatta (also known as SailBOT). It features a fiberglass hull, custom-built rigging, and an extremely robust autonomous navigation software package that chooses optimal sailing routes and avoids obstacles in the water.",
        specs: [
            { label: "Length", value: "2 Meters" },
            { label: "Battery", value: "24V LiPo" },
            { label: "Sensors", value: "Anemometer, GPS, IMU, Compass, Camera" },
            { label: "Hull Material", value: "Fiberglass" },
        ],
        hotspots: [
            {
                top: "17%",
                left: "58%",
                topTooltip: true,
                title: "Carbon Fiber Mast",
                text: "Lightweight and high strength mast supporting the main sail and jib rigging.",
            },
            {
                top: "45%",
                left: "55%",
                title: "Main Sail",
                text: "Custom aerodynamic wing sail optimized for high lift-to-drag ratios.",
            },
            {
                top: "48%",
                left: "68%",
                title: "The Jib",
                text: "Front triangular sail used to capture crosswinds and improve maneuverability.",
            },
            {
                top: "85%",
                left: "58%",
                title: "Fiberglass Weighted Keel",
                text: "Weighted hydrodynamic keel using steel shot, which provides self-righting stability and resists drifting.",
            },
            {
                top: "70%",
                left: "60%",
                title: "Navigation Sensors",
                text: "Anemometer, GPS, IMU, Compass, and Camera sensors for autonomous pathfinding.",
            },
        ],
        reverse: true,
    },
    {
        name: "JetSki",
        subtitle: "Autonomous JetSki Project",
        status: "In Development",
        image: "/images/gallery/16.webp",
        imageAlt: "Autonomous Jetski - Concept Render",
        objectPosition: "center 40%",
        loading: "lazy",
        description:
            "Our newest engineering challenge: converting a standard JetSki hull into a fully autonomous, electric jet propulsion vessel. The team is currently designing custom semi-solid-state battery packs, a robust and safe electrical system to manage the immense power required to drive the JetSki, and a jet impeller drive coupling.",
        specs: [],
        hotspots: [],
        reverse: false,
    },
];

function Hotspot({ hotspot }: { hotspot: Hotspot }) {
    const btnRef = useRef<HTMLButtonElement>(null);
    const tooltipRef = useRef<HTMLSpanElement>(null);

    // Shift the tooltip so it stays within the image container instead of
    // overflowing when a pin sits near an edge. Measured on hover/focus using
    // pre-transform layout sizes (offsetWidth/Height) so the scale(0.9) rest
    // state doesn't skew the calculation. Sets CSS vars imperatively to avoid
    // a one-frame flash before a React state update would land.
    const measure = () => {
        const btn = btnRef.current;
        const tip = tooltipRef.current;
        if (!btn || !tip) return;
        const container = btn.closest(".fleet-image-container");
        if (!container) return;
        const cRect = container.getBoundingClientRect();
        const bRect = btn.getBoundingClientRect();
        // The button has transform: translate(-50%, -50%), so its rect center
        // is the pin center.
        const pinX = bRect.left + bRect.width / 2 - cRect.left;
        const pinY = bRect.top + bRect.height / 2 - cRect.top;
        const tipW = tip.offsetWidth;
        const tipH = tip.offsetHeight;
        const margin = 8;

        let x = 0;
        const leftEdge = pinX - tipW / 2;
        const rightEdge = pinX + tipW / 2;
        if (leftEdge < margin) x = margin - leftEdge;
        else if (rightEdge > cRect.width - margin) x = cRect.width - margin - rightEdge;

        let y = 0;
        if (hotspot.topTooltip) {
            // --top variant: tooltip extends downward from the pin.
            const bottomEdge = pinY + 1.2 * tipH;
            if (bottomEdge > cRect.height - margin) y = cRect.height - margin - bottomEdge;
        } else {
            // Default: tooltip extends upward from the pin.
            const topEdge = pinY - 1.2 * tipH;
            if (topEdge < margin) y = margin - topEdge;
        }

        tip.style.setProperty("--tooltip-shift-x", `${x}px`);
        tip.style.setProperty("--tooltip-shift-y", `${y}px`);
    };

    return (
        <button
            ref={btnRef}
            type="button"
            className={`hotspot${hotspot.topTooltip ? " hotspot--top" : ""}`}
            style={{ top: hotspot.top, left: hotspot.left }}
            onMouseEnter={measure}
            onFocus={measure}
            aria-label={`${hotspot.title}: ${hotspot.text}`}
        >
            <span className="hotspot__pin" aria-hidden="true"></span>
            <span ref={tooltipRef} className="hotspot__tooltip" role="tooltip">
                <h4>{hotspot.title}</h4>
                <p>{hotspot.text}</p>
            </span>
        </button>
    );
}

function VesselImage({ vessel }: { vessel: Vessel }) {
    const zoom = vessel.imageZoom ?? 1;
    const [oxStr, oyStr] = (vessel.objectPosition ?? "50% 50%").split(/\s+/);
    const ox = Number.parseFloat(oxStr ?? "50") || 50;
    const oy = Number.parseFloat(oyStr ?? "50") || 50;

    return (
        <div className="fleet-image-container relative aspect-4/3 w-full rounded-xl shadow-[0_4px_20px_rgba(0,0,0,0.08)]">
            <div className="absolute inset-0 overflow-hidden rounded-xl">
                <img
                    className="block h-full w-full object-cover"
                    src={vessel.image}
                    alt={vessel.imageAlt}
                    loading={vessel.loading}
                    style={{
                        ...(vessel.objectPosition ? { objectPosition: vessel.objectPosition } : {}),
                        ...(zoom !== 1
                            ? {
                                  transform: `scale(${zoom})`,
                                  transformOrigin: vessel.objectPosition ?? "center",
                              }
                            : {}),
                    }}
                    {...(vessel.loading === "eager" ? { fetchPriority: "high" } : {})}
                />
            </div>
            {vessel.hotspots.map((h) => {
                const left = Number.parseFloat(h.left);
                const top = Number.parseFloat(h.top);
                return (
                    <Hotspot
                        key={h.title}
                        hotspot={{
                            ...h,
                            left: `${ox + zoom * (left - ox)}%`,
                            top: `${oy + zoom * (top - oy)}%`,
                        }}
                    />
                );
            })}
        </div>
    );
}

function VesselImageModal({ vessel, onClose }: { vessel: Vessel; onClose: () => void }) {
    const closeBtnRef = useRef<HTMLButtonElement>(null);
    const lastActiveRef = useRef<HTMLElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const raf = requestAnimationFrame(() => setIsOpen(true));
        return () => cancelAnimationFrame(raf);
    }, []);

    useEffect(() => {
        lastActiveRef.current = document.activeElement as HTMLElement | null;
        closeBtnRef.current?.focus();

        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handleKey);

        return () => {
            document.removeEventListener("keydown", handleKey);
            lastActiveRef.current?.focus?.();
        };
    }, [onClose]);

    // Lock background scroll while the modal is mounted. Capture the
    // pre-lock value and restore it on cleanup so we never leave the
    // page stuck with overflow:hidden.
    useEffect(() => {
        const { overflow } = document.body.style;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = overflow;
        };
    }, []);

    const handleClose = () => {
        setIsOpen(false);
        setTimeout(onClose, 200);
    };

    const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) handleClose();
    };

    if (!mounted) return null;

    return (
        <div
            className={`image-modal${isOpen ? " is-open" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={`${vessel.name} image`}
            onClick={handleBackdropClick}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleClose();
            }}
        >
            <div className="vessel-image-modal__panel">
                <button
                    type="button"
                    ref={closeBtnRef}
                    className="absolute -top-10 right-0 cursor-pointer border-0 bg-transparent text-3xl leading-none text-white"
                    aria-label="Close preview"
                    onClick={handleClose}
                >
                    &times;
                </button>
                <VesselImage vessel={vessel} />
            </div>
        </div>
    );
}

function FleetCard({ vessel, onImageClick }: { vessel: Vessel; onImageClick: () => void }) {
    const imageCol = (
        <div className="relative max-[900px]:order-1">
            {/* biome-ignore lint/a11y/useSemanticElements: VesselImage contains hotspot <button> elements; a <button> cannot nest another <button>. */}
            <div
                role="button"
                tabIndex={0}
                onClick={onImageClick}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onImageClick();
                    }
                }}
                className="group block w-full cursor-zoom-in rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                aria-label={`Expand ${vessel.name} image`}
            >
                <VesselImage vessel={vessel} />
            </div>
        </div>
    );

    const infoCol = (
        <div className="flex max-[900px]:order-2 flex-col justify-center">
            <span className="kicker">{vessel.subtitle}</span>
            <p className="text-[1.1rem]">{vessel.description}</p>
            {vessel.specs.length > 0 && (
                <div className="mt-6 grid grid-cols-2 gap-4 border-t border-black/8 pt-6 dark:border-white/8">
                    {vessel.specs.map((spec) => (
                        <div key={spec.label}>
                            <span className="data-callout__label">{spec.label}</span>
                            <span className="data-callout__value">{spec.value}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <Card
            className={`fleet-card my-6! grid grid-cols-[1.4fr_1fr] gap-8! p-6! max-[900px]:grid-cols-1 max-[900px]:gap-4! max-[900px]:!p-4${vessel.reverse ? " fleet-card--reverse min-[901px]:grid-cols-[1fr_1.4fr]" : ""}`}
        >
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
    const [modalVessel, setModalVessel] = useState<Vessel | null>(null);

    return (
        <section className="section blueprint-grid mx-auto grid max-w-275 gap-4 px-4 py-6" id="fleet-section">
            {VESSELS.map((vessel, i) => (
                <div key={vessel.name} className="contents">
                    <div
                        className={`fleet-section-title mx-auto flex w-[min(1100px,90%)] items-center gap-4${i === 0 ? " mt-16" : " mt-10"}`}
                    >
                        <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
                        <h2 className="m-0! flex items-center gap-2.5 font-heading text-[clamp(18px,2.5vw,28px)] font-extrabold">
                            {vessel.name}
                            <span
                                className={`inline-flex items-center gap-1.5 align-middle text-[0.5em] font-semibold uppercase tracking-wide ${vessel.status === "Active" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                            >
                                <span
                                    className={`fleet-status-dot inline-block h-2 w-2 rounded-full ${vessel.status === "Active" ? "bg-emerald-500" : "bg-amber-500"}`}
                                    aria-hidden="true"
                                />
                                {vessel.status}
                            </span>
                        </h2>
                        <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
                    </div>
                    <FleetCard vessel={vessel} onImageClick={() => setModalVessel(vessel)} />
                </div>
            ))}
            {modalVessel && <VesselImageModal vessel={modalVessel} onClose={() => setModalVessel(null)} />}
        </section>
    );
}
