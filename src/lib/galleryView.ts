/**
 * Presentation logic for the gallery grid.
 *
 * Kept separate from `galleryClient.ts` (which does network I/O) so the merge
 * and alt-text rules can be unit-tested without a fetch, and separate from the
 * page so the same rules can be reused if another page ever lists photos.
 */

import type { GalleryImage } from "./galleryClient";

/** One tile as the page renders it. */
export interface GalleryTile {
    /** Stable React key. */
    key: string;
    /** Resolved image URL. */
    src: string;
    /** Alt text and, in the lightbox, the caption. */
    alt: string;
    /** Optional longer caption shown under the enlarged photo. */
    caption?: string;
    /**
     * The Drive file id, for tiles that came from the Drive manifest.
     *
     * WARNING: Undefined for the curated (build-time) tiles. Those are part of the
     * site's design, not the team's photo library, so there is nothing to hide
     * -- and the hide endpoint would 404 on them. The page uses this to decide
     * whether to offer the officer actions at all.
     */
    driveId?: string;
}

/**
 * Turn a Drive filename into readable alt text.
 *
 * WHY THIS MATTERS: a Drive folder is full of names like `IMG_4471.JPG`,
 * `regatta_day-2.jpeg`, or `2026-04-12_lake_test.jpg`. Pasting the raw filename
 * into `alt` gives a screen reader "I M G underscore four four seven one dot J
 * P G", and pasting the extension into a caption looks like a file listing. So
 * the extension is dropped, separators become spaces, and a leading date is
 * left alone (it reads fine and is genuinely informative).
 *
 * WARNING: The result can still be uninformative ("IMG 4471"). That is a limit of
 * what a filename knows -- the fix is for the team to name photos descriptively
 * in Drive, not for this function to invent a description. It must never
 * pretend to know what is in the picture.
 */
export function altFromFileName(name: string): string {
    const withoutExtension = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    const spaced = withoutExtension.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return spaced || name;
}

/**
 * Build the tiles the grid renders.
 *
 * ORDER: the Drive images come first, newest first (the Worker already sorts
 * them that way), then the curated site photos. Reason: the Drive folder is
 * where new photos land, so a visitor should see the latest activity first;
 * the curated set is the historical/editorial selection and reads as an
 * archive underneath.
 *
 * DEDUPE: by `src`. The two sources cannot collide today -- curated images are
 * `/images/...` paths on this origin while Drive images are Worker URLs -- but
 * a future change that served a Drive photo through a local path would
 * otherwise render the same tile twice and trip React's duplicate-key warning.
 * The first occurrence wins, so the Drive (newer) copy is kept.
 */
export function buildGalleryTiles(
    drive: readonly GalleryImage[],
    curated: readonly { src: string; alt: string; caption?: string }[],
    imageUrl: (id: string) => string,
): GalleryTile[] {
    const tiles: GalleryTile[] = [];
    const seen = new Set<string>();

    for (const image of drive) {
        const src = imageUrl(image.id);
        if (seen.has(src)) continue;
        seen.add(src);
        const alt = altFromFileName(image.name);
        tiles.push({ key: `drive:${image.id}`, src, alt, driveId: image.id });
    }

    for (const image of curated) {
        if (seen.has(image.src)) continue;
        seen.add(image.src);
        tiles.push({
            key: `site:${image.src}`,
            src: image.src,
            alt: image.alt,
            ...(image.caption ? { caption: image.caption } : {}),
        });
    }

    return tiles;
}

/**
 * The sentence under the heading when part of the folder is still copying.
 *
 * Returns null when there is nothing worth saying, so the page does not render
 * an empty status line. A `pending` count of 0 with a `warning` present means
 * the last sync failed for another reason, and the warning is used as-is
 * because it already reads as a sentence.
 */
export function galleryStatusNote(pending: number, warning: string | null): string | null {
    if (pending > 0) {
        return `${pending} more ${pending === 1 ? "photo is" : "photos are"} still being added. Refresh in a minute.`;
    }
    return warning;
}
