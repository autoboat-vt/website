import { EVENTS_URL } from "../../lib/discord";
import { completeLoginFromUrl } from "../../lib/loginRedirect";

/**
 * Tests for the shared `?code=` handling used by both the calendar and the
 * gallery.
 *
 * The cases that matter:
 *  - the query string is cleared BEFORE the exchange, because the code is
 *    single-use (a refresh would replay it)
 *  - no redirect in the URL is a no-op, not a failure
 *  - a Discord error and a permission refusal produce DIFFERENT outcomes, since
 *    they need different wording
 */

const CALLBACK_URL = `${EVENTS_URL}/manage/auth/callback`;

const LOCATION = { search: "", pathname: "/gallery/", hash: "" };

/** Stub fetch with a single JSON response. */
function mockFetch(response: { ok: boolean; status: number; body: unknown }) {
    const fn = jest.fn().mockResolvedValue({
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
}

describe("completeLoginFromUrl", () => {
    let replaceState: jest.Mock;

    beforeEach(() => {
        replaceState = jest.fn();
        globalThis.localStorage?.clear();
    });

    it("does nothing when there is no redirect in the URL", async () => {
        const fetchMock = mockFetch({ ok: true, status: 200, body: {} });
        const result = await completeLoginFromUrl(LOCATION, replaceState);

        expect(result.kind).toBe("none");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(replaceState).not.toHaveBeenCalled();
    });

    it("ignores a code without a state", async () => {
        // Posting a code with no state cannot pass verification, so spending a
        // request on it would only produce a confusing error.
        const fetchMock = mockFetch({ ok: true, status: 200, body: {} });
        const result = await completeLoginFromUrl({ ...LOCATION, search: "?code=abc" }, replaceState);

        expect(result.kind).toBe("none");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("clears the code from the URL before exchanging it", async () => {
        // THE SINGLE-USE RULE. A leftover code invites a refresh that replays a
        // spent code and fails confusingly.
        const fetchMock = mockFetch({ ok: true, status: 200, body: { token: "t", name: "O", expiresIn: 60 } });
        await completeLoginFromUrl({ ...LOCATION, search: "?code=abc&state=xyz" }, replaceState);

        expect(replaceState).toHaveBeenCalledWith("/gallery/");
        // And the exchange happened (so clearing did not prevent it).
        expect(fetchMock).toHaveBeenCalledWith(CALLBACK_URL, expect.objectContaining({ method: "POST" }));
    });

    it("preserves an unrelated query parameter when clearing", async () => {
        mockFetch({ ok: true, status: 200, body: { token: "t", name: "O", expiresIn: 60 } });
        await completeLoginFromUrl({ ...LOCATION, search: "?code=abc&state=xyz&ref=team" }, replaceState);

        expect(replaceState).toHaveBeenCalledWith("/gallery/?ref=team");
    });

    it("returns the session on success", async () => {
        mockFetch({ ok: true, status: 200, body: { token: "tok", name: "Officer", expiresIn: 7200 } });
        const result = await completeLoginFromUrl({ ...LOCATION, search: "?code=abc&state=xyz" }, replaceState);

        expect(result.kind).toBe("success");
        if (result.kind !== "success") throw new Error("unreachable");
        expect(result.session.token).toBe("tok");
        expect(result.session.name).toBe("Officer");
    });

    it("returns the signed return path from the Worker", async () => {
        mockFetch({ ok: true, status: 200, body: { token: "t", name: "O", expiresIn: 60, returnPath: "/gallery/" } });
        const result = await completeLoginFromUrl({ ...LOCATION, search: "?code=abc&state=xyz" }, replaceState);

        expect(result.kind === "success" && result.session.returnPath).toBe("/gallery/");
    });

    it("defaults the return path to the calendar for an older Worker", async () => {
        // A Worker deployed before the return path existed must not break the
        // login; it lands where every login used to land.
        mockFetch({ ok: true, status: 200, body: { token: "t", name: "O", expiresIn: 60 } });
        const result = await completeLoginFromUrl({ ...LOCATION, search: "?code=abc&state=xyz" }, replaceState);

        expect(result.kind === "success" && result.session.returnPath).toBe("/calendar/");
    });

    it("reports a permission refusal separately from a generic failure", async () => {
        // The two need different wording: a refusal says what to do, a failure
        // just says it failed.
        //
        // NOTE: `missing-role` deliberately does NOT name the Discord account --
        // a re-login cannot grant a role, so naming the account would invite
        // the user to try the one fix that cannot work. Only `not-a-member`
        // (the wrong-account case) names it.
        mockFetch({
            ok: false,
            status: 403,
            body: { reason: "missing-role", error: "no role", account: "Someone", guildName: "Team" },
        });
        const result = await completeLoginFromUrl({ ...LOCATION, search: "?code=abc&state=xyz" }, replaceState);

        expect(result.kind).toBe("denied");
        if (result.kind !== "denied") throw new Error("unreachable");
        expect(result.error.remedy).toContain("Team");
        expect(result.error.remedy).not.toContain("different account");
    });

    it("names the account when the login used the wrong Discord account", async () => {
        // `not-a-member` is usually a personal-vs-school account mix-up, so this
        // branch DOES name the account and DOES offer a re-login.
        mockFetch({
            ok: false,
            status: 403,
            body: { reason: "not-a-member", error: "not a member", account: "Someone", guildName: "Team" },
        });
        const result = await completeLoginFromUrl({ ...LOCATION, search: "?code=abc&state=xyz" }, replaceState);

        expect(result.kind).toBe("denied");
        if (result.kind !== "denied") throw new Error("unreachable");
        expect(result.error.remedy).toContain("Someone");
        // The actionable hint names the real fix: use the other account.
        expect(result.error.remedy).toContain("sign in with that one");
    });

    it("reports a generic failure when the exchange fails", async () => {
        mockFetch({ ok: false, status: 500, body: { error: "Server exploded." } });
        const result = await completeLoginFromUrl({ ...LOCATION, search: "?code=abc&state=xyz" }, replaceState);

        expect(result.kind).toBe("failed");
        expect(result.kind === "failed" && result.message).toContain("Server exploded.");
    });

    it("treats a cancelled consent screen as a failure, not a no-op", async () => {
        // Discord sends ?error=access_denied when the user clicks Cancel. Silent
        // handling would leave them wondering why nothing happened.
        const fetchMock = mockFetch({ ok: true, status: 200, body: {} });
        const result = await completeLoginFromUrl(
            { ...LOCATION, search: "?error=access_denied&state=xyz" },
            replaceState,
        );

        expect(result.kind).toBe("failed");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(replaceState).toHaveBeenCalledWith("/gallery/");
    });
});
