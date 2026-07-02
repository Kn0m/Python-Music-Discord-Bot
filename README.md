# Discord Music Bot (Lavalink + yt-dlp)

Music bot for Discord running on a Raspberry Pi. This is the current version of the bot, rewritten around Lavalink after YouTube kept breaking the old play-dl approach. YouTube playback goes through yt-dlp (downloads audio locally, Lavalink plays the file) because the Lavalink YouTube plugin can't keep up with YouTube's cipher changes anymore.

## Stack

- Node.js 18 + discord.js 14
- Shoukaku 4.2 (Lavalink client)
- Lavalink 4.2.2 (grab the jar from their GitHub releases, not included here)
- yt-dlp nightly + deno (deno is needed for PO token solving, YouTube requires it now)

## Setup

```
npm install
cp .env.example .env     # put your bot token in here
```

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
| `.skip` | Skip current song |
| `.stop` | Stop and clear the queue |
| `.queue` / `.q` | Show the queue |
| `.clear` | Clear queue, keeps current song playing |
| `.loop` | Loop current song |
| `.loopqueue` / `.lq` | Loop the whole queue |
| `.news <topic>` | Plays the newest news video on a topic |
| `.dc` | Disconnect |

## Notes

- Downloaded audio is cached in `audio_cache/`, keeps the last 20 files, cleans itself
- An optional `cookies.txt` (Firefox export, NOT Edge) lets it play age-restricted stuff. Don't commit it.
- If every video suddenly only returns storyboard formats, yt-dlp stable has rotted again. Move to nightly: `pip3 install --break-system-packages --upgrade --pre 'yt-dlp[default]'`

The old play-dl version of this bot is in the git history if anyone wants it.
