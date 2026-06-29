# TMC Radio Bot

A Discord bot that streams your AzuraCast station into a voice channel, plus staff tools.

### Commands
| Command | What it does | Who can use it |
|---|---|---|
| `/play` | Joins **your** current voice channel and streams the radio | Anyone |
| `/stop` | Leaves the voice channel | Anyone |
| `/nowplaying` | Shows the current song (artist, art, listener count, live DJ) | Anyone |
| `/staff-dm` | DMs everyone in a role (or two) an announcement | **Manage Server** only |

`/staff-dm` example: pick `role: @staff`, `message: testing!`, optionally `also_role: @management` and a `title`. Each member gets a clean embed DM signed with who sent it. Members with DMs closed are skipped and counted in the result.

### Why the voice playback "just works"
The three things that normally break Discord audio are all bundled — no system setup:
- **ffmpeg** ships inside the bot (`ffmpeg-static`), so the host never needs it installed.
- **Opus** encoding is done by ffmpeg straight to Ogg/Opus, so there's no native opus module to compile.
- **Encryption** uses `@noble/ciphers` (pure JS, synchronous), which supports Discord's current voice modes with no async-init footguns.

The stream is also set to auto-reconnect, and the bot restarts the audio automatically if the source hiccups.

---

## 1. Create the bot
1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it (this is `DISCORD_TOKEN`).
3. Still on the **Bot** tab → enable **Server Members Intent** (required for `/staff-dm`). Leave the others off.
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions **View Channels, Send Messages, Embed Links, Connect, Speak**. Open the generated URL to invite it.

   Or use this directly (replace `CLIENT_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=3165184&scope=bot%20applications.commands
   ```

## 2. Deploy on Railway (alongside AzuraCast)
1. Push this folder to a GitHub repo.
2. Railway → your existing project → **New** → **GitHub Repo** → pick this repo. Railway auto-detects Node and runs `npm start` (no Dockerfile needed).
3. Add the **Variables** from `.env.example` (at minimum `DISCORD_TOKEN` and `TMCAST_STREAM_URL` — e.g. `https://cast.tmc.gg/listen/one/radio.mp3`). Set `GUILD_ID` to your server's ID so the commands show up instantly, and `TMCAST_NOWPLAYING_URL` (e.g. `https://cast.tmc.gg/api/np/one`) to enable `/nowplaying`.
4. Deploy. It runs as a worker — Railway keeps it alive 24/7 and it won't sleep.

This is tiny (~70 MB RAM, near-zero CPU when no one's in voice), so it fits comfortably inside the $5 plan you already pay for.

## Local dev
```bash
npm install
cp .env.example .env   # fill in DISCORD_TOKEN + AZURACAST_STREAM_URL
npm start
```

### Tips
- Want a permanent 24/7 radio presence? Set `AUTOPLAY_CHANNEL_ID` to a voice channel ID — the bot joins and plays on startup and after every redeploy.
- To find IDs: enable **Developer Mode** in Discord (Settings → Advanced), then right-click a server/channel → **Copy ID**.
- `/staff-dm` is gated to **Manage Server**. You can fine-tune who can run it per-server in **Server Settings → Integrations → TMC Radio Bot**.
