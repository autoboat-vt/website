/**
 * @jest-environment node
 *
 * Tests for upload validation and image-type sniffing.
 *
 * The sniffing tests are the important ones: `File.type` comes from the
 * operating system's guess at the extension and is trivially wrong (or
 * spoofed), so the byte check is the only thing standing between a non-image
 * and a public gallery tile that renders as a broken image. The HEIC case
 * matters most in practice because iPhones produce it by default.
 */

import {
    checkImageBytes,
    MAX_UPLOAD_BYTES,
    sanitizeFileName,
    sniffImageType,
    validateGalleryUpload,
} from "../../../worker/src/galleryUpload";

/** Build a byte array with the given prefix, padded to a plausible length. */
function bytes(prefix: number[], length = 32): Uint8Array {
    const out = new Uint8Array(length);
    out.set(prefix, 0);
    return out;
}

/** A minimal valid JPEG: FF D8 FF. */
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0]);
/** PNG signature. */
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** "GIF89a". */
const GIF = bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

/** RIFF....WEBP */
function webp(): Uint8Array {
    return bytes([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
}

/** ISO-BMFF box with an arbitrary brand at offset 8. */
function isoBmff(brand: string): Uint8Array {
    const out = bytes([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    for (let i = 0; i < 4; i++) out[8 + i] = brand.charCodeAt(i);
    return out;
}

describe("sniffImageType", () => {
    it("recognizes each supported format", () => {
        expect(sniffImageType(JPEG)).toBe("image/jpeg");
        expect(sniffImageType(PNG)).toBe("image/png");
        expect(sniffImageType(GIF)).toBe("image/gif");
        expect(sniffImageType(webp())).toBe("image/webp");
        expect(sniffImageType(isoBmff("avif"))).toBe("image/avif");
    });

    it("identifies HEIC separately so the refusal can be actionable", () => {
        // iPhones default to this and no browser can render it. Reporting it as
        // a generic "unsupported" leaves the user with nothing to act on.
        expect(sniffImageType(isoBmff("heic"))).toBe("image/heic");
        expect(sniffImageType(isoBmff("mif1"))).toBe("image/heic");
    });

    it("returns null for data that is not an image", () => {
        expect(sniffImageType(bytes([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
        expect(sniffImageType(bytes([0x00, 0x00, 0x00]))).toBeNull();
    });

    it("returns null for a truncated buffer", () => {
        // A 2-byte "file" cannot be validated by a 12-byte header check.
        expect(sniffImageType(bytes([0xff, 0xd8]))).toBeNull();
    });
});

describe("checkImageBytes", () => {
    it("accepts a real JPEG regardless of what was declared", () => {
        expect(checkImageBytes(JPEG)).toEqual({ ok: true, mimeType: "image/jpeg" });
    });

    it("refuses HEIC with instructions rather than a generic error", () => {
        const result = checkImageBytes(isoBmff("heic"));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error).toContain("HEIC");
        expect(result.error).toContain("JPEG");
    });

    it("refuses a non-image", () => {
        const result = checkImageBytes(bytes([0x25, 0x50, 0x44, 0x46]));
        expect(result.ok).toBe(false);
    });

    it("refuses a format the gallery cannot display", () => {
        // TIFF: not in the allowlist, and a browser would not render it.
        const tiff = bytes([0x49, 0x49, 0x2a, 0x00]);
        expect(checkImageBytes(tiff).ok).toBe(false);
    });
});

describe("sanitizeFileName", () => {
    it("strips path separators, keeping the leaf name", () => {
        // Drive treats "/" as an ordinary character, so the upload would succeed
        // under a confusing name and render as a path in the alt text.
        expect(sanitizeFileName("photos/2026/boat.jpg", "fb")).toBe("boat.jpg");
        expect(sanitizeFileName("C:\\Users\\x\\boat.jpg", "fb")).toBe("boat.jpg");
    });

    it("keeps ordinary punctuation and spaces", () => {
        expect(sanitizeFileName("regatta day 1.jpg", "fb")).toBe("regatta day 1.jpg");
    });

    it("removes characters Windows forbids", () => {
        expect(sanitizeFileName('a:b*c?d"e<f>g|h.jpg', "fb")).toBe("abcdefgh.jpg");
    });

    it("falls back when the name reduces to nothing", () => {
        expect(sanitizeFileName("", "abc123")).toBe("photo-abc123.jpg");
        expect(sanitizeFileName("   ", "abc123")).toBe("photo-abc123.jpg");
        expect(sanitizeFileName("...", "abc123")).toBe("photo-abc123.jpg");
    });

    it("truncates a very long name but keeps the extension", () => {
        const long = `${"a".repeat(300)}.jpg`;
        const result = sanitizeFileName(long, "fb");
        expect(result.length).toBeLessThanOrEqual(120);
        expect(result.endsWith(".jpg")).toBe(true);
    });
});

describe("validateGalleryUpload", () => {
    it("accepts a supported type within the size limit", () => {
        const result = validateGalleryUpload({ name: "boat.jpg", mimeType: "image/jpeg", size: 1000 });
        expect(result).toEqual({ ok: true, value: { name: "boat.jpg", mimeType: "image/jpeg" } });
    });

    it("normalizes the declared type to lowercase", () => {
        const result = validateGalleryUpload({ name: "a.PNG", mimeType: "IMAGE/PNG", size: 10 });
        expect(result.ok && result.value.mimeType).toBe("image/png");
    });

    it("refuses an unsupported type", () => {
        const result = validateGalleryUpload({ name: "a.pdf", mimeType: "application/pdf", size: 10 });
        expect(result.ok).toBe(false);
    });

    it("refuses HEIC by name, since the declared type reaches this check", () => {
        const result = validateGalleryUpload({ name: "a.heic", mimeType: "image/heic", size: 10 });
        expect(result.ok).toBe(false);
    });

    it("refuses an empty file", () => {
        const result = validateGalleryUpload({ name: "a.jpg", mimeType: "image/jpeg", size: 0 });
        expect(result.ok).toBe(false);
    });

    it("refuses a missing size", () => {
        const result = validateGalleryUpload({ name: "a.jpg", mimeType: "image/jpeg" });
        expect(result.ok).toBe(false);
    });

    it("refuses a file over the Drive multipart ceiling", () => {
        const result = validateGalleryUpload({
            name: "a.jpg",
            mimeType: "image/jpeg",
            size: MAX_UPLOAD_BYTES + 1,
        });
        expect(result.ok).toBe(false);
    });

    it("accepts a file exactly at the ceiling", () => {
        const result = validateGalleryUpload({ name: "a.jpg", mimeType: "image/jpeg", size: MAX_UPLOAD_BYTES });
        expect(result.ok).toBe(true);
    });

    it("keeps the limit under Drive's 5 MB multipart ceiling", () => {
        // The multipart envelope adds the metadata part on top of the file, so
        // a file at exactly 5 MB would fail after the bytes were sent.
        expect(MAX_UPLOAD_BYTES).toBeLessThan(5_000_000);
    });
});
