/**
 * Client for the gallery API on the Discord-events Worker.
 *
 * The Worker mirrors images out of a Google Drive folder into R2 and publishes
 * a manifest (see `worker/src/gallerySync.ts`). This module reads that manifest
 * and resolves each entry to an `<img>` src. It also drives the officer upload
 * flow, which needs no new login: the session from `eventManage.ts` already
 * carries the permission the Worker checks.
 *
 * WIRE FORMAT
 *
 *   GET /gallery ->
 *     { syncedAt: number | null, images: GalleryImage[], pending: number, warning: string | null }
 *
 *   POST /manage/gallery   (multipart/form-data, field "file", Bearer session)
 *     -> { id, name, mirrored: boolean }
 *
 * WARNING: `pending` is NOT part of `images`. The Worker only advertises images
 * whose bytes are already mirrored, so a tile is never rendered for something
 * the browser cannot load. `pending` exists purely so the page can say "more on
 * the way" instead of silently showing fewer photos than the folder holds.
 */

import { EVENTS_URL } from "./discord";
import { ManageError, type ManageSession } from "./eventManage";

/** Where the gallery endpoints live. Same Worker as the calendar. */
const GALLERY_URL = `${EVENTS_URL}/gallery`;
const MANAGE_GALLERY_URL = `${EVENTS_URL}/manage/gallery`;

/**
 * Optional override for the ORIGIN+PATH that serves gallery image bytes.
 *
 * Read from `globalThis` rather than `import.meta.env` so it parses under Jest's
 * CJS runtime, exactly like `EVENTS_URL` in `discord.ts`.
 */
declare global {
    // eslint-disable-next-line no-var
    var __VITE_GALLERY_IMAGE_BASE__: string | undefined;
}

/**
 * Base for image byte URLs, with a trailing slash trimmed.
 *
 * EMPTY by default, which keeps the Worker origin (`<worker>/gallery/image/<id>`).
 * Set `VITE_GALLERY_IMAGE_BASE` to move the bytes to another host WITHOUT
 * touching this module -- see `galleryImageUrl`.
 */
const IMAGE_BASE: string = (globalThis.__VITE_GALLERY_IMAGE_BASE__ ?? "").replace(/\/+$/, "");

/** One image as the Worker's manifest describes it. */
export interface GalleryImage {
    /** Drive file id. Stable across renames, so it is the React key. */
    id: string;
    /** Original filename, used as the alt text. */
    name: string;
    /** Pixel dimensions, when Drive reported them. Used to reserve space. */
    width: number | null;
    height: number | null;
    modifiedTime: string | null;
}

/** The manifest as served. */
export interface GalleryManifest {
    /** Epoch ms of the sync that produced this, or null before the first. */
    syncedAt: number | null;
    images: GalleryImage[];
    /** Images known in Drive whose copy has not finished yet. */
    pending: number;
    /** A human-readable note when the last sync was incomplete. */
    warning: string | null;
}

/**
 * Public URL for a mirrored image -- the `<img src>`.
 *
 * Keyed by Drive id, which never changes, so the Worker can serve it with an
 * immutable cache header. That is why the URL carries no dimensions or version
 * suffix: a replaced photo gets a new id.
 *
 * WARNING: THIS IS THE ONE PLACE THE BYTES' HOST IS DECIDED, and it must stay
 * separate from `galleryPermalinkPath`. The shareable LINK is
 * `autoboat.aoe.vt.edu/gallery/<id>`; the BYTES come from the Worker because the
 * site host is plain Amazon S3 on VT's DNS (`sweb-prod.hosting.vt.edu`) with no
 * Cloudflare route in front of it. S3 has no `/gallery/image/<id>` object, so
 * pointing the `<img src>` at the site domain today would break every tile.
 *
 * `VITE_GALLERY_IMAGE_BASE` exists so that if the site domain is ever fronted by
 * Cloudflare (or an S3 redirect rule is added), moving the bytes is an env var,
 * not a code change: set it to `https://autoboat.aoe.vt.edu/gallery` and every
 * `src` becomes `<base>/image/<id>`, matching the Worker's own route shape.
 */
export function galleryImageUrl(id: string): string {
    const encoded = encodeURIComponent(id);
    return IMAGE_BASE ? `${IMAGE_BASE}/image/${encoded}` : `${GALLERY_URL}/image/${encoded}`;
}

/**
 * Shareable permalink for one photo, on the SITE's own domain.
 *
 * WARNING: This is a PAGE link, not an image URL. It resolves to
 * `/gallery/<id>` on `autoboat.aoe.vt.edu`, which loads the gallery and opens
 * that photo in the lightbox. The `<img src>` still points at the Worker
 * (`galleryImageUrl`), because the site host cannot serve the bytes: VT S4 is
 * plain S3 on VT's DNS, so there is no Worker route in front of it. If you are
 * looking for "the image loads from autoboat.aoe.vt.edu", that needs an infra
 * change on the VT side, not a change here.
 *
 * WHY THE LIGHTBOX RATHER THAN A DEDICATED PAGE: the gallery is one grid, and a
 * second page would duplicate the manifest fetch, the officer controls, and the
 * ordering. Reusing the grid means a shared link behaves exactly like a click
 * on the photo.
 *
 * Uses the Drive file id, matching `galleryImageUrl`, so the two URLs for a
 * photo always agree about which photo they mean.
 */
export function galleryPermalinkPath(id: string): string {
    return `/gallery/${encodeURIComponent(id)}`;
}

/** Absolute permalink for one photo, for copy-to-clipboard and share buttons. */
export function galleryPermalinkUrl(id: string, siteUrl: string): string {
    return `${siteUrl.replace(/\/+$/, "")}${galleryPermalinkPath(id)}`;
}

/**
 * Read the photo id out of a `/gallery/<id>` pathname, or null.
 *
 * Decoded here rather than at the call site because the id is a Drive file id
 * that round-trips through `encodeURIComponent` above, and a double-decode is
 * how a malformed id turns into a thrown `URIError` inside a render.
 *
 * Returns null for anything that is not exactly `/gallery/<one-segment>`, so a
 * malformed or multi-segment path degrades to the plain gallery instead of
 * failing.
 */
export function photoIdFromPathname(pathname: string): string | null {
    const match = /^\/gallery\/([^/]+)\/?$/i.exec(pathname);
    if (!match?.[1]) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        // A malformed escape sequence is not a photo id; treat it as none.
        return null;
    }
}

/**
 * Whether a value looks like a manifest image entry.
 *
 * The payload crosses a network boundary, so it is validated rather than
 * trusted: a malformed entry would otherwise render a tile with an undefined
 * src, which shows as a broken image on a public page.
 */
function isGalleryImage(value: unknown): value is GalleryImage {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) return false;
    if (typeof entry.name !== "string") return false;
    return true;
}

/** Coerce one entry into the shape this module promises. */
function toGalleryImage(entry: GalleryImage): GalleryImage {
    const raw = entry as unknown as Record<string, unknown>;
    return {
        id: entry.id,
        name: entry.name || entry.id,
        width: typeof raw.width === "number" && Number.isFinite(raw.width) ? raw.width : null,
        height: typeof raw.height === "number" && Number.isFinite(raw.height) ? raw.height : null,
        modifiedTime: typeof raw.modifiedTime === "string" ? raw.modifiedTime : null,
    };
}

/**
 * Parse a manifest response, dropping anything unrecognisable.
 *
 * Tolerant by design: one bad entry must not empty the page. The alternative --
 * rejecting the whole payload -- turns a single corrupt record into "the
 * gallery is broken", which is a worse failure than showing the other photos.
 */
export function parseManifest(body: unknown): GalleryManifest {
    const empty: GalleryManifest = { syncedAt: null, images: [], pending: 0, warning: null };
    if (typeof body !== "object" || body === null) return empty;
    const raw = body as Record<string, unknown>;

    const images = Array.isArray(raw.images) ? raw.images.filter(isGalleryImage).map(toGalleryImage) : [];

    return {
        syncedAt: typeof raw.syncedAt === "number" && Number.isFinite(raw.syncedAt) ? raw.syncedAt : null,
        images,
        pending: typeof raw.pending === "number" && Number.isFinite(raw.pending) ? raw.pending : 0,
        warning: typeof raw.warning === "string" && raw.warning ? raw.warning : null,
    };
}

/**
 * Why a gallery request failed, with enough detail for the UI to be useful.
 *
 * The Worker is a DIFFERENT ORIGIN from the site, so the single most common
 * failure is a CORS rejection -- which `fetch` reports as an opaque
 * `TypeError` with no status, indistinguishable from a network outage unless it
 * is probed for. See `describeFetchFailure`.
 */
export class GalleryError extends Error {
    readonly status: number;
    /** `true` when the Worker answered but the browser blocked the response. */
    readonly corsBlocked: boolean;
    /** `true` when the gallery has not been configured on the Worker. */
    readonly notConfigured: boolean;

    constructor(message: string, status: number, flags: { corsBlocked?: boolean; notConfigured?: boolean } = {}) {
        super(message);
        this.name = "GalleryError";
        this.status = status;
        this.corsBlocked = flags.corsBlocked ?? false;
        this.notConfigured = flags.notConfigured ?? false;
    }
}

/**
 * Turn a transport failure into a message that names the likely cause.
 *
 * A CORS rejection still produces a readable, opaque response when requested
 * with `mode: "no-cors"`, whereas a genuine outage does not. Probing once turns
 * "NetworkError" into an actionable sentence naming the origin that is missing
 * from `ALLOWED_ORIGIN` -- the same diagnosis the calendar needed, and the
 * failure is otherwise invisible because the Worker returns 200.
 */
async function describeFetchFailure(url: string, err: unknown): Promise<GalleryError> {
    if (err instanceof Error && err.name === "AbortError") {
        return new GalleryError("The request was cancelled.", 0);
    }
    try {
        await fetch(url, { mode: "no-cors", cache: "no-store" });
        const origin = globalThis.location?.origin ?? "this site";
        return new GalleryError(
            `The browser blocked the gallery response. ${origin} is probably missing from ALLOWED_ORIGIN on the Worker.`,
            0,
            { corsBlocked: true },
        );
    } catch {
        return new GalleryError("Could not reach the gallery service. Check your connection and try again.", 0);
    }
}

/** Read an error body from the Worker, tolerating a non-JSON response. */
async function errorFrom(res: Response): Promise<GalleryError> {
    let message = `Request failed (${res.status}).`;
    try {
        const body: unknown = await res.json();
        if (typeof body === "object" && body !== null) {
            const raw = body as Record<string, unknown>;
            if (typeof raw.error === "string" && raw.error) message = raw.error;
        }
    } catch {
        // Keep the status-based message.
    }
    return new GalleryError(message, res.status, { notConfigured: res.status === 503 });
}

/**
 * Fetch the gallery manifest.
 *
 * `cache: "no-store"` is deliberate. The Worker sends a short `max-age`, which
 * is right for other visitors, but a viewer who has just uploaded a photo must
 * not be shown their own stale copy.
 */
export async function fetchGalleryManifest(signal?: AbortSignal): Promise<GalleryManifest> {
    let res: Response;
    try {
        res = await fetch(GALLERY_URL, { cache: "no-store", signal });
    } catch (err) {
        throw await describeFetchFailure(GALLERY_URL, err);
    }
    if (!res.ok) throw await errorFrom(res);
    return parseManifest(await res.json());
}

/** Accepted upload types, mirrored from the Worker so the picker can filter. */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"] as const;

/** `accept` attribute for a file input. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(",");

/**
 * Client-side size ceiling, in bytes.
 *
 * Matches `MAX_UPLOAD_BYTES` in `worker/src/galleryUpload.ts`. Duplicated on
 * purpose: checking here avoids sending megabytes over a phone connection only
 * to be refused, and the Worker still enforces its own limit because a client
 * check is never a security boundary.
 */
export const MAX_UPLOAD_BYTES = 4_500_000;

/**
 * Why a chosen file cannot be uploaded, or null when it is fine.
 *
 * WARNING: This checks the FILE's declared type only. The Worker additionally
 * sniffs the bytes, because a `.jpg` extension is a claim, not a fact -- and it
 * is the byte check that produces the specific HEIC message an iPhone user
 * needs.
 */
export function validateFileLocally(file: File): string | null {
    if (file.size === 0) return "That file is empty.";
    if (file.size > MAX_UPLOAD_BYTES) {
        const mb = (MAX_UPLOAD_BYTES / 1_000_000).toFixed(1);
        return `That image is too large (${mb} MB maximum). Resize it and try again.`;
    }
    if (file.type && !(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type.toLowerCase())) {
        return "Unsupported image type. Use JPEG, PNG, WebP, GIF, or AVIF.";
    }
    return null;
}

/** Result of a successful upload. */
export interface UploadResult {
    id: string;
    name: string;
    /**
     * Whether the image is already servable.
     *
     * `false` is not a failure: the photo is safely in Drive and the next sync
     * publishes it. The UI says so rather than implying the upload was lost.
     */
    mirrored: boolean;
}

/**
 * Upload one image, as a signed-in officer.
 *
 * Throws `ManageError` for the session problems the calendar already words for
 * us (401 expired, 403 lost the role) so the gallery does not need a second
 * vocabulary for the same refusals, and `GalleryError` for gallery-specific
 * failures (too large, wrong type, Drive unavailable).
 */
export async function uploadImage(session: ManageSession, file: File): Promise<UploadResult> {
    const localProblem = validateFileLocally(file);
    if (localProblem) throw new GalleryError(localProblem, 400);

    const form = new FormData();
    form.append("file", file, file.name);

    let res: Response;
    try {
        res = await fetch(MANAGE_GALLERY_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.token}` },
            body: form,
            cache: "no-store",
        });
    } catch (err) {
        throw await describeFetchFailure(MANAGE_GALLERY_URL, err);
    }

    if (!res.ok) {
        // Reuse the shared refusal wording (wrong Discord account, no officer
        // role) so the two write surfaces cannot drift apart.
        const galleryError = await errorFrom(res);
        if (res.status === 401 || res.status === 403) {
            throw new ManageError(galleryError.message, res.status, {
                reason: res.status === 403 ? "missing-role" : null,
                needsRole: res.status === 403,
            });
        }
        throw galleryError;
    }

    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.id !== "string" || !body.id) {
        throw new GalleryError("The upload response was unusable.", 502);
    }
    return {
        id: body.id,
        name: typeof body.name === "string" && body.name ? body.name : file.name,
        mirrored: body.mirrored === true,
    };
}

/** Where the hide/restore endpoints live, relative to the manage root. */
const MANAGE_GALLERY_HIDDEN_URL = `${MANAGE_GALLERY_URL}/hidden`;

/**
 * Hide or restore one photo on the public gallery.
 *
 * WARNING: THIS DOES NOT DELETE ANYTHING. The Drive file and the mirrored bytes are
 * untouched; only the public list stops including the photo. That is deliberate:
 * an officer removing the wrong photo must be able to put it back, and the
 * Worker has no way to recover a deleted Drive file.
 *
 * Throws `ManageError` for the session problems the calendar already words
 * (401 expired, 403 lost the role) and `GalleryError` for everything else.
 */
export async function setPhotoHidden(session: ManageSession, fileId: string, hidden: boolean): Promise<void> {
    let res: Response;
    try {
        res = await fetch(`${MANAGE_GALLERY_URL}/${encodeURIComponent(fileId)}`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.token}`,
            },
            // A real boolean, not a string: the Worker rejects anything else
            // rather than reading `"false"` as truthy.
            body: JSON.stringify({ hidden }),
            cache: "no-store",
        });
    } catch (err) {
        throw await describeFetchFailure(`${MANAGE_GALLERY_URL}/${fileId}`, err);
    }

    if (!res.ok) {
        const galleryError = await errorFrom(res);
        if (res.status === 401 || res.status === 403) {
            throw new ManageError(galleryError.message, res.status, {
                reason: res.status === 403 ? "missing-role" : null,
                needsRole: res.status === 403,
            });
        }
        throw galleryError;
    }
}

/**
 * Save the display order.
 *
 * WARNING: The list is sent WHOLE -- it is an assertion about the intended order, not
 * a single move. See the Worker's handler for why a (from, to) pair is unsafe
 * once more than one officer can upload.
 *
 * `keys` are TILE keys (`drive:<id>` / `site:<src>`), not Drive ids, so one
 * sequence can describe the whole grid including the curated photos. A photo
 * uploaded later is not named and appears at the end rather than displacing
 * anything, which is why an officer does not have to reorder after every upload.
 */
export async function saveGalleryOrder(session: ManageSession, keys: readonly string[]): Promise<void> {
    const url = `${MANAGE_GALLERY_URL}/order`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.token}`,
            },
            // `keys` matches what the Worker stores. The route still accepts an
            // `ids` body for a hand-written curl call, but the page always sends
            // keys so curated photos are covered.
            body: JSON.stringify({ keys }),
            cache: "no-store",
        });
    } catch (err) {
        throw await describeFetchFailure(url, err);
    }

    if (!res.ok) {
        const galleryError = await errorFrom(res);
        if (res.status === 401 || res.status === 403) {
            throw new ManageError(galleryError.message, res.status, {
                reason: res.status === 403 ? "missing-role" : null,
                needsRole: res.status === 403,
            });
        }
        throw galleryError;
    }
}

/**
 * The photos an officer has removed, so they can be restored.
 *
 * Without this the removal would be a one-way door short of opening Drive and
 * matching filenames by hand.
 */
export async function fetchHiddenPhotos(session: ManageSession): Promise<GalleryImage[]> {
    let res: Response;
    try {
        res = await fetch(MANAGE_GALLERY_HIDDEN_URL, {
            headers: { Authorization: `Bearer ${session.token}` },
            cache: "no-store",
        });
    } catch (err) {
        throw await describeFetchFailure(MANAGE_GALLERY_HIDDEN_URL, err);
    }

    if (!res.ok) {
        const galleryError = await errorFrom(res);
        if (res.status === 401 || res.status === 403) {
            throw new ManageError(galleryError.message, res.status, {
                reason: res.status === 403 ? "missing-role" : null,
                needsRole: res.status === 403,
            });
        }
        throw galleryError;
    }

    const body = (await res.json()) as Record<string, unknown>;
    const images = Array.isArray(body.images) ? body.images.filter(isGalleryImage) : [];
    return images.map(toGalleryImage);
}
