/**
 * Gallery reconciliation: what the public gallery contains, and which blobs
 * R2 still needs.
 *
 * Drive is authoritative. R2 mirrors the bytes so the public page can load them
 * from the Worker without paying a Drive round trip per visitor (see
 * `drive.ts` for why Drive cannot be hotlinked). The manifest is the list of
 * what exists; the mirror is the set of bytes that have been copied.
 *
 * This module is deliberately pure -- no bindings, no `fetch` -- so the rules
 * below are unit-testable on plain objects. `index.ts` owns R2, Drive, and KV.
 *
 * THE THREE-WAY MERGE, and why it is not a two-way diff:
 *
 *   Drive files  = what the team has
 *   R2 objects   = what has been copied, and what is pending copy
 *   manifest     = what the page renders
 *
 * A naive "manifest := Drive files" would publish an image before its bytes
 * were mirrored, so every visitor would see a broken tile until the next sync.
 * A naive "manifest := R2 only" would hide a newly uploaded photo twice as long
 * (two syncs instead of one). So an entry is published as soon as its bytes are
 * in place, and a file whose copy is still pending is carried in the manifest
 * already so the amount of work is explicit rather than implied by absence.
 */

/** One image as the website renders it. */
export interface GalleryEntry {
    /** Drive file id. Stable across renames, so it is the key everywhere. */
    id: string;
    /** Alt text: the filenames are descriptive, and are all that is known. */
    name: string;
    /** R2 object key, present once the bytes are mirrored. */
    key: string;
    /** Pixel dimensions when Drive reported them. */
    width: number | null;
    height: number | null;
    modifiedTime: string | null;
    /** Epoch ms the mirror completed, or null while it is still pending. */
    mirroredAt: number | null;
    /**
     * Whether an officer has taken this photo off the public gallery.
     *
     * WARNING: HIDDEN IS NOT DELETED. The Drive file is untouched and the R2 mirror
     * is kept, so restoring is instant and nothing is lost if someone hides the
     * wrong photo. It only removes the photo from the public list. Do not
     * "optimize" this into a delete -- recovering a deleted Drive file is not
     * something this Worker can do.
     */
    hidden: boolean;
}

/** The stored manifest, heartbeated so staleness is visible. */
export interface GalleryManifest {
    /** Epoch ms of the sync that produced this. */
    syncedAt: number;
    entries: GalleryEntry[];
    /**
     * Files whose mirror is still outstanding.
     *
     * Carried explicitly so a sync that hits its per-run copy budget resumes
     * from the same place next time instead of re-deriving the backlog from a
     * diff. It is also what lets `/gallery` report "N images still copying".
     */
    pending: string[];
    /**
     * Why this sync did not fully succeed, if it did not.
     *
     * A string rather than an exception because the manifest is still served:
     * a Drive outage should make the gallery stale, not empty.
     */
    warning: string | null;
}

/** R2 object key for a Drive file. */
export function mirrorKey(fileId: string): string {
    return `gallery/${fileId}`;
}

/**
 * Reverse a mirror key back to a Drive file id, or null.
 *
 * Needed by the delete sweep: R2 lists keys, and the only way to know whether a
 * key still corresponds to a live file is to recover the id and look it up.
 */
export function fileIdFromKey(key: string): string | null {
    const match = /^gallery\/([A-Za-z0-9_-]+)$/.exec(key);
    return match?.[1] ?? null;
}

/** The minimal file description the reconciler needs. */
export interface DriveFileInput {
    id: string;
    name: string;
    width?: number | null;
    height?: number | null;
    modifiedTime?: string | null;
}

/**
 * Build the manifest from the current Drive listing and the objects R2 holds.
 *
 * `existing` is the previous manifest, used for two things: keeping a stable
 * ordering for entries whose metadata has not changed, and remembering that a
 * file was already mirrored (so it is not copied again).
 *
 * Ordering is newest-first by `modifiedTime`, falling back to name. Photos are
 * a stream of recent activity, so newest-first is what a visitor expects; name
 * order would put ""1.webp" ahead of last week's regatta.
 */
export function buildManifest(
    driveFiles: readonly DriveFileInput[],
    mirroredKeys: ReadonlySet<string>,
    existing: GalleryManifest | null,
    now: Date,
    /**
     * Files an officer has removed from the public gallery.
     *
     * WARNING: These are kept in the manifest, not filtered out. Keeping them means
     * the entry keeps its mirror state, so restoring is a flag flip rather than
     * a re-copy, and the officer's "removed photos" list can show a thumbnail.
     * `renderableEntries` is what excludes them from the public list.
     */
    hiddenIds: ReadonlySet<string> = new Set<string>(),
    /**
     * The officer-chosen display order, most-prominent first.
     *
     * Ids not named here keep the default newest-first order and follow the
     * listed ones. See `sortEntriesByOrder` for why a partial list is the normal
     * case rather than an error.
     */
    order: readonly string[] = [],
): GalleryManifest {
    // Previous mirror timestamps, so an entry does not lose its "already copied"
    // state just because the id was re-listed.
    const previous = new Map<string, GalleryEntry>();
    for (const entry of existing?.entries ?? []) previous.set(entry.id, entry);

    const entries: GalleryEntry[] = [];
    const pending: string[] = [];

    for (const file of driveFiles) {
        const key = mirrorKey(file.id);
        const isMirrored = mirroredKeys.has(key);
        // Hidden photos are STILL mirrored: the bytes are needed for the
        // officer's removed-photos thumbnail, and keeping them makes restore
        // instant instead of "appears after the next sync".
        if (!isMirrored) pending.push(file.id);

        const prior = previous.get(file.id);
        entries.push({
            id: file.id,
            name: file.name,
            key,
            width: typeof file.width === "number" ? file.width : null,
            height: typeof file.height === "number" ? file.height : null,
            modifiedTime: typeof file.modifiedTime === "string" ? file.modifiedTime : null,
            // A file whose bytes are gone from R2 loses its mirror timestamp --
            // that is exactly the case the next sync has to repair, so reporting
            // it as mirrored would strand the image.
            mirroredAt: isMirrored ? (prior?.mirroredAt ?? now.getTime()) : null,
            hidden: hiddenIds.has(file.id),
        });
    }

    sortEntriesByOrder(entries, order);

    return {
        syncedAt: now.getTime(),
        entries,
        pending,
        warning: null,
    };
}

/**
 * Order entries by the officer's preference, falling back to newest-first.
 *
 * WHY A PARTIAL LIST IS NORMAL, and why this is not a bug to "fix":
 *
 *  - A photo uploaded after the order was set is not in the list yet. It must
 *    still appear, so unlisted ids are appended rather than dropped.
 *  - The list is deliberately NOT pruned when a photo leaves Drive. Pruning
 *    would need a read-modify-write on every sync, and it would also lose the
 *    position of a photo that comes back (a rename, an undo in Drive's trash).
 *    A stale id is harmless: it matches nothing and costs a few bytes.
 *
 * Unlisted entries keep the default `compareEntries` order among themselves, so
 * the newest upload is first among the leftovers -- which is what a visitor
 * expects when the team has not curated anything recently.
 *
 * `order` holds TILE KEYS (`drive:<id>`), not bare ids, so one saved sequence can
 * also describe the curated photos the browser owns. `ids` are accepted too, as
 * a courtesy to a hand-written `PUT` body -- see `orderIdsFromKeys`'s inverse
 * below.
 */
export function sortEntriesByOrder(entries: GalleryEntry[], order: readonly string[]): void {
    // Position of each listed entry. A Map rather than `indexOf` because indexOf
    // is O(n) per comparison, which makes the sort O(n^2 log n) on a big gallery.
    //
    // Keyed by the TILE KEY the site uses, so a key and a bare id both resolve:
    // `driveTileKey` is what the browser sends, and a bare id is what a curl
    // user would naturally type.
    const rank = new Map<string, number>();
    for (let i = 0; i < order.length; i++) {
        const key = order[i];
        // First occurrence wins, so a duplicated entry cannot confuse the ranking.
        if (key === undefined || rank.has(key)) continue;
        rank.set(key, i);
        // Also rank the bare id, so a body of plain ids still orders correctly.
        for (const id of orderIdsFromKeys([key])) {
            if (!rank.has(id)) rank.set(id, i);
        }
    }

    entries.sort((a, b) => {
        const ar = rank.get(driveTileKey(a.id)) ?? rank.get(a.id);
        const br = rank.get(driveTileKey(b.id)) ?? rank.get(b.id);
        if (ar !== undefined && br !== undefined) return ar - br;
        // A listed photo always outranks an unlisted one, so appending a new
        // upload never displaces a photo somebody deliberately placed.
        if (ar !== undefined) return -1;
        if (br !== undefined) return 1;
        return compareEntries(a, b);
    });
}

/** The default (curation-free) order: newest first, then by name, then by id. */
function compareEntries(a: GalleryEntry, b: GalleryEntry): number {
    const am = a.modifiedTime ? Date.parse(a.modifiedTime) : Number.NaN;
    const bm = b.modifiedTime ? Date.parse(b.modifiedTime) : Number.NaN;
    const aValid = !Number.isNaN(am);
    const bValid = !Number.isNaN(bm);
    if (aValid && bValid && am !== bm) return bm - am;
    // Entries with a date sort ahead of entries without one, so a file Drive
    // has not finished processing does not jump to the top and then move.
    if (aValid !== bValid) return aValid ? -1 : 1;
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
}

/**
 * Which files still need their bytes copied into R2, at most `limit` of them.
 *
 * Capped because a Worker invocation has a wall-clock and subrequest budget: a
 * folder with 400 new photos cannot finish in one run, and attempting it would
 * time out with nothing recorded. Copying a bounded batch per run means the
 * gallery fills in progressively instead of failing wholesale.
 *
 * Files already mirrored are skipped, which makes the whole thing idempotent --
 * re-running a sync copies nothing.
 */
export function filesToMirror(manifest: GalleryManifest, limit: number): string[] {
    if (limit <= 0) return [];
    return manifest.pending.slice(0, limit);
}

/**
 * R2 keys that no longer correspond to a Drive file.
 *
 * The delete sweep. A photo removed in Drive must leave the gallery, and its
 * bytes must leave R2 or the bucket grows forever.
 *
 * WARNING: Only keys under the `gallery/` prefix are considered. Anything else in
 * the bucket belongs to something else and must never be swept just because it
 * is not a gallery image.
 */
export function keysToDelete(existingKeys: readonly string[], liveFileIds: ReadonlySet<string>): string[] {
    const doomed: string[] = [];
    for (const key of existingKeys) {
        const fileId = fileIdFromKey(key);
        if (fileId === null) continue; // not ours
        if (!liveFileIds.has(fileId)) doomed.push(key);
    }
    return doomed;
}

/**
 * Mark a file's mirror complete in the manifest.
 *
 * The copy happens in the background while the response has already gone out,
 * so the manifest has to be patched rather than rebuilt -- rebuilding would
 * re-list Drive, which is the expensive part.
 */
export function markMirrored(manifest: GalleryManifest, fileId: string, now: Date): GalleryManifest {
    let changed = false;
    const entries = manifest.entries.map((entry) => {
        if (entry.id !== fileId || entry.mirroredAt !== null) return entry;
        changed = true;
        return { ...entry, mirroredAt: now.getTime() };
    });
    const pending = manifest.pending.filter((id) => id !== fileId);
    if (!changed && pending.length === manifest.pending.length) return manifest;
    return { ...manifest, entries, pending };
}

/**
 * Drop a file from the manifest (an upload was rolled back, or a file vanished
 * between listing and copying).
 */
export function removeEntry(manifest: GalleryManifest, fileId: string): GalleryManifest {
    return {
        ...manifest,
        entries: manifest.entries.filter((entry) => entry.id !== fileId),
        pending: manifest.pending.filter((id) => id !== fileId),
    };
}

/**
 * What the public gallery should render: only entries whose bytes exist and
 * that an officer has not removed.
 *
 * This is the guard against a broken tile. `pending` is visible in the
 * manifest for diagnostics, but the page is never told about an image it cannot
 * load -- and never told about one the team took down.
 */
export function renderableEntries(manifest: GalleryManifest): GalleryEntry[] {
    return manifest.entries.filter((entry) => entry.mirroredAt !== null && !entry.hidden);
}

/**
 * The photos an officer has removed, for the restore list.
 *
 * Only mirrored ones are returned, because the list renders a thumbnail and an
 * unmirrored entry has no image to show yet. A hidden photo that is still
 * copying appears once the sync finishes.
 */
export function hiddenEntries(manifest: GalleryManifest): GalleryEntry[] {
    return manifest.entries.filter((entry) => entry.hidden && entry.mirroredAt !== null);
}

/**
 * Apply a hidden/visible change to one entry, on disk and in memory.
 *
 * Returns the new manifest, or null when the id is not in it -- the caller
 * reports that as a 404, because hiding something the gallery does not contain
 * means the request is wrong (or the photo already left Drive).
 *
 * Deliberately only flips the flag: nothing is removed from the manifest, from
 * R2, or from Drive.
 */
export function setEntryHidden(manifest: GalleryManifest, fileId: string, hidden: boolean): GalleryManifest | null {
    if (!manifest.entries.some((entry) => entry.id === fileId)) return null;
    return {
        ...manifest,
        entries: manifest.entries.map((entry) => (entry.id === fileId ? { ...entry, hidden } : entry)),
    };
}

/** The stored record of which photos are hidden. */
export interface HiddenList {
    ids: string[];
    /** Epoch ms of the last change, for diagnostics. */
    updatedAt: number;
}

/**
 * Safety cap on the hidden list.
 *
 * This is not a policy -- there is no product limit on hiding photos. It exists
 * so a runaway loop cannot grow one KV value without bound. At ~30 bytes per id
 * this is generous.
 */
export const MAX_HIDDEN_IDS = 5000;

/**
 * Parse the stored hidden list into a set.
 *
 * Tolerant for the same reason `parseManifest` is: an unreadable value must
 * read as "nothing is hidden", which shows the full gallery, rather than as an
 * error that takes the page down.
 */
export function parseHiddenList(value: unknown): Set<string> {
    if (typeof value !== "object" || value === null) return new Set();
    const raw = (value as Record<string, unknown>).ids;
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0));
}

/** Serialize the hidden set for KV, bounded by `MAX_HIDDEN_IDS`. */
export function serializeHiddenList(ids: ReadonlySet<string>, now: Date): HiddenList {
    return { ids: [...ids].slice(0, MAX_HIDDEN_IDS), updatedAt: now.getTime() };
}

/** Add or remove one id from a hidden set, returning a NEW set. */
export function withHidden(ids: ReadonlySet<string>, fileId: string, hidden: boolean): Set<string> {
    const next = new Set(ids);
    if (hidden) next.add(fileId);
    else next.delete(fileId);
    return next;
}

/**
 * Prefix for a Drive entry's TILE KEY, matching `buildGalleryTiles` on the site.
 *
 * WHY KEYS AND NOT JUST IDS. The saved display order has to describe the WHOLE
 * grid, and roughly half of it is curated photos compiled into the site -- this
 * Worker has no entry for those at all. A single sequence of opaque keys is
 * therefore the only thing that can express the arrangement, and the browser
 * applies the parts it owns.
 *
 * WARNING: This literal is duplicated in `src/lib/galleryView.ts`, which cannot
 * import from the Worker (that code must not ship in the bundle). If one side
 * changes, saved orders silently stop matching -- so any edit here must be
 * mirrored there, and `galleryOrder.test.ts` pins the format.
 */
export const DRIVE_TILE_PREFIX = "drive:";

/** The tile key for a Drive entry. */
export function driveTileKey(fileId: string): string {
    return `${DRIVE_TILE_PREFIX}${fileId}`;
}

/**
 * The Drive file ids named by a saved tile-key order, in order.
 *
 * Drops curated keys (`site:...`) and anything unrecognisable: this Worker sorts
 * only its own entries, and the curated half is the browser's business.
 */
export function orderIdsFromKeys(keys: readonly string[]): string[] {
    const ids: string[] = [];
    for (const key of keys) {
        if (!key.startsWith(DRIVE_TILE_PREFIX)) continue;
        const id = key.slice(DRIVE_TILE_PREFIX.length);
        if (id) ids.push(id);
    }
    return ids;
}

/** The stored officer-chosen display order. */
export interface OrderList {
    /**
     * Tile keys, most-prominent first.
     *
     * WARNING: Named `keys` rather than `ids` since the order covers curated tiles
     * too. A stored `ids` value from before that change simply parses as no
     * order, which falls back to newest-first -- the same fail-safe direction as
     * a corrupt value.
     */
    keys: string[];
    /** Epoch ms of the last change, for diagnostics. */
    updatedAt: number;
}

/**
 * Safety cap on the stored order.
 *
 * Not a policy -- there is no product limit on reordering. It bounds one KV
 * value, and it is far above any plausible gallery size. Keys beyond it simply
 * fall back to the default order.
 */
export const MAX_ORDERED_IDS = 2000;

/**
 * Parse a stored order, dropping anything unusable.
 *
 * An unreadable value reads as "no custom order", which shows the default
 * newest-first gallery. That is the same fail-safe direction the hidden list
 * takes: the alternative would be a page that renders nothing.
 *
 * De-duplicates while preserving the FIRST position, matching
 * `sortEntriesByOrder`'s "first occurrence wins" rule so the stored list and the
 * sort cannot disagree about a repeated key.
 */
export function parseOrder(value: unknown): string[] {
    if (typeof value !== "object" || value === null) return [];
    const raw = (value as Record<string, unknown>).keys;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const key of raw) {
        if (typeof key !== "string" || key.length === 0) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
    }
    return keys;
}

/** Serialize the order for KV, bounded by `MAX_ORDERED_IDS`. */
export function serializeOrder(keys: readonly string[], now: Date): OrderList {
    return { keys: keys.slice(0, MAX_ORDERED_IDS), updatedAt: now.getTime() };
}

/**
 * Parse a stored manifest, tolerating anything unrecognisable.
 *
 * Returns null rather than throwing: a corrupt or pre-gallery KV value must
 * look like "no manifest yet" so the next sync rebuilds it, not like an outage.
 */
export function parseManifest(value: unknown): GalleryManifest | null {
    if (typeof value !== "object" || value === null) return null;
    const body = value as Record<string, unknown>;
    if (!Array.isArray(body.entries)) return null;
    const syncedAt = typeof body.syncedAt === "number" && Number.isFinite(body.syncedAt) ? body.syncedAt : 0;

    const entries: GalleryEntry[] = [];
    for (const raw of body.entries) {
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry.id !== "string" || !entry.id) continue;
        entries.push({
            id: entry.id,
            name: typeof entry.name === "string" ? entry.name : entry.id,
            key: typeof entry.key === "string" && entry.key ? entry.key : mirrorKey(entry.id),
            width: typeof entry.width === "number" ? entry.width : null,
            height: typeof entry.height === "number" ? entry.height : null,
            modifiedTime: typeof entry.modifiedTime === "string" ? entry.modifiedTime : null,
            mirroredAt:
                typeof entry.mirroredAt === "number" && Number.isFinite(entry.mirroredAt) ? entry.mirroredAt : null,
            // Strict `=== true`: a manifest written before hiding existed must
            // read as "visible", not as a truthy default.
            hidden: entry.hidden === true,
        });
    }

    const pending = Array.isArray(body.pending)
        ? body.pending.filter((id): id is string => typeof id === "string")
        : [];
    return {
        syncedAt,
        entries,
        pending: pending.length > 0 ? pending : entries.filter((e) => e.mirroredAt === null).map((e) => e.id),
        warning: typeof body.warning === "string" ? body.warning : null,
    };
}
