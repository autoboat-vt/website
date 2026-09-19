# autoboat-discord-events Worker

Cloudflare Worker that proxies Discord's guild scheduled-events REST API for the
AutoBoat website calendar. The website is a fully static S3 site, so the bot
token cannot live in its bundle -- this Worker holds it server-side and serves
a normalized JSON list of events from a KV cache.

```
website (browser)
    |  GET https://<worker>.workers.dev/events
    v
Cloudflare Worker (this repo, `worker/`)
    |  KV get "events" (5 min TTL)
    |  miss -> GET https://discord.com/api/v10/guilds/<guild_id>/scheduled-events?with_user_count=true
    |           Authorization: Bot ${DISCORD_BOT_TOKEN}
    v
Discord API
```

## One-time setup

1. **Create the Discord application + bot.**

   - https://discord.com/developers/applications -> New Application. Name it
     something like "AutoBoat Website".
   - Left sidebar -> **Bot** -> **Reset Token**. Save the token somewhere
     private (a password manager). Do NOT commit it anywhere.
   - All **Privileged Gateway Intents** stay OFF -- this Worker uses REST only.

2. **Invite the bot to the team server.**

   - Left sidebar -> **OAuth2** -> **URL Generator**.
   - Scopes: check `bot`.
   - Bot Permissions: only **View Channels**. (Reading scheduled events
     requires `VIEW_CHANNEL`; no other permission is needed.)
   - Open the generated URL in a browser and pick the team server. You need
     the **Manage Server** permission in that server to complete the invite.

3. **Get the guild (server) ID.**

   - Discord client -> User Settings -> Advanced -> enable **Developer Mode**.
   - Back in the app, right-click the server in the left sidebar -> **Copy
     Server ID**.
   - Paste it into `wrangler.jsonc` under `vars.DISCORD_GUILD_ID` (this is
     public config, NOT a secret -- anyone in the server can see it).

4. **Create the KV namespace.**

   In this directory:

   ```bash
   bun install     # or npm install
   npx wrangler login
   npx wrangler kv namespace create EVENTS_KV
   npx wrangler kv namespace create EVENTS_KV --preview

   ```

   Copy the two `id` values from the output into `wrangler.jsonc`, replacing
   the `REPLACE_ME_KV_ID` / `REPLACE_ME_KV_PREVIEW_ID` placeholders.

5. **Store the bot token as a secret.**

   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   # paste the bot token when prompted -- it is stored encrypted on Cloudflare
   ```

   For local dev (`wrangler dev`), also create a `.dev.vars` file in this
   directory (it is gitignored):

   ```
   DISCORD_BOT_TOKEN=<your-token-here>
   ```

## Local development

```bash
bun install
npx wrangler dev          # starts on http://localhost:8787
curl http://localhost:8787/events | jq .
```

For the website to hit the local Worker, start it with
`VITE_EVENTS_URL=http://localhost:8787 bun run dev` from the website root.

## Deploy

```bash
npx wrangler deploy       # from worker/
```

The output line ends with the production URL, e.g.
`https://autoboat-discord-events.<your-account>.workers.dev`. Paste that into
[src/lib/discord.ts](../src/lib/discord.ts) as the `EVENTS_URL` fallback.

## Configuration reference

Set via `vars` in `wrangler.jsonc` (public, non-secret):

- `DISCORD_GUILD_ID` — Discord server ID.
- `ALLOWED_ORIGIN` — the only browser origin allowed to call this Worker.
  Default: `https://autoboat.aoe.vt.edu`. Do NOT set to `*` in production.
- `CACHE_TTL_SECONDS` — KV TTL for the cached events payload. Default 300.

Set via `wrangler secret put` (secret, never committed):

- `DISCORD_BOT_TOKEN` — the Discord bot's token.

## Behavior notes

- Only `GET /events` and `OPTIONS /events` are handled; everything else 404s.
- Discord upstream failures produce a generic `502` with the CORS headers
  intact. The bot token is never included in responses, logs, or error bodies.
- KV writes are fire-and-forget via `ctx.waitUntil` so the response isn't
  blocked on the write.
- The KV read uses `cacheTtl` equal to the KV entry TTL -- this keeps KV
  reads served from the Cloudflare edge cache between entries expiring
  from KV itself.

## Why not Discord webhooks?

There is no way to *pull* guild events with an incoming webhook -- channel
webhooks are POST-only. Discord's "outgoing" Webhook Events (push events to
your app over HTTP) do not include guild scheduled-event types in their event
list. Scheduled-event create/update/delete events only exist on the Gateway
(a persistent bot WebSocket connection), which needs an always-on process.
This Worker + KV approach is the smallest server-side surface that works for
a read-only calendar.
