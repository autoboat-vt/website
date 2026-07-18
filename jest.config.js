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
    },
    setupFilesAfterEnv: ["<rootDir>/src/test/setup.ts"],
    extensionsToTreatAsEsm: [".ts", ".tsx"],
};
