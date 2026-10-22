/**
 * @jest-environment node
 *
 * Tests for the OAuth return-path and redirect-URI selection.
 *
 * Two things are security-relevant here:
 *
 *  1. The return path is an OPEN-REDIRECT candidate. It rides through Discord and
 *     is used to navigate the browser, so an arbitrary value would be a phishing
 *     primitive ("sign in, then land on evil.example"). The allowlist is the
 *     control, and these tests pin that it fails closed.
 *  2. The redirect URI must be SELECTED from registered entries, never built
 *     from request input. Building one would make any host a redirect target.
 */

import {
    DEFAULT_RETURN_PATH,
    parseRedirectUris,
    RETURN_PATH_ALLOWLIST,
    redirectUriFor,
    resolveReturnPath,
} from "../../../worker/src/oauth";

const CALENDAR = "https://autoboat.aoe.vt.edu/calendar/";
const GALLERY = "https://autoboat.aoe.vt.edu/gallery/";

describe("resolveReturnPath", () => {
    it("accepts every allowlisted path", () => {
        for (const path of RETURN_PATH_ALLOWLIST) {
            expect(resolveReturnPath(path)).toBe(path);
        }
    });

    it("normalizes a bare path to its trailing-slash form", () => {
        // A trailing slash must not be a source of silent mismatch: the page
        // says "/gallery" and the allowlist says "/gallery/".
        expect(resolveReturnPath("/gallery")).toBe("/gallery/");
    });

    it("falls back to the calendar for an absolute URL", () => {
        // THE OPEN-REDIRECT CASE.
        expect(resolveReturnPath("https://evil.example/steal")).toBe(DEFAULT_RETURN_PATH);
    });

    it("falls back for a protocol-relative URL", () => {
        // "//evil.example" is a different ORIGIN even though it starts with a
        // slash. This is the case a naive startsWith("/") check would miss.
        expect(resolveReturnPath("//evil.example")).toBe(DEFAULT_RETURN_PATH);
    });

    it("falls back for a path that is not allowlisted", () => {
        expect(resolveReturnPath("/admin/")).toBe(DEFAULT_RETURN_PATH);
    });

    it("falls back for a lookalike path", () => {
        expect(resolveReturnPath("/gallery-evil/")).toBe(DEFAULT_RETURN_PATH);
        expect(resolveReturnPath("/gallery/../admin/")).toBe(DEFAULT_RETURN_PATH);
    });

    it("falls back for a non-string or missing value", () => {
        expect(resolveReturnPath(null)).toBe(DEFAULT_RETURN_PATH);
        expect(resolveReturnPath(undefined)).toBe(DEFAULT_RETURN_PATH);
        expect(resolveReturnPath(42)).toBe(DEFAULT_RETURN_PATH);
        expect(resolveReturnPath("")).toBe(DEFAULT_RETURN_PATH);
    });
});

describe("parseRedirectUris", () => {
    it("splits and trims a comma-separated list", () => {
        expect(parseRedirectUris(`${CALENDAR}, ${GALLERY}`)).toEqual([CALENDAR, GALLERY]);
    });

    it("drops blank entries, so a trailing comma is harmless", () => {
        expect(parseRedirectUris(`${CALENDAR},`)).toEqual([CALENDAR]);
        expect(parseRedirectUris(`${CALENDAR}, ,${GALLERY}`)).toEqual([CALENDAR, GALLERY]);
    });

    it("returns an empty list for an unset value", () => {
        expect(parseRedirectUris(undefined)).toEqual([]);
        expect(parseRedirectUris("")).toEqual([]);
    });
});

describe("redirectUriFor", () => {
    const registered = [CALENDAR, GALLERY];

    it("selects the entry whose path matches the return path", () => {
        expect(redirectUriFor("/gallery/", registered, CALENDAR)).toBe(GALLERY);
        expect(redirectUriFor("/calendar/", registered, CALENDAR)).toBe(CALENDAR);
    });

    it("matches a bare path to a trailing-slash entry", () => {
        expect(redirectUriFor("/gallery", registered, CALENDAR)).toBe(GALLERY);
    });

    it("falls back when no entry matches", () => {
        // A single-URI deployment keeps working: the configured value is used
        // and Discord accepts it because it IS the registered one.
        expect(redirectUriFor("/gallery/", [CALENDAR], CALENDAR)).toBe(CALENDAR);
    });

    it("falls back when the list is empty", () => {
        expect(redirectUriFor("/gallery/", [], CALENDAR)).toBe(CALENDAR);
    });

    it("never returns a URI outside the registered list", () => {
        // The whole point: selection, not construction. A return path that
        // resolves somewhere unexpected still only ever yields a configured URI.
        const result = redirectUriFor("https://evil.example/", registered, CALENDAR);
        expect(registered).toContain(result);
    });

    it("skips an unparseable entry instead of returning it", () => {
        expect(redirectUriFor("/gallery/", ["not a url", GALLERY], CALENDAR)).toBe(GALLERY);
    });
});
