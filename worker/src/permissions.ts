/**
 * Discord permission checks for the event-creation flow.
 *
 * THE CENTRAL SECURITY FACT: events are created with the BOT's token, so
 * Discord evaluates the BOT's permissions, not the signed-in user's. The bot
 * holds `MANAGE_EVENTS`, so without an explicit check every visitor who can
 * reach `POST /manage/events` could create events. Discord would not stop them.
 * The gate in this module is therefore the ONLY thing standing between a
 * random Discord account and the team calendar -- it is not a convenience
 * check on top of Discord's own enforcement.
 *
 * The gate is evaluated against `GET /users/@me/guilds`, which returns the
 * user's guild-level permissions as a bitfield string. Two requirements:
 *
 *   1. The team guild appears in the user's guild list (they are a member).
 *   2. That membership carries `MANAGE_EVENTS` or `ADMINISTRATOR`.
 *
 * Only officers may add to the calendar, and `MANAGE_EVENTS` is the permission
 * the officer role actually holds. `CREATE_EVENTS` is deliberately NOT enough:
 * ordinary members hold it, so accepting it would let anyone in the server
 * publish events -- including into the officer channel.
 *
 * SCOPE LIMIT -- channel overwrites are NOT evaluated. Discord's real rule for
 * a VOICE event is "CREATE_EVENTS + VIEW_CHANNEL + CONNECT, computed in the
 * target channel". Reproducing that means fetching the guild's roles, the
 * member's role list, and every channel overwrite, then unioning them. That is
 * a large, easy-to-get-subtly-wrong chunk of Discord's permission algorithm.
 * Instead the gate requires the guild-level permission that only officers
 * hold, which is a strictly stronger check than Discord's own for this team.
 * If the team ever needs a hard per-channel rule, this is the function to
 * extend, and it should be replaced wholesale rather than patched.
 *
 * Deliberately pure -- no bindings, no `fetch` -- so the bit math and the guild
 * lookup are unit-testable on plain objects.
 */

/** Discord permission flags this module reads. */
export const PERMISSION = {
    ADMINISTRATOR: 1n << 3n,
    MANAGE_EVENTS: 1n << 33n,
} as const;

/**
 * Permissions that let a member create events through the website.
 *
 * WARNING: `MANAGE_EVENTS` (or `ADMINISTRATOR`), NOT `CREATE_EVENTS`. The team's
 * rule is that only officers add to the calendar, and `CREATE_EVENTS` is held
 * by ordinary members -- granting writes on that bit alone would let anyone in
 * the server (including into the officer channel) publish events. `ADMINISTRATOR`
 * is ORed in explicitly rather than assumed: `/users/@me/guilds` reports the raw
 * bitfield, and a guild owner's permissions come back WITHOUT the administrator
 * bit expanded into the rest.
 */
const CREATE_EVENT_PERMISSIONS = PERMISSION.MANAGE_EVENTS | PERMISSION.ADMINISTRATOR;

/** One entry of `GET /users/@me/guilds` (only the fields read here). */
export interface DiscordUserGuild {
    id: string;
    name: string;
    /**
     * The member's guild-level permissions, as a snowflake-style DECIMAL STRING.
     *
     * WARNING: This is a string, not a number, and must be parsed with `BigInt`.
     * `Number(...)` loses precision above 2^53, and `MANAGE_EVENTS` is 2^33 --
     * combined with the low bits a real role carries, the total easily exceeds
     * `Number.MAX_SAFE_INTEGER`, so a float parse silently corrupts the check.
     * `owner` is also returned instead of setting ADMINISTRATOR, so it is
     * checked separately.
     */
    permissions?: string;
    owner?: boolean;
}

/**
 * Parse a Discord permission bitfield, tolerating a JSON number.
 *
 * Returns null for anything unparseable so callers fail CLOSED -- an
 * unreadable permission set must never be treated as "no bits set but
 * allowed".
 */
export function parsePermissions(raw: string | number | undefined | null): bigint | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "number") {
        return Number.isFinite(raw) && raw >= 0 ? BigInt(Math.trunc(raw)) : null;
    }
    const trimmed = raw.trim();
    // Only decimal digits. `BigInt("0x20")` would throw, and a value that is
    // not a plain non-negative integer is not a bitfield.
    if (!/^\d+$/.test(trimmed)) return null;
    try {
        return BigInt(trimmed);
    } catch {
        return null;
    }
}

/** Whether a permission bitfield allows creating events. */
export function canCreateEvents(permissions: bigint | null): boolean {
    if (permissions === null) return false;
    return (permissions & CREATE_EVENT_PERMISSIONS) !== 0n;
}

/**
 * Whether this guild entry grants event creation.
 *
 * The guild OWNER is always allowed: Discord reports `owner: true` and does not
 * set ADMINISTRATOR in the permissions field for them, so an owner who would
 * pass every check in the real client could otherwise be refused here.
 */
export function guildGrantsEventCreation(guild: DiscordUserGuild): boolean {
    if (guild.owner === true) return true;
    return canCreateEvents(parsePermissions(guild.permissions));
}

/**
 * Find the team guild in the user's guild list and report what it grants.
 *
 * A missing guild is reported as `member: false` rather than as a permission
 * failure, because the two need different messages: "you are not in the
 * server" is actionable, "you lack permission" is a role request.
 */
export function evaluateMembership(
    guilds: readonly DiscordUserGuild[],
    guildId: string,
): { member: boolean; canCreateEvents: boolean } {
    const guild = guilds.find((g) => g.id === guildId);
    if (!guild) return { member: false, canCreateEvents: false };
    return { member: true, canCreateEvents: guildGrantsEventCreation(guild) };
}
