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
