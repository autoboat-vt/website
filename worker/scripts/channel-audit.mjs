#!/usr/bin/env node

/**
 * channel-audit.mjs -- print the Discord channel tree with the audience each
 * channel resolves to, so `OFFICERS_CHANNEL_ID` can be set correctly.
 *
 * WHY THIS EXISTS
 * ---------------
 * `OFFICERS_CHANNEL_ID` is the one value that changes what the public calendar
 * exposes, and getting it wrong fails SILENTLY: the filter looks configured,
 * but officer events keep being published. Discord's UI shows channels but not
 * the audience mapping, and `/audiences` (the Worker's own diagnostic) is only
 * useful once the Worker is deployed with a correct id. This script closes that
 * loop locally.
 *
 * WARNING: Events are classified by CHANNEL, not by category. Every event voice
 * channel -- officer, subteam, and general member -- lives in one shared
 * category, so the category tells you nothing about visibility. The channel id
 * is the setting, and this script lists channel ids.
 *
 * It is READ-ONLY -- it issues one GET and never creates, edits, or deletes
 * anything.
 *
 * USAGE
 * -----
 *   cd worker
 *   npx wrangler login
 *   DISCORD_BOT_TOKEN=<token> node scripts/channel-audit.mjs
 *
 * The token is read from the environment (or from `worker/.dev.vars`, which is
 * gitignored). It is never written to disk, never logged, and never echoed in
 * output or errors. Prefer the env var over `.dev.vars` if the token would
 * otherwise persist on disk.
 *
 * Optional: `DISCORD_GUILD_ID=<id>` overrides the guild (defaults to
 * wrangler.jsonc's `DISCORD_GUILD_ID`).
 *
 * EXIT CODES
 * ----------
 *   0  success
 *   1  missing config / network / API failure
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wranglerPath = resolve(__dirname, "..", "wrangler.jsonc");
const devVarsPath = resolve(__dirname, "..", ".dev.vars");

const DISCORD_API = "https://discord.com/api/v10";
/** Discord's channel type for a category (channel group). */
const GUILD_CATEGORY = 4;

/** Channel types, for human-readable output. */
const CHANNEL_TYPE_NAMES = {
    0: "text",
    2: "voice",
    4: "category",
    5: "announcement",
    13: "stage",
    15: "forum",
};

/**
 * Read a value from wrangler.jsonc. Not a full JSONC parse -- it just matches
 * `"KEY": "value"` lines, which is all we need and avoids adding a dependency.
 */
function readWranglerVar(key) {
    try {
        const raw = readFileSync(wranglerPath, "utf8");
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
        return m?.[1] || undefined;
    } catch {
        return undefined;
    }
}

/** Read a KEY=value line from worker/.dev.vars (gitignored), if present. */
function readDevVars(key) {
    try {
        const raw = readFileSync(devVarsPath, "utf8");
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eq = trimmed.indexOf("=");
            if (eq === -1) continue;
            if (trimmed.slice(0, eq).trim() === key) {
                return trimmed
                    .slice(eq + 1)
                    .trim()
                    .replace(/^["']|["']$/g, "");
            }
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function fail(message) {
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
}

const token = process.env.DISCORD_BOT_TOKEN || readDevVars("DISCORD_BOT_TOKEN");
if (!token) {
    fail(
        "no bot token.\n" +
            "  Set DISCORD_BOT_TOKEN in the environment, or create worker/.dev.vars\n" +
            "  (gitignored) containing:\n" +
            "      DISCORD_BOT_TOKEN=<token>\n" +
            "  The token is read locally and never sent anywhere except discord.com.",
    );
}

const guildId = process.env.DISCORD_GUILD_ID || readWranglerVar("DISCORD_GUILD_ID");
if (!guildId) {
    fail("no guild id. Set DISCORD_GUILD_ID, or add DISCORD_GUILD_ID to wrangler.jsonc.");
}

const configuredOfficersId = process.env.OFFICERS_CHANNEL_ID || readWranglerVar("OFFICERS_CHANNEL_ID");

/**
 * GET a Discord REST path with the bot token and retry on 429.
 *
 * Discord throttles this endpoint aggressively, so a first-attempt 429 is
 * normal rather than an error. The response body is never included in error
 * text -- for an auth failure it can echo request context, and the token must
 * not leak.
 */
async function discordGet(path, attempt = 1) {
    const res = await fetch(`${DISCORD_API}${path}`, {
        headers: {
            Authorization: `Bot ${token}`,
            "User-Agent": "autoboat-website-worker/1.0 (channel-audit)",
            Accept: "application/json",
        },
    });

    if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
        if (attempt > 4) fail("rate limited by Discord and out of retries.");
        process.stderr.write(`rate limited; retrying in ${waitMs}ms...\n`);
        await new Promise((r) => setTimeout(r, waitMs));
        return discordGet(path, attempt + 1);
    }

    if (res.status === 401) {
        fail("Discord rejected the token (401). Check the token is current and is a BOT token.");
    }
    if (res.status === 403) {
        fail(
            "Discord returned 403. The bot is not in this guild, or lacks VIEW_CHANNEL.\n" +
                "  Re-invite it with the `bot` scope (see worker/README.md).",
        );
    }
    if (!res.ok) {
        fail(`Discord returned ${res.status} ${res.statusText}.`);
    }

    return res.json();
}

const channels = await discordGet(`/guilds/${guildId}/channels`);
if (!Array.isArray(channels)) {
    fail("Discord returned a non-array channel payload.");
}

// --- Report ---------------------------------------------------------------

const categories = channels.filter((c) => c.type === GUILD_CATEGORY);

/** Only voice and stage channels can host (non-external) scheduled events. */
const isEventChannel = (c) => c.type === 2 || c.type === 13;

// Group channels under their parent category, to show the structure.
const byCategory = new Map();
for (const c of channels) {
    if (c.type === GUILD_CATEGORY) continue;
    const key = c.parent_id ?? null;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(c);
}

const channelById = new Map(channels.map((c) => [c.id, c]));
const eventChannels = channels.filter(isEventChannel);
const voiceCount = eventChannels.length;

process.stdout.write(`\nDiscord channel audit\n`);
process.stdout.write(`  guild: ${guildId}\n`);
process.stdout.write(`  ${channels.length} channels in ${categories.length} categories`);
process.stdout.write(` (${voiceCount} voice/stage -- the ones that can host events)\n`);

const configuredChannel = configuredOfficersId ? channelById.get(configuredOfficersId) : undefined;
if (configuredOfficersId) {
    process.stdout.write(`  OFFICERS_CHANNEL_ID currently in config: ${configuredOfficersId}`);
    if (!configuredChannel) {
        process.stdout.write(" (NOT FOUND in this guild)\n");
    } else {
        const type = CHANNEL_TYPE_NAMES[configuredChannel.type] ?? `type${configuredChannel.type}`;
        process.stdout.write(` (${configuredChannel.name}, ${type})\n`);
    }
}
process.stdout.write("\n");

/** Sort so voice/stage channels come first -- those are the ones that matter. */
function byRelevance(a, b) {
    return Number(isEventChannel(b)) - Number(isEventChannel(a)) || a.name.localeCompare(b.name);
}

function printChannel(c, indent) {
    const type = CHANNEL_TYPE_NAMES[c.type] ?? `type${c.type}`;
    const configured = c.id === configuredOfficersId;
    const canHost = isEventChannel(c) ? " <-- can host events" : "";
    const marker = configured ? "   <-- currently configured as the OFFICER channel" : "";
    process.stdout.write(`${indent}${c.name}  [${type}]  ${c.id}${marker}${canHost}\n`);
}

// Categories that contain at least one voice channel first.
const catsWithVoice = categories
    .filter((cat) => (byCategory.get(cat.id) ?? []).some(isEventChannel))
    .sort((a, b) => a.name.localeCompare(b.name));

for (const cat of catsWithVoice) {
    const children = [...(byCategory.get(cat.id) ?? [])].sort(byRelevance);
    process.stdout.write(`${cat.name}\n`);
    process.stdout.write(`  [CATEGORY] ${cat.id}\n`);
    for (const c of children) printChannel(c, "  ");
    process.stdout.write("\n");
}

// Categories with no voice channel -- listed briefly; they cannot host events.
const catsWithoutVoice = categories.filter((c) => !catsWithVoice.includes(c));
if (catsWithoutVoice.length > 0) {
    process.stdout.write("Categories with no voice channel (cannot host scheduled events):\n");
    for (const cat of catsWithoutVoice.sort((a, b) => a.name.localeCompare(b.name))) {
        process.stdout.write(`  ${cat.name}  ${cat.id}\n`);
    }
    process.stdout.write("\n");
}

// Voice channels with no category. These ARE classifiable -- classification
// keys off the channel id, so a top-level channel can be officer-only just as
// well as a nested one.
const orphans = [...(byCategory.get(null) ?? [])].filter(isEventChannel).sort(byRelevance);
if (orphans.length > 0) {
    process.stdout.write("Top-level voice channels with NO category (classifiable by id):\n");
    for (const c of orphans) printChannel(c, "  ");
    process.stdout.write("\n");
}

process.stdout.write("Next steps:\n");
process.stdout.write("  1. Identify the VOICE channel that hosts officer events (above).\n");
process.stdout.write("  2. Set its id as OFFICERS_CHANNEL_ID in worker/wrangler.jsonc.\n");
process.stdout.write("     Every other channel is public -- no other configuration needed.\n");
process.stdout.write("  3. Deploy: npx wrangler deploy\n");
process.stdout.write("  4. Verify: curl https://<worker-url>/audiences\n");
process.stdout.write('     The officer channel must show "audience": "officer".\n\n');

if (configuredOfficersId && !configuredChannel) {
    process.stdout.write(
        `WARNING: the configured OFFICERS_CHANNEL_ID (${configuredOfficersId}) is not a channel\n` +
            "in this guild. The filter would fail OPEN (officer events public).\n\n",
    );
} else if (configuredChannel && !isEventChannel(configuredChannel)) {
    const type = CHANNEL_TYPE_NAMES[configuredChannel.type] ?? `type${configuredChannel.type}`;
    process.stdout.write(
        `WARNING: the configured OFFICERS_CHANNEL_ID points at a ${type} channel, which cannot\n` +
            "host a voice/stage event. No event will ever match it, so the filter would fail\n" +
            "OPEN (officer events public).\n\n",
    );
}
