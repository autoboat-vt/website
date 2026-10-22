/**
 * Validation for an officer's gallery upload.
 *
 * Pure -- it inspects the declared metadata and the byte length, and returns
 * either a Drive-ready payload or a message meant for the person who chose the
 * file. `index.ts` owns the session check, the Drive call, and the sync.
 *
 * WARNING: THE SIZE LIMIT IS DRIVE'S, NOT OURS. Up to 5 MB is the documented
 * ceiling for a multipart upload (metadata and bytes in one request), which is
 * the only upload type that fits a single Worker request. A larger file needs a
 * resumable session spanning several requests, so it is refused here with a
 * message that tells the officer to shrink the photo rather than accepting it
 * and failing halfway through.
 *
 * The type allowlist exists for a second reason beyond the browser: a file whose
 * MIME type the gallery cannot render would be uploaded, listed, mirrored, and
 * then show as a broken tile on a public page. Refusing it at the door is the
 * only point where a human is present to see why.
 */

import { isSupportedImage, SUPPORTED_IMAGE_TYPES } from "./drive";

/**
 * Largest file accepted for upload, in bytes.
 *
 * 5 MB is Google's multipart ceiling. Kept a shade under (4.5 MB) because the
 * multipart envelope adds the metadata part on top of the file itself, and a
 * file sitting exactly at 5 MB would fail after the bytes were already sent.
 */
export const MAX_UPLOAD_BYTES = 4_500_000;

/** Title-case list of allowed types, for the error message. */
const ALLOWED_DESCRIPTION = SUPPORTED_IMAGE_TYPES.map((t) => t.replace("image/", "").toUpperCase()).join(", ");

/**
 * The rejection for a HEIC/HEIF photo.
 *
 * WHY IT IS ITS OWN MESSAGE. HEIC is the single most likely rejection an iPhone
 * user will hit -- it is the camera's default format -- and "unsupported type"
 * does not tell them there is a setting that fixes it. Shared between the
 * declared-type check and the byte sniff so the two cannot disagree; the
 * declared-type check runs FIRST, so without this the byte-level message was
 * unreachable for a real .heic upload.
 */
export const HEIC_REJECTION =
    'HEIC photos cannot be shown in a browser. On iPhone, set Camera > Formats to "Most Compatible", ' +
    "or export the photo as JPEG before uploading.";

/** Whether a MIME type is the HEIC/HEIF family, which gets the specific message. */
function isHeicType(mimeType: string): boolean {
    return mimeType === "image/heic" || mimeType === "image/heif";
}

/** What the caller submits. */
export interface GalleryUploadInput {
    /** Original filename from the file chooser. */
    name?: unknown;
    /** Declared MIME type. */
    mimeType?: unknown;
    /** Byte length, checked without reading the body. */
    size?: unknown;
}

export interface ValidatedUpload {
    name: string;
    mimeType: string;
}

export type UploadValidation = { ok: true; value: ValidatedUpload } | { ok: false; error: string };

/**
 * Reduce a filename to something safe to store and show.
 *
 * WARNING: Path separators are stripped, not escaped. Drive treats a `/` in a name
 * as an ordinary character, so the file would upload successfully under a
 * confusing name -- and the manifest would then display a path-like string as
 * alt text. The gallery only ever wants the leaf name.
 *
 * A name that reduces to nothing falls back to a generated one, because an
 * unnamed file breaks the alt text (and therefore accessibility) rather than
 * merely looking odd.
 */
export function sanitizeFileName(raw: string, fallbackId: string): string {
    const leaf = raw.split(/[/\\]/).pop() ?? "";
    const cleaned = leaf
        // Control characters and the separators Windows forbids. Drive accepts
        // more, but a name that survives every sync tool is worth more than
        // the handful of exotic characters given up.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
        .replace(/[\u0000-\u001f<>:"|?*]/g, "")
        .trim()
        // A leading dot hides the file on Unix-like systems, and Drive honors
        // that convention in its UI.
        .replace(/^\.+/, "");
    if (!cleaned) return `photo-${fallbackId}.jpg`;
    // Drive's own limit is 255 bytes of UTF-8. Trimming by code unit is close
    // enough here and cannot split a surrogate pair at this length in practice,
    // but the extension is preserved explicitly so the type stays obvious.
    if (cleaned.length <= 120) return cleaned;
    const dot = cleaned.lastIndexOf(".");
    const ext = dot > 0 ? cleaned.slice(dot) : "";
    return `${cleaned.slice(0, 120 - ext.length)}${ext}`;
}

/**
 * Validate an upload's metadata against what Drive and the gallery accept.
 *
 * The filename is sanitized rather than rejected: an officer uploading
 * "regatta: day 1.jpg" should get a working upload, not a lecture about
 * punctuation.
 */
export function validateGalleryUpload(input: GalleryUploadInput): UploadValidation {
    const rawName = typeof input.name === "string" ? input.name : "";
    const mimeType = typeof input.mimeType === "string" ? input.mimeType.trim().toLowerCase() : "";

    // WARNING: Checked BEFORE the generic allowlist so an iPhone photo gets the
    // actionable message. Ordering matters: HEIC is not in the allowlist, so the
    // generic branch below would otherwise swallow it.
    if (isHeicType(mimeType)) return { ok: false, error: HEIC_REJECTION };

    if (!isSupportedImage(mimeType)) {
        return { ok: false, error: `Unsupported image type. Use one of: ${ALLOWED_DESCRIPTION}.` };
    }

    const size = typeof input.size === "number" ? input.size : Number.NaN;
    if (!Number.isFinite(size) || size <= 0) {
        return { ok: false, error: "That file is empty." };
    }
    if (size > MAX_UPLOAD_BYTES) {
        const mb = (MAX_UPLOAD_BYTES / 1_000_000).toFixed(1);
        return { ok: false, error: `Image is too large (${mb} MB maximum). Resize it and try again.` };
    }

    return {
        ok: true,
        value: { name: sanitizeFileName(rawName, crypto.randomUUID().slice(0, 8)), mimeType },
    };
}

/**
 * Whether the browser's declared type can be trusted.
 *
 * It cannot, on its own: `File.type` comes from the operating system's guess at
 * the extension and is trivially spoofed. So the first bytes are checked
 * against the declared type as well -- see `sniffImageType`. This exists as its
 * own function because "the extension says .jpg" and "the bytes are a JPEG" are
 * different claims, and the gallery needs the second one.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
    if (bytes.length < 12) return null;

    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return "image/png";
    }

    // GIF: "GIF87a" or "GIF89a"
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";

    // WebP: "RIFF" .... "WEBP"
    if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "image/webp";
    }

    // AVIF/HEIF share the ISO-BMFF box layout: "ftyp" at offset 4, then a brand.
    // AVIF is the only one of the family a browser can render, so the brand is
    // checked rather than accepting the whole container.
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        const brand = String.fromCharCode(...bytes.subarray(8, 12));
        if (brand === "avif" || brand === "avis") return "image/avif";
        // HEIC/HEIF. Reported specifically so the refusal can be actionable --
        // iPhones produce these by default and the fix is an export setting.
        if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1") return "image/heic";
    }

    return null;
}

/**
 * Final check that the bytes really are the image they claim to be.
 *
 * WARNING: HEIC gets its own message. It is the single most likely rejection an
 * iPhone user will hit, and "unsupported type" does not tell them what to do
 * about it. Everything else gets the generic message.
 */
export function checkImageBytes(bytes: Uint8Array): { ok: true; mimeType: string } | { ok: false; error: string } {
    const sniffed = sniffImageType(bytes);
    if (sniffed === null) {
        return { ok: false, error: "That file does not look like an image." };
    }
    if (sniffed === "image/heic") {
        return { ok: false, error: HEIC_REJECTION };
    }
    if (!isSupportedImage(sniffed)) {
        return { ok: false, error: `Unsupported image type. Use one of: ${ALLOWED_DESCRIPTION}.` };
    }
    return { ok: true, mimeType: sniffed };
}
