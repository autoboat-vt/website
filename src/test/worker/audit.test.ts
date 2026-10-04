/**
 * @jest-environment node
 *
 * Unit tests for guild audit-log deletion parsing (worker/src/audit.ts).
 *
 * `routes.test.ts` covers the end-to-end behavior through the Worker's real
 * `fetch` handler; these pin the payload shape directly. The module is pure
 * (no bindings, no fetch), so it is imported by relative path the same way the
 * other Worker suites import their modules.
 */

import { GUILD_SCHEDULED_EVENT_DELETE, parseDeletedEventIds } from "../../../worker/src/audit";

/** One audit-log entry of the given action type. */
function entry(action_type: number, target_id: unknown) {
    return { id: "log-1", action_type, target_id, user_id: "1" };
}

describe("parseDeletedEventIds", () => {
    it("exposes Discord's delete action type as 102", () => {
        // The one magic number in this module; pin it so a typo cannot quietly
        // stop matching every real entry.
        expect(GUILD_SCHEDULED_EVENT_DELETE).toBe(102);
    });

    it("collects the target_id of every deletion entry", () => {
        const payload = {
            audit_log_entries: [
                entry(GUILD_SCHEDULED_EVENT_DELETE, "event-1"),
                entry(GUILD_SCHEDULED_EVENT_DELETE, "event-2"),
            ],
        };

        expect([...parseDeletedEventIds(payload)].sort()).toEqual(["event-1", "event-2"]);
    });

    it("ignores every other action type", () => {
        // CREATE (100) and UPDATE (101) must not read as deletions or the
        // archive would drop live events. A completed event does NOT produce a
        // 102, which is what makes this signal mean "deleted" specifically.
        const payload = {
            audit_log_entries: [
                entry(100, "created-1"),
                entry(101, "updated-1"),
                entry(72, "a-message"),
                entry(GUILD_SCHEDULED_EVENT_DELETE, "deleted-1"),
            ],
        };

        expect([...parseDeletedEventIds(payload)]).toEqual(["deleted-1"]);
    });

    it("deduplicates repeated ids", () => {
        const payload = {
            audit_log_entries: [
                entry(GUILD_SCHEDULED_EVENT_DELETE, "event-1"),
                entry(GUILD_SCHEDULED_EVENT_DELETE, "event-1"),
            ],
        };

        expect(parseDeletedEventIds(payload).size).toBe(1);
    });

    it("returns an empty set for an empty log", () => {
        expect(parseDeletedEventIds({ audit_log_entries: [] }).size).toBe(0);
    });

    it("returns an empty set rather than throwing on an unrecognisable payload", () => {
        // The audit log is an enhancement over the archive's keep-everything
        // default, so a malformed payload must degrade to "no deletions known"
        // -- never to a throw that would fail the whole response.
        for (const payload of [
            null,
            undefined,
            42,
            "nope",
            {},
            { audit_log_entries: "no" },
            { audit_log_entries: [null] },
        ]) {
            expect(parseDeletedEventIds(payload).size).toBe(0);
        }
    });

    it("skips deletion entries with a missing or unusable target_id", () => {
        const payload = {
            audit_log_entries: [
                entry(GUILD_SCHEDULED_EVENT_DELETE, null),
                entry(GUILD_SCHEDULED_EVENT_DELETE, ""),
                entry(GUILD_SCHEDULED_EVENT_DELETE, 12345),
                entry(GUILD_SCHEDULED_EVENT_DELETE, "real-1"),
            ],
        };

        expect([...parseDeletedEventIds(payload)]).toEqual(["real-1"]);
    });
});
