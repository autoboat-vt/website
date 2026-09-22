/**
 * Shared image data for the site's galleries.
 *
 * The subteam photography is displayed in two places -- inline on the
 * Meet the Team page (grouped per subteam) and mixed into the /gallery
 * grid -- so it lives here rather than being duplicated in both pages.
 * Update this file and both pages follow.
 */

export interface GalleryImage {
    src: string;
    alt: string;
    caption?: string;
}

/**
 * Loose photos of the team and boats with no particular subteam home.
 * Shown first on /gallery.
 */
export const GALLERY_PHOTOS: GalleryImage[] = [
    { src: "/images/gallery/1.webp", alt: "#1" },
    { src: "/images/gallery/2.webp", alt: "#2" },
    { src: "/images/gallery/3.webp", alt: "#3" },
    { src: "/images/gallery/4.webp", alt: "#4" },
    { src: "/images/gallery/5.webp", alt: "#5" },
    { src: "/images/gallery/6.webp", alt: "#6" },
    { src: "/images/gallery/7.webp", alt: "#7" },
    { src: "/images/gallery/8.webp", alt: "#8" },
    { src: "/images/gallery/9.webp", alt: "#9" },
    { src: "/images/gallery/10.webp", alt: "#10" },
    { src: "/images/gallery/11.webp", alt: "#11" },
    { src: "/images/gallery/12.webp", alt: "#12" },
    { src: "/images/gallery/13.webp", alt: "#13" },
    { src: "/images/gallery/14.webp", alt: "#14" },
    { src: "/images/gallery/15.webp", alt: "#15" },
];

/**
 * Per-subteam photography, keyed by the subteam `id` used on the
 * Meet the Team page. Most images carry a caption, which the lightbox
 * renders under the enlarged photo.
 */
export const SUBTEAM_IMAGES = {
    software: [
        {
            src: "/images/our_team_images/software/computer_vision1.webp",
            alt: "Computer Vision System",
            caption: "Computer vision system detecting buoys and obstacles in real time.",
        },
        {
            src: "/images/our_team_images/software/groundstation.webp",
            alt: "Groundstation Software",
            caption:
                "A screenshot of the Groundstation being used to monitor and control the boat during a simulation run.",
        },
        {
            src: "/images/our_team_images/software/simulation.webp",
            alt: "Simulation Environment",
            caption: "A screenshot of the Gazebo simulation environment, showing a model of one of our boats.",
        },
        {
            src: "/images/our_team_images/electronics/electronics2.webp",
            alt: "Electronics 2",
            caption:
                "One of our members working with the Jetson Orin Nano, which runs our computer vision and control software on the boat.",
        },
    ],
    electronics: [
        { src: "/images/our_team_images/electronics/electronics1.webp", alt: "Electronics 1" },
        { src: "/images/our_team_images/electronics/electronics3.webp", alt: "Electronics 3" },
        { src: "/images/our_team_images/electronics/electronics4.webp", alt: "Electronics 4" },
        { src: "/images/our_team_images/electronics/electronics5.webp", alt: "Electronics 5" },
        { src: "/images/our_team_images/electronics/electronics6.webp", alt: "Electronics 6" },
    ],
    "vehicle-dynamics": [
        { src: "/images/our_team_images/navarch/michio_spray_paint.webp", alt: "Hull Design and Construction" },
        { src: "/images/our_team_images/mechanical/mech1.webp", alt: "Mechanical fabrication and assembly" },
        { src: "/images/our_team_images/sail/michio_sail.webp", alt: "Sail Design and Testing" },
        { src: "/images/our_team_images/navarch/boat1.webp", alt: "Vessel Hull 1" },
        { src: "/images/our_team_images/mechanical/mech2.webp", alt: "Mechanical design testing" },
        { src: "/images/our_team_images/sail/sail1.webp", alt: "Sail construction and rigging" },
        { src: "/images/our_team_images/navarch/boat2.webp", alt: "Vessel Hull 2" },
        { src: "/images/our_team_images/mechanical/mech3.webp", alt: "Mechanical assembly work" },
    ],
    business: [] as GalleryImage[],
} satisfies Record<string, GalleryImage[]>;

/**
 * Every image on the site, for the /gallery grid: the loose photos first,
 * then the subteam photography.
 *
 * ⚠️ The /gallery grid keys tiles by `src`, so a `src` appearing twice
 * would drop a tile and emit a React duplicate-key warning. There are
 * currently no duplicates -- `src/test/lib/galleryImages.test.ts` guards it.
 */
export const ALL_GALLERY_IMAGES: GalleryImage[] = [...GALLERY_PHOTOS, ...Object.values(SUBTEAM_IMAGES).flat()];
