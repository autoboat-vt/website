/**
 * @jest-environment node
 *
 * The permission gate is the ONLY thing stopping a random Discord account from
 * writing to the team calendar (events are created with the BOT's token, so
 * Discord enforces the bot's permissions). These tests are therefore
 * security tests, not convenience tests.
 */

import {
    canCreateEvents,
    evaluateMembership,
    guildGrantsEventCreation,
    PERMISSION,
    parsePermissions,
} from "../../../worker/src/permissions";

const GUILD = "1017960606403416085";

/** A permission string with exactly these bits set. */
function permissionsOf(...bits: bigint[]): string {
    return bits.reduce((acc, bit) => acc | bit, 0n).toString();
}

describe("parsePermissions", () => {
    it("parses a decimal bitfield string", () => {
        expect(parsePermissions("2048")).toBe(2048n);
    });

    it("parses a value beyond Number.MAX_SAFE_INTEGER exactly", () => {
        // WARNING: the bug this guards: CREATE_EVENTS is 2^44, so a float parse
        // silently corrupts the check. 2^53 is the first integer a double can
        // no longer represent only once it is exceeded, so 2^53 + 1 is the
        // smallest value that round-trips wrong through `Number`.
        const raw = "9007199254740993"; // 2^53 + 1
        expect(parsePermissions(raw)).toBe((1n << 53n) + 1n);
        // The float parse rounds DOWN to 2^53, which is exactly the silent
        // corruption this parser exists to avoid.
        expect(parsePermissions(raw)).not.toBe(BigInt(Number(raw)));
    });

    it("accepts a JSON number", () => {
        expect(parsePermissions(8)).toBe(8n);
    });

    it.each([null, undefined, "", "  ", "abc", "-5", "0x20", "1.5", Number.NaN])("returns null for %p", (raw) => {
        expect(parsePermissions(raw as never)).toBeNull();
    });
});

describe("canCreateEvents", () => {
    it("accepts MANAGE_EVENTS", () => {
        expect(canCreateEvents(PERMISSION.MANAGE_EVENTS)).toBe(true);
    });

    it("accepts ADMINISTRATOR", () => {
        expect(canCreateEvents(PERMISSION.ADMINISTRATOR)).toBe(true);
    });

    it("REJECTS CREATE_EVENTS alone -- only officers may add events", () => {
        // The team's rule. `CREATE_EVENTS` is held by ordinary members, so
        // accepting it would let anyone in the server publish events.
        expect(canCreateEvents(1n << 44n)).toBe(false);
    });

    it("rejects unrelated permissions", () => {
        // VIEW_CHANNEL | CONNECT | SEND_MESSAGES
        expect(canCreateEvents((1n << 10n) | (1n << 20n) | (1n << 11n))).toBe(false);
    });

    it("rejects a null (unreadable) permission set -- fails closed", () => {
        expect(canCreateEvents(null)).toBe(false);
    });

    it("rejects zero", () => {
        expect(canCreateEvents(0n)).toBe(false);
    });
});

describe("guildGrantsEventCreation", () => {
    it("allows the guild owner even without ADMINISTRATOR in the bitfield", () => {
        // Discord reports `owner: true` and does not expand permissions for
        // owners, so this is the case that would otherwise lock out the owner.
        expect(guildGrantsEventCreation({ id: GUILD, name: "Team", owner: true, permissions: "0" })).toBe(true);
    });

    it("allows a member with MANAGE_EVENTS", () => {
        const permissions = permissionsOf(PERMISSION.MANAGE_EVENTS);
        expect(guildGrantsEventCreation({ id: GUILD, name: "Team", permissions })).toBe(true);
    });

    it("refuses a member with only CREATE_EVENTS", () => {
        const permissions = permissionsOf(1n << 44n);
        expect(guildGrantsEventCreation({ id: GUILD, name: "Team", permissions })).toBe(false);
    });

    it("refuses an entry with no permissions field", () => {
        expect(guildGrantsEventCreation({ id: GUILD, name: "Team" })).toBe(false);
    });
});

describe("evaluateMembership", () => {
    it("reports a non-member as member:false", () => {
        const guilds = [{ id: "someone-else", name: "Other", permissions: permissionsOf(PERMISSION.MANAGE_EVENTS) }];
        // `guildName` is null for a non-member: there is no matching guild to
        // name, so the UI falls back to "the team's Discord server".
        expect(evaluateMembership(guilds, GUILD)).toEqual({ member: false, canCreateEvents: false, guildName: null });
    });

    it("distinguishes 'in the server but not an officer' from 'not in the server'", () => {
        // Different UI messages: "ask for the role" vs "join the server".
        const guilds = [{ id: GUILD, name: "Team", permissions: "0" }];
        expect(evaluateMembership(guilds, GUILD)).toEqual({ member: true, canCreateEvents: false, guildName: "Team" });
    });

    it("allows an officer", () => {
        const guilds = [{ id: GUILD, name: "Team", permissions: permissionsOf(PERMISSION.MANAGE_EVENTS) }];
        expect(evaluateMembership(guilds, GUILD)).toEqual({ member: true, canCreateEvents: true, guildName: "Team" });
    });

    it("names the guild so a refusal can say which server is expected", () => {
        // The person is usually signed into the wrong Discord account, so the
        // message has to name the server they should be a member of.
        const guilds = [{ id: GUILD, name: "AutoBoat @ VT", permissions: "0" }];
        expect(evaluateMembership(guilds, GUILD).guildName).toBe("AutoBoat @ VT");
    });

    it("finds the team guild among many", () => {
        const guilds = [
            { id: "1", name: "A", permissions: "0" },
            { id: GUILD, name: "Team", permissions: permissionsOf(PERMISSION.MANAGE_EVENTS) },
            { id: "3", name: "C", permissions: "0" },
        ];
        expect(evaluateMembership(guilds, GUILD).canCreateEvents).toBe(true);
    });

    it("ignores a same-named guild with a different id", () => {
        const guilds = [{ id: "999", name: "Team", permissions: permissionsOf(PERMISSION.MANAGE_EVENTS) }];
        expect(evaluateMembership(guilds, GUILD)).toEqual({ member: false, canCreateEvents: false, guildName: null });
    });
});
