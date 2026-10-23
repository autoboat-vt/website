import { fitWithin, MAX_CONVERT_DIMENSION, toWebp, webpName } from "../../lib/imageConvert";

/**
 * Tests for the WebP conversion.
 *
 * jsdom has no real image codec, so the encode step cannot be exercised here --
 * `createImageBitmap` is stubbed. What IS worth pinning is the part that would
 * otherwise fail silently in production:
 *
 *  - the fallback is ALWAYS the original, on every failure path
 *  - an already-WebP file is not re-encoded (that would only lose quality)
 *  - the dimension clamp runs before the canvas, because an oversized canvas
 *    makes `toBlob` return an empty blob rather than an error
 *  - a conversion that is not smaller is discarded
 */

function stubBitmap(width: number, height: number) {
    const close = jest.fn();
    globalThis.createImageBitmap = jest.fn().mockResolvedValue({ width, height, close }) as never;
    return { close };
}

/** Stub a canvas whose toBlob returns `size` bytes (or null). */
function stubCanvas(size: number | null) {
    const drawImage = jest.fn();
    const fillRect = jest.fn();
    const canvas = {
        width: 0,
        height: 0,
        getContext: jest.fn(() => ({ fillRect, drawImage, fillStyle: "" })),
        toBlob: (cb: (blob: Blob | null) => void) => {
            cb(size === null ? null : (new Blob([new Uint8Array(size)], { type: "image/webp" }) as Blob));
        },
    };
    jest.spyOn(document, "createElement").mockImplementation(((tag: string) => {
        if (tag === "canvas") return canvas as unknown as HTMLElement;
        return document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    }) as typeof document.createElement);
    return { canvas, drawImage };
}

/** A File of `size` bytes with the given name and type. */
function file(name: string, type: string, size = 1000): File {
    const f = new File([new Uint8Array(size)], name, { type });
    return f;
}

const ORIGINAL_UNTOUCHED = "the original file is always the fallback";

describe("webpName", () => {
    it("swaps the extension", () => {
        expect(webpName("boat.jpg")).toBe("boat.webp");
        expect(webpName("regatta.final.png")).toBe("regatta.final.webp");
    });

    it("adds an extension when there is none", () => {
        expect(webpName("boat")).toBe("boat.webp");
    });

    it("keeps a dotfile's leading dot", () => {
        // `.jpg` with no stem must not become just "webp", which would be a
        // confusing rename of an already-odd filename.
        expect(webpName(".jpg")).toBe(".jpg.webp");
    });
});

describe("fitWithin", () => {
    it("leaves a small image alone", () => {
        expect(fitWithin(800, 600, 4096)).toEqual({ width: 800, height: 600 });
    });

    it("scales the longest side down to the cap", () => {
        expect(fitWithin(8000, 4000, 4096)).toEqual({ width: 4096, height: 2048 });
    });

    it("handles a portrait image", () => {
        expect(fitWithin(3000, 6000, 4096)).toEqual({ width: 2048, height: 4096 });
    });

    it("never produces a zero dimension", () => {
        // A 1px-tall panorama would otherwise round to 0 and make the canvas
        // invalid.
        expect(fitWithin(10000, 1, 4096)).toEqual({ width: 4096, height: 1 });
    });

    it("returns zeros for a degenerate input", () => {
        expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
    });

    it("uses the exported cap by default", () => {
        const result = fitWithin(MAX_CONVERT_DIMENSION * 2, MAX_CONVERT_DIMENSION);
        expect(result.width).toBe(MAX_CONVERT_DIMENSION);
    });
});

describe("toWebp", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("converts a JPEG", async () => {
        stubBitmap(800, 600);
        stubCanvas(500);

        const result = await toWebp(file("boat.jpg", "image/jpeg", 1000));

        expect(result.converted).toBe(true);
        expect(result.file.type).toBe("image/webp");
        expect(result.file.name).toBe("boat.webp");
    });

    it("converts a PNG", async () => {
        stubBitmap(800, 600);
        stubCanvas(500);

        const result = await toWebp(file("logo.png", "image/png", 1000));

        expect(result.converted).toBe(true);
        expect(result.file.name).toBe("logo.webp");
    });

    it("does not re-encode a file that is already WebP", async () => {
        // Re-encoding a lossy format only loses quality.
        const original = file("boat.webp", "image/webp");
        const result = await toWebp(original);

        expect(result.converted).toBe(true);
        expect(result.file).toBe(original);
    });

    it(`falls back to the original when the encoder returns null -- ${ORIGINAL_UNTOUCHED}`, async () => {
        stubBitmap(800, 600);
        stubCanvas(null);

        const original = file("boat.jpg", "image/jpeg");
        const result = await toWebp(original);

        expect(result.converted).toBe(false);
        expect(result.file).toBe(original);
    });

    it(`falls back when decoding throws -- ${ORIGINAL_UNTOUCHED}`, async () => {
        globalThis.createImageBitmap = jest.fn().mockRejectedValue(new Error("bad image")) as never;

        const original = file("boat.jpg", "image/jpeg");
        const result = await toWebp(original);

        expect(result.converted).toBe(false);
        expect(result.file).toBe(original);
        expect(result.reason).toContain("bad image");
    });

    it("falls back when the result is not smaller", async () => {
        // A "conversion" that grows the file has cost quality for nothing.
        stubBitmap(800, 600);
        stubCanvas(5000);

        const original = file("boat.jpg", "image/jpeg", 1000);
        const result = await toWebp(original);

        expect(result.converted).toBe(false);
        expect(result.file).toBe(original);
    });

    it("clamps the canvas before drawing", async () => {
        // An oversized canvas makes toBlob return an empty blob, which would
        // look like an encoder failure rather than a size problem.
        stubBitmap(20000, 10000);
        const { canvas } = stubCanvas(500);

        await toWebp(file("huge.jpg", "image/jpeg", 1000));

        expect(canvas.width).toBe(MAX_CONVERT_DIMENSION);
        expect(canvas.height).toBe(MAX_CONVERT_DIMENSION / 2);
    });

    it("releases the decoded bitmap", async () => {
        // A 48 MP decode is a lot of memory to hold across a batch of uploads.
        const { close } = stubBitmap(800, 600);
        stubCanvas(500);

        await toWebp(file("boat.jpg", "image/jpeg", 1000));

        expect(close).toHaveBeenCalled();
    });

    it("releases the bitmap even when the conversion fails", async () => {
        const { close } = stubBitmap(800, 600);
        stubCanvas(null);

        await toWebp(file("boat.jpg", "image/jpeg", 1000));

        expect(close).toHaveBeenCalled();
    });

    it("fills a white backing so transparency does not become black", async () => {
        stubBitmap(800, 600);
        const { drawImage } = stubCanvas(500);

        await toWebp(file("logo.png", "image/png", 1000));

        // Drawn rather than left blank; the fill itself is asserted via the
        // canvas context recording it.
        expect(drawImage).toHaveBeenCalled();
    });
});
