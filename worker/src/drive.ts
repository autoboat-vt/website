/**
 * Google Drive client for the gallery: list the folder, upload into it, and
 * stream a file back out.
 *
 * RESPONSIBILITY BOUNDARY. This module talks to Drive and returns plain data.
 * It does not decide what the gallery should contain, does not touch R2, and
 * does not know about audiences or sessions. The reconciliation rules live in
 * `gallery.ts`, which is pure; the bindings live in `index.ts`.
 *
 * WHY THE FOLDER IS THE SOURCE OF TRUTH. The team already keeps its photos in
 * Drive, and the requirement is that everything in one folder shows up on the
 * gallery. So Drive is authoritative and the R2 copy is a cache: adding a file
 * in the Drive UI is enough to publish it, and no one has to edit a TypeScript
 * array and redeploy.
 *
 * WARNING: Drive is NOT a CDN. `webContentLink` and `lh3.googleusercontent.com`
 * URLs are rate-limited, rotate, and are not meant for embedding, so the
 * browser must never load an image straight from Drive. `alt=media` is streamed
 * through the Worker into R2 instead, and the page serves from the Worker.
 *
 * Every request passes `supportsAllDrives=true`, which is required whenever the
 * folder lives in a Shared Drive -- without it Drive answers 404 for a file that
 * plainly exists, which reads as "the folder id is wrong".
 */

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Image types the gallery will display.
 *
 * WARNING: Deliberately excludes HEIC/HEIF, which iPhones produce by default.
 * Drive stores them happily, but no browser can render one, so including them
 * would put visible broken tiles on a public page. Officers exporting from an
 * iPhone need to share JPEG instead.
 */
export const SUPPORTED_IMAGE_TYPES: readonly string[] = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
];

/** One file as the Drive API describes it (only the fields read here). */
export interface DriveFile {
    id: string;
    name: string;
    mimeType?: string;
    /** Dimensions, when Drive has finished processing the image. */
    imageMediaMetadata?: {
        width?: number;
        height?: number;
        rotation?: number;
    } | null;
    modifiedTime?: string;
    /** Present for binary files; a decimal string. */
    size?: string;
    trashed?: boolean;
}

/** A file in the gallery folder, normalized for the manifest. */
export interface GalleryFile {
    /** Drive file id. Stable across renames, which is why it is the key. */
    id: string;
    /** Original filename, used for the alt text and as a tie-breaker for order. */
    name: string;
    mimeType: string;
    /** Pixel dimensions when known, so the grid can reserve space. */
    width: number | null;
    height: number | null;
    modifiedTime: string | null;
    size: number | null;
}

/** Whether the gallery can display a file of this MIME type. */
export function isSupportedImage(mimeType: string | undefined | null): boolean {
    if (!mimeType) return false;
    return SUPPORTED_IMAGE_TYPES.includes(mimeType.toLowerCase());
}

/** Require a usable access token, with a message that names the real problem. */
function requireToken(accessToken: string): string {
    if (!accessToken) throw new Error("No Google access token was supplied.");
    return accessToken;
}

/** Shared fetch with a timeout, so a hung Drive call cannot stall a sync. */
async function driveFetch(url: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...init,
            headers: {
                ...init.headers,
                Authorization: `Bearer ${requireToken(accessToken)}`,
            },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Turn a Drive file into a manifest entry, or null when it is not displayable.
 *
 * WARNING: A file with no `mimeType` is rejected rather than guessed. Guessing from
 * the extension would let a `.heic` or a `.psd` through on a Drive record that
 * happens to lack the field.
 */
export function toGalleryFile(file: DriveFile): GalleryFile | null {
    if (!file.id || !file.name) return null;
    if (!isSupportedImage(file.mimeType)) return null;
    // A trashed file can still be returned by a parent-scoped query in some
    // edge cases; the query filters it too, but this must hold regardless.
    if (file.trashed) return null;

    const width = typeof file.imageMediaMetadata?.width === "number" ? file.imageMediaMetadata.width : null;
    const height = typeof file.imageMediaMetadata?.height === "number" ? file.imageMediaMetadata.height : null;
    const size = typeof file.size === "string" && /^\d+$/.test(file.size) ? Number(file.size) : null;

    return {
        id: file.id,
        name: file.name,
        mimeType: (file.mimeType ?? "").toLowerCase(),
        width,
        height,
        modifiedTime: typeof file.modifiedTime === "string" ? file.modifiedTime : null,
        size,
    };
}

/** Response body shape of a `files.list` call (only the fields read here). */
export interface DriveListResponse {
    files?: DriveFile[];
    nextPageToken?: string;
}

/**
 * Extract the displayable files from one page, plus the cursor for the next.
 *
 * Pure, so the filtering and pagination rules are testable without Drive.
 */
export function parseListPage(data: unknown): { files: GalleryFile[]; nextPageToken: string | null } {
    if (typeof data !== "object" || data === null) return { files: [], nextPageToken: null };
    const body = data as DriveListResponse;
    const raw = Array.isArray(body.files) ? body.files : [];
    const files = raw.map(toGalleryFile).filter((f): f is GalleryFile => f !== null);
    const nextPageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
    return { files, nextPageToken };
}

/** Maximum pages to follow. Bounded so a bad cursor cannot loop forever. */
const MAX_PAGES = 20;

/**
 * List every displayable image in a Drive folder, following pagination.
 *
 * `files.list` returns at most 1000 entries per page and signals more with
 * `nextPageToken`; ignoring the token is the classic way a gallery mysteriously
 * shows only the first thousand photos.
 *
 * Subfolders are NOT traversed. The requirement is "everything in one folder",
 * and recursing would let an unrelated folder dragged into the tree publish
 * itself by accident.
 */
export async function listFolderImages(accessToken: string, folderId: string): Promise<GalleryFile[]> {
    if (!folderId) throw new Error("No Drive folder id was configured.");

    const files: GalleryFile[] = [];
    let pageToken: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
            // A folder-scoped query: direct children only, not trashed.
            q: `'${folderId}' in parents and trashed = false`,
            fields: "nextPageToken, files(id,name,mimeType,imageMediaMetadata(width,height,rotation),modifiedTime,size,trashed)",
            pageSize: "1000",
            // Wide enough for a large photo library without one pathological
            // folder blowing the time budget; a partial list is worse than a
            // clear failure, so this is generous.
            orderBy: "name_natural",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
        });
        if (pageToken) params.set("pageToken", pageToken);

        const res = await driveFetch(`${DRIVE_API_BASE}/files?${params.toString()}`, accessToken);
        if (!res.ok) {
            throw new Error(`Drive rejected the folder listing (${res.status}).`);
        }

        const parsed = parseListPage(await res.json());
        files.push(...parsed.files);
        if (!parsed.nextPageToken) return files;
        pageToken = parsed.nextPageToken;
    }

    // Hitting the page ceiling means the folder is far larger than this design
    // anticipates. Returning the partial list would silently drop photos, so
    // this surfaces instead.
    throw new Error(`Drive folder has more than ${MAX_PAGES} pages of images; refusing to return a partial list.`);
}

/**
 * Upload one image into a Drive folder.
 *
 * Uses a multipart upload: the metadata and the bytes go in a single request,
 * which is the documented approach for files up to 5 MB. Anything larger would
 * need a resumable session, and is rejected by the caller before it gets here
 * (see `validateGalleryUpload`).
 *
 * Returns the created file's id and name, or throws. The caller records the
 * failure so the sync can retry -- an upload that reached Drive but whose
 * response was lost is reconciled on the next sweep by name.
 */
export async function uploadImage(
    accessToken: string,
    folderId: string,
    file: { name: string; mimeType: string; bytes: Uint8Array },
): Promise<{ id: string; name: string }> {
    if (!folderId) throw new Error("No Drive folder id was configured.");

    const boundary = `autoboat_${crypto.randomUUID().replace(/-/g, "")}`;
    const metadata = JSON.stringify({ name: file.name, parents: [folderId] });

    // WARNING: The body is assembled as bytes, not as a string. A string round trip
    // would corrupt any binary that is not valid UTF-8, which for a JPEG is
    // most of it. `TextEncoder` is used only for the two ASCII parts.
    const encoder = new TextEncoder();
    const head = encoder.encode(
        `--${boundary}\r\n` +
            "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
            `${metadata}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: ${file.mimeType}\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + file.bytes.length + tail.length);
    body.set(head, 0);
    body.set(file.bytes, head.length);
    body.set(tail, head.length + file.bytes.length);

    const params = new URLSearchParams({
        uploadType: "multipart",
        // The gallery needs the new id back to put it in the manifest, so the
        // response is trimmed to the two fields used.
        fields: "id,name",
        supportsAllDrives: "true",
    });

    const res = await driveFetch(`${DRIVE_UPLOAD_BASE}/files?${params.toString()}`, accessToken, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
    });
    if (!res.ok) {
        // The body often explains the cause (quota exceeded is the common one
        // for a service account without a Shared Drive), and unlike a token
        // error it contains no credentials.
        let detail = "";
        try {
            const err = (await res.json()) as Record<string, unknown>;
            const inner = err.error as Record<string, unknown> | undefined;
            if (inner && typeof inner.message === "string") detail = ` ${inner.message}`;
        } catch {
            // Leave the status-only message.
        }
        throw new Error(`Drive rejected the upload (${res.status}).${detail}`);
    }

    const created = (await res.json()) as { id?: unknown; name?: unknown };
    if (typeof created.id !== "string" || !created.id) {
        throw new Error("Drive returned an unusable upload response.");
    }
    return { id: created.id, name: typeof created.name === "string" ? created.name : file.name };
}

/**
 * Stream a file's bytes from Drive.
 *
 * The response body is handed back unread so the caller can pipe it straight
 * into R2 or out to the browser without buffering the whole image in the
 * isolate's 128 MB of memory.
 *
 * `Range` is forwarded when supplied, so a large image can continue from where
 * it stopped instead of restarting.
 */
export async function downloadFile(accessToken: string, fileId: string, range?: string | null): Promise<Response> {
    const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    const headers: Record<string, string> = {};
    if (range) headers.Range = range;

    return driveFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`, accessToken, {
        headers,
    });
}

/**
 * Fetch one file's metadata.
 *
 * Used to confirm a file still exists and is still an image before serving it,
 * and to recover the MIME type when only an id is known.
 */
export async function getFileMetadata(accessToken: string, fileId: string): Promise<GalleryFile | null> {
    const params = new URLSearchParams({
        fields: "id,name,mimeType,imageMediaMetadata(width,height,rotation),modifiedTime,size,trashed",
        supportsAllDrives: "true",
    });
    const res = await driveFetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
        accessToken,
    );
    if (!res.ok) return null;
    return toGalleryFile((await res.json()) as DriveFile);
}
