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
        });
    }

    entries.sort(compareEntries);

    return {
        syncedAt: now.getTime(),
        entries,
        pending,
        warning: null,
    };
}

/** Newest first, then by name, then by id so the order is total and stable. */
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
 * What the public gallery should render: only entries whose bytes exist.
 *
 * This is the guard against a broken tile. `pending` is visible in the
 * manifest for diagnostics, but the page is never told about an image it cannot
 * load.
 */
export function renderableEntries(manifest: GalleryManifest): GalleryEntry[] {
    return manifest.entries.filter((entry) => entry.mirroredAt !== null);
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
