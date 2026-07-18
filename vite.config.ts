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
    // CJS runtime). Source code reads `globalThis.__VITE_TELEMETRY_URL__`.
    define: {
        "globalThis.__VITE_TELEMETRY_URL__": JSON.stringify(process.env.VITE_TELEMETRY_URL ?? ""),
    },
});
