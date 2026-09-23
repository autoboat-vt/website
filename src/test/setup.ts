import { TextDecoder, TextEncoder } from "node:util";
import "@testing-library/jest-dom";

// react-router's development bundle references TextEncoder/TextDecoder,
// which jsdom does not expose on the global object.
if (typeof globalThis.TextEncoder === "undefined") {
    globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
    globalThis.TextDecoder = TextDecoder;
}

// jsdom does not implement window.matchMedia. useTheme() calls it to read the
// prefers-color-scheme media query; stub it with a no-op matcher so hooks
// that depend on it render without error in tests.
//
// Guarded on `window` existing at all: this file is `setupFilesAfterEach`
// for EVERY suite, including the ones that opt into the node environment via a
// `@jest-environment node` docblock (the Worker route tests). Touching
// `window` unguarded there throws `ReferenceError: window is not defined`
// before a single test runs.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    });
}
