# Discord Music Bot (Lavalink + yt-dlp)

Music bot for Discord running on a Raspberry Pi. This is the current version of the bot, rewritten around Lavalink after YouTube kept breaking the old play-dl approach. YouTube playback goes through yt-dlp (downloads audio locally, Lavalink plays the file) because the Lavalink YouTube plugin can't keep up with YouTube's cipher changes anymore.

## Stack

- Node.js 22 + discord.js 14
- Shoukaku 4.2 (Lavalink client)
- Lavalink 4.2.2 (grab the jar from their GitHub releases, not included here)
- yt-dlp nightly + deno (deno is needed for PO token solving, YouTube requires it now)

## Setup

```
npm install
cp .env.example .env     # put your bot token in here
```

The only required env var is `DISCORD_TOKEN`. Paths and the Lavalink connection are
overridable if your layout differs: `YTDLP_PATH`, `AUDIO_CACHE_DIR`, `COOKIES_PATH`,
`DENO_BIN_DIR`, `LAVALINK_URL`, `LAVALINK_PASSWORD`, `BOT_PREFIX`.

Drop `Lavalink.jar` into `lavalink/` next to `application.yml`, then start Lavalink first and the bot second. On the Pi both run under systemd, unit files are in `deploy/`. The bot unit waits for Lavalink's /version endpoint before starting so boot order sorts itself out.

Heads up: Lavalink takes 30-40 seconds to start on a Pi. Be patient before assuming its broken.

## Shoukaku patches (IMPORTANT)

Two patches have to be reapplied to `node_modules/shoukaku/dist/index.js` after every npm install, or the bot won't connect:

1. `clientReady` -> `ready` (discord.js v14 emits `ready`, shoukaku 4.2 listens for the wrong event)
2. Add `channelId` to the voice object in `sendServerUpdate()` (Lavalink 4.2.2 rejects the payload without it)

## Commands

| Command | What it does |
|---------|--------------|
| `.play <song/URL>` | Play music |
| `.playfrom <url> <start> <duration>` | Play from a timestamp |
| `.pause` / `.resume` | Pause and resume playback |
| `.skip` | Skip current song (works even with loop on) |
| `.stop` | Stop and clear the queue |
| `.queue` / `.q` | Show the queue |
| `.np` | Now playing, with position bar |
| `.volume <0-150>` / `.vol` | Set volume (100 = normal) |
| `.shuffle` | Shuffle the queue |
| `.remove <n>` / `.rm` | Remove song n from the queue |
| `.clear` | Clear queue, keeps current song playing |
| `.loop` | Loop current song |
| `.loopqueue` / `.lq` | Loop the whole queue |
| `.news <topic>` | Plays the newest news video on a topic |
| `.dc` | Disconnect |

## Notes

- If Lavalink stays down for 3 minutes the bot exits on purpose and systemd restarts the whole stack. Not a bug.
- `deploy/ytdlp-update.timer` updates yt-dlp weekly (Mondays 5am) so YouTube breakage fixes itself
- Downloaded audio is cached in `audio_cache/`, keeps the last 20 files (max 500 MB), cleans itself
- An optional `cookies.txt` (Firefox export, NOT Edge) lets it play age-restricted stuff. Don't commit it.
- If every video suddenly only returns storyboard formats, yt-dlp stable has rotted again. Move to nightly: `pip3 install --break-system-packages --upgrade --pre 'yt-dlp[default]'`

The old play-dl version of this bot is in the git history if anyone wants it.

## Credits

None of the heavy lifting here is mine — this bot is mostly glue around other people's excellent work:

- [Lavalink](https://github.com/lavalink-devs/Lavalink) — the audio server doing the actual streaming
- [Shoukaku](https://github.com/shipgirlproject/Shoukaku) by Deivu — the Lavalink client the bot talks through
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — carrying the entire "play YouTube audio in 2026" problem on its back
- [discord.js](https://discord.js.org) — the Discord API library
- [youtube-source](https://github.com/lavalink-devs/youtube-source) — Lavalink's YouTube plugin
- [Deno](https://deno.com) — the JS runtime yt-dlp uses to solve YouTube's PO token challenges

Earlier versions were built on [@distube/ytdl-core](https://github.com/distubejs/ytdl-core) and play-dl, which served well until YouTube's 2026 cipher changes forced the move to yt-dlp.

Honesty note: a good chunk of this — the yt-dlp migration, the reliability work, and the debugging every time YouTube broke something — was pair-programmed with [Claude](https://claude.com) (Anthropic's AI). Every fix in here that looks suspiciously well-commented, that's why.
