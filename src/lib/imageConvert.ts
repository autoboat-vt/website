/**
 * Convert an image to WebP in the browser, before it is uploaded.
 *
 * WHY CLIENT-SIDE. The Worker has no image encoder (Cloudflare Workers cannot run
 * `sharp` or any native codec), so a conversion there is not possible. The
 * browser already has a decoder and an encoder in `createImageBitmap` and
 * `canvas.toBlob`, so doing it here is both free and the only option -- and it
 * has the side benefit of making the UPLOAD smaller, which matters on a phone at
 * a regatta.
 *
 * WARNING: THIS REPLACES THE BYTES IN DRIVE. The uploaded file is the WebP, not the
 * original JPEG. That is what was asked for, but it does mean the Drive copy is
 * no longer the camera original -- so the conversion uses a HIGH quality setting
 * (see `WEBP_QUALITY`) rather than trading fidelity for size. If the team ever
 * wants true originals archived, they must keep them outside this folder.
 *
 * WARNING: FAILURE MUST NEVER BLOCK AN UPLOAD. Every step can fail -- an
 * unsupported codec, an out-of-memory canvas, a tainted surface -- and the
 * fallback is ALWAYS the original file. A gallery that refuses an upload because
 * an optimization failed is worse than a gallery with a JPEG in it.
 */

/**
 * WebP quality, 0-1.
 *
 * 0.9 is deliberately high: this is the team's photo archive, not a thumbnail. At
 * 0.9 a photo is typically 25-35% smaller than the equivalent JPEG with no
 * visible difference, which is the point -- going lower saves bytes nobody is
 * short of and costs quality that cannot be recovered.
 */
export const WEBP_QUALITY = 0.9;

/**
 * Largest dimension, in pixels, retained on conversion.
 *
 * WHY A CAP EXISTS AT ALL: `canvas.toBlob` silently produces an EMPTY blob when
 * the canvas exceeds the browser's limit (Chrome caps total area near 268 MP,
 * Safari much lower). Clamping first keeps a 48 MP phone photo convertible
 * instead of failing into the fallback.
 *
 * 4096 is chosen to stay under every browser's limit while remaining larger than
 * any sane display need for a gallery tile or lightbox.
 */
export const MAX_CONVERT_DIMENSION = 4096;

/** What the caller gets back. */
export interface ConversionResult {
    /** The bytes to upload. Always present -- the original on failure. */
    file: File;
    /**
     * Whether the bytes are actually WebP.
     *
     * The caller uses this for messaging only; it must not gate the upload.
     */
    converted: boolean;
    /** Why conversion was skipped, when it was. For logs and tests. */
    reason?: string;
}

/** Whether this browser can plausibly do the conversion. */
function canConvert(): boolean {
    return typeof createImageBitmap === "function" && typeof document !== "undefined";
}

/**
 * Scale dimensions to fit `MAX_CONVERT_DIMENSION`, preserving aspect ratio.
 *
 * Returns the input unchanged when it already fits, so a normal photo is not
 * resampled at all.
 */
export function fitWithin(
    width: number,
    height: number,
    max: number = MAX_CONVERT_DIMENSION,
): { width: number; height: number } {
    if (width <= 0 || height <= 0) return { width: 0, height: 0 };
    const longest = Math.max(width, height);
    if (longest <= max) return { width: Math.round(width), height: Math.round(height) };
    const scale = max / longest;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Convert a file to WebP, falling back to the original on any failure.
 *
 * Never throws. The returned `file` is always safe to upload.
 *
 * NOTE: The filename's extension is changed to `.webp` so Drive and any human
 * looking at the folder see a name that matches the bytes. Keeping `.jpg` on WebP
 * content would make the archive misleading.
 */
export async function toWebp(file: File, quality: number = WEBP_QUALITY): Promise<ConversionResult> {
    // Already WebP: nothing to do, and re-encoding would only lose quality.
    if (file.type === "image/webp") return { file, converted: true };

    if (!canConvert()) return { file, converted: false, reason: "no canvas support" };

    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await createImageBitmap(file);
        const { width, height } = fitWithin(bitmap.width, bitmap.height);
        if (width === 0 || height === 0) return { file, converted: false, reason: "zero-sized image" };

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return { file, converted: false, reason: "no 2d context" };

        // A white backing so a PNG with transparency does not become black where
        // the gallery's card background shows through. Photos are opaque anyway,
        // but a logo-style upload would otherwise look broken.
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);

        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob((result) => resolve(result), "image/webp", quality);
        });
        // An unsupported encoder or an oversized canvas yields null (or an empty
        // blob). Either way the original is the answer.
        if (!blob || blob.size === 0) return { file, converted: false, reason: "encoder produced nothing" };
        // A "conversion" that is not smaller has cost quality for nothing.
        if (blob.size >= file.size) return { file, converted: false, reason: "no size benefit" };

        return {
            file: new File([blob], webpName(file.name), { type: "image/webp", lastModified: file.lastModified }),
            converted: true,
        };
    } catch (err) {
        const reason = err instanceof Error ? err.message : "conversion failed";
        return { file, converted: false, reason };
    } finally {
        // Releases the decoded pixels; a 48 MP bitmap is a lot of memory to hold
        // across a batch of uploads.
        bitmap?.close();
    }
}

/** Swap a filename's extension for `.webp`. */
export function webpName(name: string): string {
    const dot = name.lastIndexOf(".");
    // A name with no extension gets one; a dotfile (`.jpg`) keeps its leading dot
    // so it does not become just "webp".
    if (dot <= 0) return `${name}.webp`;
    return `${name.slice(0, dot)}.webp`;
}
