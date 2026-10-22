/**
 * Shared image data for the site's galleries.
 *
 * The subteam photography is displayed in two places -- inline on the
 * Meet the Team page (grouped per subteam) and mixed into the /gallery
 * grid -- so it lives here rather than being duplicated in both pages.
 * Update this file and both pages follow.
 *
 * WHY THERE IS NO "LOOSE PHOTOS" LIST ANY MORE. The /gallery page used to show
 * a hard-coded set of general team photos from `public/images/gallery/` before
 * the subteam ones. Those photos now live in the team's Google Drive gallery
 * folder and are fetched at runtime (see `galleryClient.ts` and
 * `worker/src/gallerySync.ts`), so the folder and the array were removed --
 * uploading a photo no longer requires a redeploy, and the repo no longer
 * carries a duplicate copy of the photo library.
 *
 * WARNING: This module is now ONLY the curated, build-time images: the subteam
 * photos that also appear on Meet the Team. Anything the team wants to add
 * later goes in the Drive folder, not here. Adding a photo here means editing
 * source and redeploying, which is exactly what the Drive folder replaced.
 *
 * WARNING: The site pages that are NOT galleries (the home hero, the three
 * Fleet vessels, and the social preview image) deliberately keep their photos
 * in `public/images/` -- `/images/hero.webp` and `/images/fleet/*.webp`. They
 * must render without a network call to the Worker, and a Drive photo would
 * make the home page's hero depend on the gallery API.
 */

export interface GalleryImage {
    src: string;
    alt: string;
    caption?: string;
}

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
            alt: "Jetson Orin Nano",
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
    mechanical: [
        {
            src: "/images/our_team_images/mechanical/michio_spray_paint.webp",
            alt: "Hull Design and Construction",
            caption: "One of our former members spray-painting a hull during the design and construction process.",
        },
        {
            src: "/images/our_team_images/mechanical/michio_sail.webp",
            alt: "Sail Design and Testing",
            caption: "One of our former members assembling the hard sail which we used on Lumpy.",
        },
        { src: "/images/our_team_images/mechanical/boat1.webp", alt: "Vessel Hull 1" },
        { src: "/images/our_team_images/mechanical/mech1.webp", alt: "Mechanical design testing" },
        { src: "/images/our_team_images/mechanical/sail1.webp", alt: "Sail construction and rigging" },
        { src: "/images/our_team_images/mechanical/boat2.webp", alt: "Vessel Hull 2" },
        {
            src: "/images/our_team_images/mechanical/mech2.webp",
            alt: "Mechanical assembly work",
            caption: "The linkage and control system for the dual rudder setup used on Lumpy.",
        },
        {
            src: "/images/our_team_images/mechanical/mech3.webp",
            alt: "Mechanical assembly work",
            caption: "Ducky's hull had to be sanded in preparation for repainting.",
        },
    ],
    business: [] as GalleryImage[],
} satisfies Record<string, GalleryImage[]>;

/**
 * The curated images the /gallery grid shows in addition to the Drive ones:
 * every subteam's photography, flattened.
 *
 * These are the BUILD-TIME half of the gallery. The Drive manifest supplies the
 * rest at runtime, and `buildGalleryTiles` merges the two.
 *
 * WARNING: The /gallery grid keys tiles by `src`, so a `src` appearing twice
 * would drop a tile and emit a React duplicate-key warning. There are
 * currently no duplicates -- `src/test/lib/galleryImages.test.ts` guards it.
 */
export const ALL_GALLERY_IMAGES: GalleryImage[] = Object.values(SUBTEAM_IMAGES).flat();
