/**
 * Gallery synchronization: Drive -> manifest -> R2 mirror.
 *
 * Runs on a cron trigger and on demand (an officer's upload, or the page's
 * staleness check). Kept out of `index.ts` because the routing file is already
 * the largest module here and this workflow has its own failure modes.
 *
 * WHY A CRON. The requirement is that a photo dropped into the Drive folder
 * shows up on the gallery, without anyone editing a file or redeploying. Drive
 * has no cheap "something changed" signal available to a Worker (push
 * notifications need a public HTTPS webhook and renewal bookkeeping), so the
 * design polls. A sync every few minutes is cheap: one `files.list` call, then
 * a copy per NEW image only.
 *
 * WARNING: THE MIRROR IS THE POINT, NOT A CACHE FOR SPEED. Cloudflare's edge cache
 * already handles repeat visitors. R2 exists so that a public page view does
 * not spend a Drive API call -- Drive's per-user quota would be exhausted by
 * ordinary traffic, and a burst on a photo would start 503ing for everyone.
 */

import { downloadFile, type GalleryFile, getFileMetadata, listFolderImages, uploadImage } from "./drive";
import {
    buildManifest,
    type DriveFileInput,
    fileIdFromKey,
    filesToMirror,
    type GalleryManifest,
    keysToDelete,
    markMirrored,
    mirrorKey,
    parseHiddenList,
    parseManifest,
    removeEntry,
    serializeHiddenList,
    setEntryHidden,
    withHidden,
} from "./gallery";
import { getAccessToken, serviceAccountConfigFromEnv } from "./googleAuth";

/** KV key for the manifest. Separate from the events key by design. */
export const GALLERY_KV_KEY = "gallery:manifest:v1";

/**
 * KV key for the set of photos an officer has removed from the public gallery.
 *
 * WARNING: A SEPARATE key from the manifest, and that is what makes hiding durable.
 * The manifest is rebuilt from Drive on every sync, so a `hidden` flag stored
 * only there would be erased the moment the folder was re-listed. Keeping the
 * authoritative set on its own key means the flag is re-applied on every
 * rebuild -- and it means the manifest can be safely dropped or corrupt without
 * the team's takedowns being forgotten.
 *
 * NOTE: This key is only WRITTEN when an officer hides or restores a photo, so it
 * costs no KV budget on the read or sync path.
 */
export const GALLERY_HIDDEN_KV_KEY = "gallery:hidden:v1";

/**
 * How many images one sync will copy into R2.
 *
 * WARNING: Bounded deliberately. A Worker invocation has a wall-clock limit and a
 * cap on outbound subrequests; a folder with hundreds of new photos cannot be
 * copied in one run. Attempting it would hit the limit with nothing recorded,
 * so the same batch would be retried forever and the gallery would never
 * fill. A small batch per run makes progress monotonic -- each sync advances
 * the backlog, and the manifest already lists every file it knows about.
 */
export const MAX_MIRRORS_PER_SYNC = 12;

/** How many stale R2 keys one sync will delete. */
const MAX_DELETES_PER_SYNC = 50;

/**
 * How long a manifest is served before a sync is triggered.
 *
 * This is NOT how often the cron runs -- it is the age at which a page view
 * asks for a refresh. Both matter: the cron bounds "how stale can it get with
 * nobody looking", and this bounds "how stale can one viewer see".
 */
export const MANIFEST_TTL_SECONDS = 300;

/**
 * The bindings this workflow needs, expressed STRUCTURALLY.
 *
 * WARNING: These are minimal hand-written shapes rather than `KVNamespace` /
 * `R2Bucket`. Those are Cloudflare ambient types, and the worker test suite
 * imports this module by relative path from under `src/`, where the root
 * tsconfig does NOT load `@cloudflare/workers-types` -- so naming the ambient
 * types here would add type errors to the site build. Declaring only the members
 * actually used keeps this module importable from both sides, and has the
 * side-effect of documenting exactly which binding surface it depends on.
 */
export interface GalleryKv {
    get(key: string, options?: { type?: "json" }): Promise<unknown>;
    put(key: string, value: string): Promise<void>;
}

export interface GalleryBucketObject {
    body: ReadableStream;
    httpEtag: string;
    writeHttpMetadata(headers: Headers): void;
}

export interface GalleryBucket {
    get(key: string): Promise<GalleryBucketObject | null>;
    put(
        key: string,
        value: ReadableStream,
        options?: {
            httpMetadata?: { contentType?: string; cacheControl?: string };
            customMetadata?: Record<string, string>;
        },
    ): Promise<unknown>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string; cursor?: string }): Promise<{
        objects: { key: string }[];
        truncated: boolean;
        cursor?: string;
    }>;
}

export interface GalleryEnv {
    EVENTS_KV: GalleryKv;
    GALLERY_BUCKET: GalleryBucket;
    DRIVE_GALLERY_FOLDER_ID?: string;
    GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
    GOOGLE_PRIVATE_KEY?: string;
    GOOGLE_IMPERSONATE_EMAIL?: string;
}

/** Read the stored manifest. A KV failure reads as "no manifest". */
export async function loadManifest(env: GalleryEnv): Promise<GalleryManifest | null> {
    try {
        return parseManifest(await env.EVENTS_KV.get(GALLERY_KV_KEY, { type: "json" }));
    } catch {
        // A KV read failure must not take the gallery down; the caller treats a
        // null manifest as empty and the next sync rebuilds it.
        return null;
    }
}

/** Persist the manifest. Throws so the caller can report it. */
export async function saveManifest(env: GalleryEnv, manifest: GalleryManifest): Promise<void> {
    await env.EVENTS_KV.put(GALLERY_KV_KEY, JSON.stringify(manifest));
}

/** Whether the manifest is old enough to justify a refresh. */
export function manifestIsStale(manifest: GalleryManifest | null, now: Date): boolean {
    if (manifest === null) return true;
    if (manifest.syncedAt <= 0) return true;
    return now.getTime() - manifest.syncedAt >= MANIFEST_TTL_SECONDS * 1000;
}

/**
 * Read the set of hidden photo ids.
 *
 * A KV failure reads as "nothing hidden", which shows the full gallery -- the
 * safe direction, since the alternative is a page that hides photos the team
 * never took down.
 */
export async function loadHiddenIds(env: GalleryEnv): Promise<Set<string>> {
    try {
        return parseHiddenList(await env.EVENTS_KV.get(GALLERY_HIDDEN_KV_KEY, { type: "json" }));
    } catch {
        return new Set<string>();
    }
}

/** Persist the hidden set. One write, on an officer-initiated path only. */
export async function saveHiddenIds(env: GalleryEnv, ids: ReadonlySet<string>, now: Date): Promise<void> {
    await env.EVENTS_KV.put(GALLERY_HIDDEN_KV_KEY, JSON.stringify(serializeHiddenList(ids, now)));
}

/**
 * Hide or restore one photo.
 *
 * WARNING: NOTHING IS DELETED. The Drive file, the R2 mirror, and the manifest entry
 * all stay exactly as they are; only the public list stops including the photo.
 * That is deliberate and is the whole requirement: an officer removing the
 * wrong photo must be able to put it back, and recovering a deleted Drive file
 * is not something this Worker can do.
 *
 * Returns the updated manifest, or null when the gallery does not contain that
 * id (which the caller reports as 404 -- hiding a photo that is not there means
 * the request is wrong, or the photo already left Drive).
 *
 * Writes TWICE on purpose: the hidden set (authoritative, survives a re-list)
 * and the manifest (so the current page reflects it immediately rather than
 * after the next sync). Both are officer-initiated, so neither touches the read
 * path's budget.
 */
export async function setPhotoHidden(
    env: GalleryEnv,
    fileId: string,
    hidden: boolean,
    now: Date = new Date(),
): Promise<GalleryManifest | null> {
    const manifest = await loadManifest(env);
    // No manifest means no sync has run, so nothing is published yet. Treat it
    // as "not found" rather than creating an empty one -- a manifest with no
    // entries would be marked fresh and blank the gallery for a whole TTL.
    if (manifest === null) return null;

    const updated = setEntryHidden(manifest, fileId, hidden);
    if (updated === null) return null;

    const hiddenIds = withHidden(await loadHiddenIds(env), fileId, hidden);
    await saveHiddenIds(env, hiddenIds, now);
    await saveManifest(env, updated);
    return updated;
}

/** List the R2 keys under the gallery prefix. */
async function listMirroredKeys(env: GalleryEnv): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
        const page = await env.GALLERY_BUCKET.list({ prefix: "gallery/", cursor });
        for (const object of page.objects) keys.push(object.key);
        if (!page.truncated) return keys;
        cursor = page.cursor;
    }
}

/**
 * Copy a Drive file's bytes into R2.
 *
 * WARNING: The body is piped, not buffered. An image can be several megabytes and
 * the isolate has 128 MB of memory shared with everything else; `arrayBuffer()`
 * on a burst of images is how a Worker gets killed mid-sync. `put` accepts a
 * ReadableStream directly.
 *
 * The content type is stored as metadata so the serving route can look it up
 * without asking Drive, and a long `Cache-Control` is set here rather than at
 * read time because the key is immutable -- the id never changes, and a
 * replaced photo gets a new id.
 */
async function mirrorOne(env: GalleryEnv, accessToken: string, fileId: string, mimeType: string): Promise<boolean> {
    const res = await downloadFile(accessToken, fileId);
    if (!res.ok || !res.body) return false;

    await env.GALLERY_BUCKET.put(mirrorKey(fileId), res.body, {
        httpMetadata: {
            contentType: mimeType,
            cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: { driveId: fileId },
    });
    return true;
}

/** Result of one sync, reported to the caller for logging and diagnostics. */
export interface SyncResult {
    manifest: GalleryManifest;
    mirrored: number;
    deleted: number;
    failed: number;
}

/**
 * One full sync: list Drive, reconcile, copy a batch, sweep deletions.
 *
 * Never throws for an upstream problem: a Drive outage yields the PREVIOUS
 * manifest with a warning attached, so the gallery keeps serving what it
 * already had. Throwing would replace a working gallery with an error page
 * because Google had a bad minute.
 *
 * The one thing that does throw is a missing credential or a corrupt bucket
 * listing, both of which mean the configuration is wrong rather than the
 * network.
 */
export async function syncGallery(env: GalleryEnv, now: Date = new Date()): Promise<SyncResult> {
    const folderId = env.DRIVE_GALLERY_FOLDER_ID?.trim();
    const config = serviceAccountConfigFromEnv(env);
    if (!folderId || !config) {
        throw new Error("Drive is not configured.");
    }

    const previous = await loadManifest(env);

    // Listing is the expensive call and the only one that can leave us with
    // nothing useful, so its failure is handled separately: keep what we have.
    let driveFiles: GalleryFile[];
    let accessToken: string;
    try {
        accessToken = await getAccessToken(config, now);
        driveFiles = await listFolderImages(accessToken, folderId);
    } catch (err) {
        const reason = err instanceof Error ? err.message : "Drive is unavailable.";
        return {
            manifest: {
                syncedAt: now.getTime(),
                entries: previous?.entries ?? [],
                pending: previous?.pending ?? [],
                warning: reason,
            },
            mirrored: 0,
            deleted: 0,
            failed: 0,
        };
    }

    const mirroredKeys = new Set(await listMirroredKeys(env));
    // Re-apply the officer's takedowns on every rebuild. The hidden set lives on
    // its own KV key precisely so a re-list of Drive cannot resurrect a removed
    // photo.
    const hiddenIds = await loadHiddenIds(env);
    let manifest = buildManifest(driveFiles, mirroredKeys, previous, now, hiddenIds);

    // Sweep R2 for photos that left Drive. Done before mirroring so the bucket
    // does not carry dead bytes for another cycle.
    const liveIds = new Set(driveFiles.map((f) => f.id));
    const doomed = keysToDelete([...mirroredKeys], liveIds).slice(0, MAX_DELETES_PER_SYNC);
    let deleted = 0;
    for (const key of doomed) {
        try {
            await env.GALLERY_BUCKET.delete(key);
            deleted++;
            const fileId = fileIdFromKey(key);
            // If the key was for a file still in the manifest (it cannot be --
            // live ids are excluded -- but the guard keeps the invariant local),
            // dropping the entry is what makes the page stop rendering it.
            if (fileId && !liveIds.has(fileId)) manifest = removeEntry(manifest, fileId);
        } catch {
            // A failed delete is retried on the next sync; it costs nothing to
            // leave the bytes for one more cycle.
        }
    }

    // Copy a bounded batch of new images.
    const byId = new Map(driveFiles.map((f) => [f.id, f]));
    let mirrored = 0;
    let failed = 0;
    for (const fileId of filesToMirror(manifest, MAX_MIRRORS_PER_SYNC)) {
        const file = byId.get(fileId);
        if (!file) continue;
        try {
            const ok = await mirrorOne(env, accessToken, file.id, file.mimeType);
            if (ok) {
                manifest = markMirrored(manifest, file.id, now);
                mirrored++;
            } else {
                failed++;
            }
        } catch {
            // One unreadable file must not abort the batch; it stays pending and
            // the next sync retries it.
            failed++;
        }
    }

    // Anything still outstanding is reported rather than hidden, so an operator
    // can see the gallery is catching up instead of wondering why a photo is
    // missing.
    const remaining = manifest.pending.length;
    const warning = remaining > 0 ? `${remaining} image${remaining === 1 ? "" : "s"} still copying.` : null;
    manifest = { ...manifest, warning };

    await saveManifest(env, manifest);
    return { manifest, mirrored, deleted, failed };
}

/**
 * Upload a new photo: write it to Drive, then mirror it locally right away.
 *
 * Drive is written FIRST because it is the source of truth. If the mirror then
 * fails, the cron picks it up within one interval; if Drive failed, nothing
 * half-published. The opposite order would put an image on the gallery that
 * does not exist in the archive, which is the one outcome the team would
 * consider a data loss.
 *
 * Returns the created Drive file, or throws with a message for the officer.
 */
export async function uploadGalleryImage(
    env: GalleryEnv,
    file: { name: string; mimeType: string; bytes: Uint8Array },
    now: Date = new Date(),
): Promise<{ id: string; name: string; mirrored: boolean }> {
    const folderId = env.DRIVE_GALLERY_FOLDER_ID?.trim();
    const config = serviceAccountConfigFromEnv(env);
    if (!folderId || !config) throw new Error("Drive is not configured.");

    const accessToken = await getAccessToken(config, now);
    const created = await uploadImage(accessToken, folderId, file);

    // Mirror immediately so the upload appears on the page without waiting for
    // a cron tick. This is best-effort on purpose: the Drive write is the
    // durable one, and a mirror failure here is repaired by the next sync.
    let mirrored = false;
    try {
        mirrored = await mirrorOne(env, accessToken, created.id, file.mimeType);
    } catch {
        mirrored = false;
    }

    // Merge the new file into the manifest so it renders now. Drive's
    // `modifiedTime` is not in the upload response, so the current time stands
    // in -- it is within a second of the real value and sorts correctly.
    const previous = await loadManifest(env);
    const files: GalleryFile[] = [
        {
            id: created.id,
            name: created.name,
            mimeType: file.mimeType,
            width: null,
            height: null,
            modifiedTime: now.toISOString(),
            size: file.bytes.length,
        },
    ];

    // Rebuild from the previous entries plus the new one. Listing Drive again
    // would be the "correct" refresh but it is a round trip the upload already
    // paid for; the cron reconciles anything this misses.
    const existingIds = new Set((previous?.entries ?? []).map((e) => e.id));
    const known: DriveFileInput[] = [
        ...(previous?.entries ?? []).map((entry) => ({
            id: entry.id,
            name: entry.name,
            width: entry.width,
            height: entry.height,
            modifiedTime: entry.modifiedTime,
        })),
        ...files
            .filter((f) => !existingIds.has(f.id))
            .map((f) => ({
                id: f.id,
                name: f.name,
                width: f.width,
                height: f.height,
                modifiedTime: f.modifiedTime,
            })),
    ];

    const mirroredKeys = new Set(await listMirroredKeys(env).catch(() => []));
    if (mirrored) mirroredKeys.add(mirrorKey(created.id));

    const mounted = await loadManifest(env);
    const hiddenIds = await loadHiddenIds(env);
    const manifest = buildManifest(known, mirroredKeys, mounted, now, hiddenIds);
    await saveManifest(env, {
        ...manifest,
        warning: manifest.pending.length > 0 ? `${manifest.pending.length} image(s) still copying.` : null,
    });

    return { id: created.id, name: created.name, mirrored };
}

/**
 * Fetch a file's MIME type from Drive, for a key that R2 has but the manifest
 * does not describe. Returns null when Drive cannot answer.
 */
export async function lookupMimeType(env: GalleryEnv, fileId: string, now: Date = new Date()): Promise<string | null> {
    const config = serviceAccountConfigFromEnv(env);
    if (!config) return null;
    try {
        const token = await getAccessToken(config, now);
        const file = await getFileMetadata(token, fileId);
        return file?.mimeType ?? null;
    } catch {
        return null;
    }
}
