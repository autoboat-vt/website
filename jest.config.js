/** @type {import('jest').Config} */
export default {
    testEnvironment: "jsdom",
    testMatch: ["<rootDir>/src/**/*.{test,spec}.{ts,tsx}"],
    transform: {
        "^.+\\.(t|j)sx?$": [
            "@swc/jest",
            {
                jsc: {
                    parser: {
                        syntax: "typescript",
                        tsx: true,
                        decorators: false,
                    },
                    transform: {
                        react: {
                            runtime: "automatic",
                        },
                    },
                },
                module: {
                    type: "es6",
                },
            },
        ],
    },
    moduleNameMapper: {
        "\\.(css|less|sass|scss)$": "<rootDir>/src/test/__mocks__/styleMock.js",
        "\\.(jpg|jpeg|png|gif|svg|webp|avif)$": "<rootDir>/src/test/__mocks__/fileMock.js",
        // Leaflet / react-leaflet need a real layout engine and don't run
        // cleanly in jsdom. Stub the entire surface with lightweight mocks.
        "^react-leaflet$": "<rootDir>/src/test/__mocks__/react-leaflet.tsx",
        "^leaflet$": "<rootDir>/src/test/__mocks__/leaflet.ts",
        // BoatMarker builds a Leaflet divIcon; stub it so tests can assert
        // which boats are on the map without Leaflet's renderer.
        "^../components/BoatMarker$": "<rootDir>/src/test/__mocks__/BoatMarker.tsx",
        "^../../components/BoatMarker$": "<rootDir>/src/test/__mocks__/BoatMarker.tsx",
    },
    setupFilesAfterEnv: ["<rootDir>/src/test/setup.ts"],
    extensionsToTreatAsEsm: [".ts", ".tsx"],
};
