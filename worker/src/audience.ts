/**
 * Audience classification for scheduled events.
 *
 * The team gates who can see a scheduled event by putting it in a Discord
 * voice channel whose own permissions do the gating: each subteam has a voice
 * channel only its members can see, and there is a separate channel for
 * officers. Voice events must have `entity_metadata: null` (Discord requires
 * it), so `channel_id` is the ONLY usable signal -- there is no `location`
 * text to key off.
 *
 * **The signal is the CHANNEL, not its category.** Every event voice
 * channel -- officer, subteam, and general member alike -- lives under ONE
 * shared category, so the category is identical for every event and
 * discriminates nothing. An earlier version of this module classified by
 * parent category, which under that layout gives the same answer for every
 * event: useless as a signal, and actively harmful when set, since it would
 * hide every subteam and member event while still leaking the officer ones.
 *
 *     event.channel_id === OFFICERS_CHANNEL_ID ? "officer" : "public"
 *
 * Classifying by channel id is also the more faithful model: `VIEW_CHANNEL` is
 * granted per channel, and it is what actually restricts the event inside
 * Discord.
 *
 * There is no second list of "officer events" to keep in sync, and an officer
 * event needs no extra marker: schedule it in the officer channel and it is
 * internal by construction. Exactly one officer channel is expected; everything
 * else is public, per the team's stated policy.
 *
 * The bot must be able to see every channel it classifies. `VIEW_CHANNEL`
 * for the bot is what makes the fetch work at all, and the bot having extra
 * visibility is safe *because* this module exists -- without it the bot's
 * `GET /guilds/{id}/scheduled-events` returns officer events and the Worker
 * publishes them.
 *
 * Deliberately pure -- no bindings, no `fetch`, no KV -- so classification is
 * unit-testable without Cloudflare's ambient types.
 */

import type { CalendarEvent } from "./events";

/** Who may see an event. */
export type Audience = "public" | "officer";

/** Discord's channel type for a category (channel group). */
const GUILD_CATEGORY = 4;

/** The subset of Discord's channel object this module reads. */
export interface DiscordChannel {
    id: string;
    name: string;
    type: number;
    /** Parent category id, or null for top-level channels and categories. */
    parent_id?: string | null;
}

/**
 * Voice channel whose events are officer-only. **This is the whole signal.**
 *
 * Exactly one officer channel is expected, and every event NOT in it is public
 * -- that is the team's stated policy: "all subteam events and general member
 * events to be public, just the officer events need to be hidden". So an event
 * is officer-only iff its `channel_id` equals this id.
 *
 * WARNING: Why the CHANNEL and not its category: every event voice channel --
 * officer, subteam, and general member alike -- lives under ONE shared
 * category. The category is therefore identical for every event and
 * discriminates nothing. Classifying by channel is also the more faithful
 * model, since `VIEW_CHANNEL` is granted per channel and is what actually
 * restricts the event inside Discord.
 *
 * WARNING: Because there is exactly one id and no category rule, the channel LIST is
 * never consulted: classification is pure string comparison. Two consequences
 * worth knowing -- a Discord hiccup on `GET /guilds/{id}/channels` cannot
 * degrade the filter (an earlier category-based design leaked officer events in
 * that case), and a SECOND officer channel would be public until its id is
 * added here.
 *
 * The env var `OFFICERS_CHANNEL_ID` overrides this.
 */
export const DEFAULT_OFFICERS_CHANNEL_ID = "1550594891766308997";

/**
 * Categories whose events are intended to be public. Purely documentary: with
 * the fail-open policy below, any other channel is public too. Used only by the
 * `/audiences` diagnostics route so the real mapping can be eyeballed.
 *
 * WARNING: Category-level, so with every event channel sharing one category this
 * list cannot distinguish an officer event from a public one. It is
 * documentation, not a filter -- the officer channel id is the filter.
 */
export const DEFAULT_PUBLIC_CATEGORY_IDS: readonly string[] = [
    "1017960607317569546",
    "1017961755422023750",
    "1521086208877723708",
    "1170066058371997756",
    "1496252157961531502",
];

/** Resolved audience config, derived from the Worker's environment. */
export interface AudienceConfig {
    /**
     * The officer-only voice channel id, or null when unconfigured. null means
     * the filter cannot work, so the public route must serve nothing rather
     * than risk a leak. Check `audienceIsConfigured` rather than comparing to
     * a sentinel string.
     */
    officersChannelId: string | null;
    /** Documented public categories (diagnostics only). */
    publicCategoryIds: string[];
}

/** The env fields this module reads. Kept minimal so tests can pass literals. */
export interface AudienceEnv {
    OFFICERS_CHANNEL_ID?: string | undefined;
    PUBLIC_CATEGORY_IDS?: string | undefined;
}

/**
 * Split a comma- or whitespace-separated id list. Tolerates the trailing comma
 * people habitually leave in a JSONC array and stray indentation.
 */
export function parseChannelIds(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

export function audienceConfigFromEnv(env: AudienceEnv): AudienceConfig {
    // An ABSENT var uses the committed default; a var that is PRESENT but blank
    // means "no officer channel", which is how an operator deliberately turns
    // the filter off. The two must not be conflated: falling back to the
    // default after an operator cleared it would re-hide events they had just
    // published.
    const officers =
        env.OFFICERS_CHANNEL_ID === undefined
            ? [DEFAULT_OFFICERS_CHANNEL_ID]
            : parseChannelIds(env.OFFICERS_CHANNEL_ID);
    const publicOverride = parseChannelIds(env.PUBLIC_CATEGORY_IDS);
    return {
        // The first id wins. More than one is a config mistake: there is one
        // officer channel, and silently honouring a list would hide events in
        // channels nobody meant to hide.
        officersChannelId: officers[0] ?? null,
        publicCategoryIds: publicOverride.length > 0 ? publicOverride : [...DEFAULT_PUBLIC_CATEGORY_IDS],
    };
}

/**
 * Whether the audience filter can actually work.
 *
 * WARNING: When this is false the Worker is in a configuration-error state: it cannot
 * tell officer events from public ones, so it must NOT serve a public calendar.
 * See `eventsForRoute` in index.ts -- it returns an empty public feed and the
 * routes report `X-Audience-Configured: false`.
 */
export function audienceIsConfigured(config: AudienceConfig): boolean {
    return config.officersChannelId !== null && config.officersChannelId.length > 0;
}

/**
 * Classify an event as officer-only iff it was scheduled in the officer
 * channel.
 *
 * **Fail-open by design.** Everything else -- including a channel missing from
 * the payload, or no channel at all -- is public. This is the policy the team
 * asked for: "all subteam events and general member events to be public, just
 * the officer events need to be hidden".
 *
 * The trade-off is deliberate: a SECOND officer channel would be public until
 * its id replaced this one. The opposite policy would require registering every
 * public channel, and a missing registration would silently erase real events
 * from the site -- the more likely day-to-day failure.
 *
 * Note this per-event fail-open rule is only reached once the config is valid.
 * An entirely unconfigured filter is a separate, stricter case handled by
 * `audienceIsConfigured` in the route layer -- it cannot fail open, because
 * "no officer channel" would classify everything public.
 *
 * `channels` is accepted and ignored: nothing here needs the channel list, and
 * keeping the parameter means callers and tests do not have to change.
 */
export function audienceForChannel(
    channelId: string | null,
    config: AudienceConfig,
    _channels: DiscordChannel[],
): Audience {
    if (!channelId) return "public";
    // A plain equality check -- this is what VIEW_CHANNEL gates.
    return channelId === config.officersChannelId ? "officer" : "public";
}

/** True when the event's channel is the officer channel. */
export function isOfficerEvent(
    event: Pick<CalendarEvent, "channelId">,
    config: AudienceConfig,
    channels: DiscordChannel[],
): boolean {
    return audienceForChannel(event.channelId, config, channels) === "officer";
}

/**
 * Non-category channels as `{ id, name, categoryId }`, for the diagnostics
 * route -- so an operator can read off a channel id to configure.
 */
export function listChannels(channels: DiscordChannel[]): { id: string; name: string; categoryId: string | null }[] {
    return channels
        .filter((c) => c.type !== GUILD_CATEGORY)
        .map((c) => ({ id: c.id, name: c.name, categoryId: c.parent_id ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Channels that are categories, as `{ id, name }`, for the diagnostics route. */
export function listCategories(channels: DiscordChannel[]): { id: string; name: string }[] {
    return channels
        .filter((c) => c.type === GUILD_CATEGORY)
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export { GUILD_CATEGORY };
