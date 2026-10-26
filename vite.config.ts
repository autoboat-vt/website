import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 3000,
        open: true,
    },
    // Expose selected VITE_* env vars to the bundle as plain globals so they
    // can be read without `import.meta.env` (which doesn't parse under Jest's
    // CJS runtime). Source code reads `globalThis.__VITE_TELEMETRY_URL__` /
    // `globalThis.__VITE_EVENTS_URL__`.
    //
    // VITE_GALLERY_IMAGE_BASE is the escape hatch for serving gallery IMAGE
    // bytes from the site's own domain instead of the Worker origin. It cannot
    // be set today because autoboat.aoe.vt.edu is plain S3 on VT's DNS (see
    // galleryClient.ts), but when that changes, pointing this at
    // https://autoboat.aoe.vt.edu/gallery switches every <img> over with no
    // source edit.
    define: {
        "globalThis.__VITE_TELEMETRY_URL__": JSON.stringify(process.env.VITE_TELEMETRY_URL ?? ""),
        "globalThis.__VITE_EVENTS_URL__": JSON.stringify(process.env.VITE_EVENTS_URL ?? ""),
        "globalThis.__VITE_GALLERY_IMAGE_BASE__": JSON.stringify(process.env.VITE_GALLERY_IMAGE_BASE ?? ""),
    },
});
