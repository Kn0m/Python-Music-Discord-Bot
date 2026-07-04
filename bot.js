const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Shoukaku, Connectors, Constants } = require('shoukaku');
const { State } = Constants;
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

// Bot configuration
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
    console.error('[fatal] DISCORD_TOKEN not set in environment. Aborting.');
    process.exit(1);
}
// Paths and connection settings are overridable via .env so the bot isn't
// welded to one machine's layout.
const PREFIX = process.env.BOT_PREFIX || '.';
const YTDLP_PATH = process.env.YTDLP_PATH || '/home/m0nk/.local/bin/yt-dlp';
const AUDIO_CACHE = process.env.AUDIO_CACHE_DIR || '/home/m0nk/Discord-Music-Bot/audio_cache';
const COOKIES_PATH = process.env.COOKIES_PATH || '/home/m0nk/Discord-Music-Bot/cookies.txt';
const DENO_BIN_DIR = process.env.DENO_BIN_DIR || '/home/m0nk/.deno/bin';

// Timeouts and intervals (named constants)
const YTDLP_META_TIMEOUT_MS = 30000;
const YTDLP_DL_TIMEOUT_MS = 60000;
const IDLE_TIMEOUT = 60000;
const CACHE_CLEAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX_FILES = 20;
const CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB - count cap alone doesn't bound disk use
// If Lavalink is down this long, exit and let systemd restart the whole stack
// (musicbot.service Requires=lavalink.service, so the restart revives both).
const LAVALINK_DEAD_EXIT_MS = 3 * 60 * 1000;

// yt-dlp client fallback list - order matters (first to succeed wins).
// Includes default (android_vr, web_safari), then a curated set of known-good fallbacks.
// Even if none of these rescue COPPA "Made for Kids" content, they meaningfully improve
// resilience to YouTube's regular client-rotation breakage.
const YTDLP_PLAYER_CLIENTS = 'default,tv,mweb,web_embedded';

// Lavalink configuration
const LavalinkConfig = [
    {
        name: 'Lavalink',
        url: process.env.LAVALINK_URL || '127.0.0.1:2333',
        auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
        secure: false
    }
];

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Initialize Shoukaku
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), LavalinkConfig, {
    moveOnDisconnect: false,
    resumeByLibrary: false,
    resumeTimeout: 30,
    reconnectTries: 5,
    restTimeout: 10000
});

// Queue storage
const queues = new Map();
const disconnectTimeouts = new Map();

// Per-guild command serialization. Two near-simultaneous .play commands used to both
// see playing=false and the second track silently replaced (lost) the first. The lock
// makes queue mutations run one at a time per guild; yt-dlp resolution stays parallel.
const guildLocks = new Map();
function withGuildLock(guildId, fn) {
    const prev = guildLocks.get(guildId) || Promise.resolve();
    const run = prev.then(fn, fn);
    guildLocks.set(guildId, run.then(() => {}, () => {}));
    return run;
}

// In-flight yt-dlp downloads, keyed by safeTitle (video id), to dedupe simultaneous .play
// requests for the same URL. Each value is a Promise that resolves to the same result the
// caller would have produced.
const inflightDownloads = new Map();

// Timestamped logger so journalctl entries are correlatable.
function ts() { return new Date().toISOString(); }
function logInfo(msg) { console.log('[' + ts() + '] [info] ' + msg); }
function logWarn(msg) { console.warn('[' + ts() + '] [warn] ' + msg); }
function logError(msg) { console.error('[' + ts() + '] [error] ' + msg); }

// Top-level safety nets - log everything; never silently swallow.
process.on('unhandledRejection', (reason, p) => {
    logError('unhandledRejection: ' + (reason && reason.stack ? reason.stack : reason));
});
process.on('uncaughtException', (err) => {
    logError('uncaughtException: ' + (err && err.stack ? err.stack : err));
    // Best-effort graceful shutdown - the process will exit anyway after this handler;
    // try to leave voice channels cleanly so Discord doesn't see ghost users.
    try {
        for (const [guildId, queue] of queues) {
            try {
                if (queue.player) queue.player.stopTrack();
                shoukaku.leaveVoiceChannel(guildId);
            } catch (_) {}
        }
    } catch (_) {}
    setTimeout(() => process.exit(1), 250);
});

// Graceful shutdown on SIGTERM/SIGINT (systemd will deliver SIGTERM on stop/restart).
function gracefulShutdown(signal) {
    logInfo('Received ' + signal + ', shutting down gracefully');
    try {
        for (const [guildId, queue] of queues) {
            try {
                if (queue.player) queue.player.stopTrack();
                shoukaku.leaveVoiceChannel(guildId);
            } catch (_) {}
        }
    } catch (_) {}
    if (cacheCleanInterval) clearInterval(cacheCleanInterval);
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Build env with deno on PATH for PO token solving.
function ytdlpEnv() {
    return Object.assign({}, process.env, { PATH: DENO_BIN_DIR + ':' + (process.env.PATH || '') });
}

// Optional cookies arg pair -- only included if cookies.txt exists. Lets the bot play
// age-gated / Premium-only / sign-in-required content without changing behavior when
// cookies are absent.
function cookieArgs() {
    try {
        if (fs.statSync(COOKIES_PATH).isFile()) return ['--cookies', COOKIES_PATH];
    } catch (_) {}
    return [];
}

// Run yt-dlp with execFile (non-blocking). Returns { ok, stdout, stderr } -- never throws.
// On failure, stderr is preserved (first line) so callers can surface a meaningful reason.
async function runYtDlp(args, timeoutMs) {
    try {
        const { stdout, stderr } = await execFileAsync(YTDLP_PATH, args, {
            timeout: timeoutMs,
            encoding: 'utf-8',
            env: ytdlpEnv(),
            // 50 MB stdout cap is plenty for JSON metadata and well above any realistic output
            maxBuffer: 50 * 1024 * 1024
        });
        if (stderr && stderr.trim()) logWarn('yt-dlp stderr: ' + stderr.trim().split('\n').slice(0, 3).join(' | '));
        return { ok: true, stdout: stdout, stderr: stderr };
    } catch (err) {
        // execFileAsync attaches stdout/stderr to the error object on non-zero exit
        const stderr = (err && err.stderr) ? String(err.stderr) : '';
        const stdout = (err && err.stdout) ? String(err.stdout) : '';
        const reason = stderr.trim().split('\n').filter(l => l.startsWith('ERROR:') || l.startsWith('WARNING:'))[0]
                    || stderr.trim().split('\n').slice(-1)[0]
                    || (err && err.message)
                    || 'unknown yt-dlp failure';
        logError('yt-dlp failed: ' + reason);
        return { ok: false, stdout: stdout, stderr: stderr, reason: reason };
    }
}

// Best-effort cleanup of leftover yt-dlp partials/postproc remnants for a given id.
function cleanupPartials(safeTitle) {
    try {
        const entries = fs.readdirSync(AUDIO_CACHE);
        for (const f of entries) {
            if (!f.startsWith(safeTitle + '.')) continue;
            // Keep .opus (the success artifact); sweep everything else (.webm, .m4a, .part, .ytdl).
            if (f.endsWith('.opus')) continue;
            try { fs.unlinkSync(path.join(AUDIO_CACHE, f)); } catch (_) {}
        }
    } catch (_) {}
}

// Resolve a query (URL or search) via yt-dlp. Returns:
//   { ok: true, title, uri, length, thumbnail, localFile, author }
//   { ok: false, reason }
// Two near-simultaneous calls for the same video id share one in-flight download via
// inflightDownloads map (deduplication).
async function resolveYtDlp(query) {
    // Accept full URLs and yt-dlp search prefixes (ytsearch:, ytsearchdate:, ytsearchdateN:) as-is.
    const isPrefixed = /^ytsearch(date)?\d*:/i.test(query);
    const searchQuery = (query.includes('http') || isPrefixed) ? query : 'ytsearch:' + query;

    // For multi-result queries (YouTube search-results pages used by .news), take only the
    // first hit. Filtering by duration/is_live would require fetching multiple results, which
    // routinely exceeds the 30s metadata timeout. If the first hit happens to be a livestream
    // replay, the download step's 60s timeout aborts it and the user can retry.
    const isSearchListing = /youtube\.com\/results\?/i.test(searchQuery);
    const listingArgs = isSearchListing ? ['--playlist-end', '1'] : [];

    // Step 1: metadata fetch with -j (single JSON line on stdout).
    const metaArgs = [
        '--js-runtimes', 'deno',
        '--remote-components', 'ejs:github',
        ...cookieArgs(),
        '--extractor-args', 'youtube:player_client=' + YTDLP_PLAYER_CLIENTS,
        '-f', 'bestaudio',
        '--no-warnings', '--no-playlist', '-j',
        ...listingArgs,
        searchQuery
    ];
    const metaRes = await runYtDlp(metaArgs, YTDLP_META_TIMEOUT_MS);
    if (!metaRes.ok) {
        return { ok: false, reason: metaRes.reason };
    }

    let info;
    try {
        // For ytsearch: the first match is on stdout; -j outputs one JSON object per line
        const firstLine = metaRes.stdout.split('\n').find(l => l.trim().startsWith('{'));
        if (!firstLine) return { ok: false, reason: 'yt-dlp returned no JSON metadata' };
        info = JSON.parse(firstLine);
    } catch (e) {
        return { ok: false, reason: 'failed to parse yt-dlp metadata: ' + e.message };
    }

    const safeTitle = (info.id || 'audio').replace(/[^a-zA-Z0-9_-]/g, '_');
    const finalPath = path.join(AUDIO_CACHE, safeTitle + '.opus');

    // Build the result that all callers will share.
    const buildResult = (localFile) => ({
        ok: true,
        title: info.title || 'Unknown',
        uri: info.webpage_url || query,
        length: (info.duration || 0) * 1000,
        thumbnail: info.thumbnail || 'https://i.imgur.com/qFIXWtN.png',
        localFile: localFile,
        author: info.uploader || 'Unknown',
        videoId: safeTitle
    });

    // Fast-path: file already cached and non-empty -- skip download entirely.
    try {
        const st = fs.statSync(finalPath);
        if (st.isFile() && st.size > 1024) {
            logInfo('Cache hit: ' + finalPath);
            return buildResult(finalPath);
        }
    } catch (_) { /* not cached, fall through */ }

    // Step 2: deduplicate simultaneous downloads of the same id.
    if (inflightDownloads.has(safeTitle)) {
        logInfo('Joining in-flight download for ' + safeTitle);
        try {
            return await inflightDownloads.get(safeTitle);
        } catch (e) {
            // Fall through and try our own download attempt
        }
    }

    const downloadPromise = (async () => {
        // Download to a temp filename, then rename atomically into place. This prevents
        // two concurrent downloads from racing on the same final path.
        const tempBase = safeTitle + '.tmp-' + process.pid + '-' + Date.now();
        const tempOutputPattern = path.join(AUDIO_CACHE, tempBase + '.%(ext)s');
        // For search-URL queries we already picked a specific video id during meta-fetch,
        // so download by id directly. This avoids re-running the search (and re-paying its
        // race risk of yt-dlp picking a different first result on the second call).
        const dlTarget = isSearchListing && info.id
            ? 'https://www.youtube.com/watch?v=' + info.id
            : searchQuery;
        const dlArgs = [
            '--js-runtimes', 'deno',
            '--remote-components', 'ejs:github',
            ...cookieArgs(),
            '--extractor-args', 'youtube:player_client=' + YTDLP_PLAYER_CLIENTS,
            '-f', 'bestaudio', '-x', '--audio-format', 'opus',
            '--no-warnings', '--no-playlist',
            '-o', tempOutputPattern,
            dlTarget
        ];
        const dlRes = await runYtDlp(dlArgs, YTDLP_DL_TIMEOUT_MS);
        if (!dlRes.ok) {
            cleanupPartials(tempBase); // sweep any partial .webm/.part
            return { ok: false, reason: dlRes.reason };
        }

        // Find the produced file (should be tempBase.opus).
        let producedFile = null;
        try {
            const candidates = fs.readdirSync(AUDIO_CACHE).filter(f => f.startsWith(tempBase + '.'));
            const opusFile = candidates.find(f => f.endsWith('.opus'));
            if (opusFile) producedFile = path.join(AUDIO_CACHE, opusFile);
        } catch (_) {}

        if (!producedFile) {
            cleanupPartials(tempBase);
            return { ok: false, reason: 'yt-dlp succeeded but produced no .opus file' };
        }

        // Rename into the final canonical path. If another concurrent download already won,
        // unlink ours and use theirs.
        try {
            if (fs.existsSync(finalPath)) {
                try { fs.unlinkSync(producedFile); } catch (_) {}
            } else {
                fs.renameSync(producedFile, finalPath);
            }
        } catch (e) {
            logError('rename to final path failed: ' + e.message);
            cleanupPartials(tempBase);
            return { ok: false, reason: 'failed to finalize cached file: ' + e.message };
        }

        // Sweep any leftover non-opus remnants (postproc partials).
        cleanupPartials(tempBase);

        return buildResult(finalPath);
    })();

    inflightDownloads.set(safeTitle, downloadPromise);
    try {
        return await downloadPromise;
    } finally {
        inflightDownloads.delete(safeTitle);
    }
}

// Set of audio_cache paths the bot is currently using. Excluded from cleanAudioCache.
const inUseFiles = new Set();
function markInUse(p) { if (p) inUseFiles.add(p); }
function markFree(p) { if (p) inUseFiles.delete(p); }

// Free every file a session was holding. Must be called on ALL session-teardown paths
// (.stop, .dc, idle disconnect) or the current song's file stays in inUseFiles forever
// and becomes permanently exempt from cache cleanup.
function releaseQueueFiles(queue) {
    if (!queue) return;
    if (queue.currentSong) markFree(queue.currentSong.localFile);
    for (const s of queue.songs) markFree(s.localFile);
}

// Clean up old cached audio files (keep last 20 by mtime), excluding currently-playing files
// and queued upcoming files. Also sweeps stray .webm/.part/.tmp-* postproc remnants regardless
// of count (those are always junk).
function cleanAudioCache() {
    try {
        const entries = fs.readdirSync(AUDIO_CACHE);
        // Sweep junk (non-opus, non-mp3) artifacts left behind by failed yt-dlp postproc.
        for (const f of entries) {
            if (f.endsWith('.opus') || f.endsWith('.mp3')) continue;
            // .webm, .m4a, .part, .ytdl, .tmp-*.opus etc. are all junk if they're not in-use.
            const full = path.join(AUDIO_CACHE, f);
            if (inUseFiles.has(full)) continue;
            try { fs.unlinkSync(full); } catch (_) {}
        }

        // Build the queued/playing exclusion set from current state.
        const protectedSet = new Set(inUseFiles);
        for (const queue of queues.values()) {
            if (queue.currentSong && queue.currentSong.localFile) protectedSet.add(queue.currentSong.localFile);
            for (const s of queue.songs) {
                if (s.localFile) protectedSet.add(s.localFile);
            }
        }

        const remaining = fs.readdirSync(AUDIO_CACHE)
            .map(f => {
                const full = path.join(AUDIO_CACHE, f);
                const st = fs.statSync(full);
                return { name: f, full: full, time: st.mtimeMs, size: st.size };
            })
            .filter(o => !protectedSet.has(o.full))
            .sort((a, b) => b.time - a.time);

        // Keep the newest unprotected files up to both the count cap and the byte cap;
        // delete the rest. Count alone doesn't bound disk use (20 DJ sets is gigabytes).
        let kept = 0;
        let keptBytes = 0;
        for (const f of remaining) {
            const size = f.size || 0;
            if (kept < CACHE_MAX_FILES && keptBytes + size <= CACHE_MAX_BYTES) {
                kept++;
                keptBytes += size;
            } else {
                try { fs.unlinkSync(f.full); } catch (_) {}
            }
        }
    } catch (e) {
        logWarn('cleanAudioCache error: ' + e.message);
    }
}

// Periodic cleanup, even if no track has finished recently.
let cacheCleanInterval = null;
function startCacheCleanInterval() {
    if (cacheCleanInterval) clearInterval(cacheCleanInterval);
    cacheCleanInterval = setInterval(() => {
        logInfo('Periodic cache clean tick');
        cleanAudioCache();
    }, CACHE_CLEAN_INTERVAL_MS);
}

// Helper functions
function createQueue(guildId) {
    return {
        songs: [],
        player: null,
        textChannel: null,
        voiceChannel: null,
        loop: false,
        loopQueue: false,
        playing: false,
        paused: false,
        skipNext: false,
        currentSong: null
    };
}

// Attach the full set of player event handlers exactly once per player. The .play and
// .playfrom handlers used to wire these inline with copy-pasted (and drifted) versions --
// the .playfrom copy was missing the 'stuck' handler entirely.
function attachPlayerEvents(guildId, queue) {
    queue.player.on('start', () => {
        logInfo('Track started');
    });

    queue.player.on('end', async (data) => {
        const reason = data && data.reason;
        logInfo('Track ended' + (reason ? ' (reason: ' + reason + ')' : ''));
        if (reason === 'replaced') return;
        try { await playNext(guildId); } catch (e) { logError('playNext error: ' + e); }
    });

    queue.player.on('exception', (data) => {
        logError('Track exception: ' + JSON.stringify(data));
        queue.textChannel.send('❌ An error occurred while playing!').catch(() => {});
        playNext(guildId).catch(e => logError('playNext error: ' + e));
    });

    queue.player.on('stuck', (data) => {
        logError('Track stuck: ' + JSON.stringify(data));
        queue.textChannel.send('❌ Track stuck, skipping...').catch(() => {});
        playNext(guildId).catch(e => logError('playNext error: ' + e));
    });
}

function buildNowPlayingEmbed(song) {
    if (song.startTime) {
        return new EmbedBuilder()
            .setTitle('🎵 Now Playing')
            .setDescription('**[' + song.title + '](' + song.uri + ')**\n' +
                '`' + formatTime(song.duration) + '` from `' + formatTime(song.startTime) + '` · requested by ' + song.requestedBy)
            .setThumbnail(song.thumbnail)
            .setColor('#FF0000')
            .setFooter({ text: 'Powered by Lavalink + yt-dlp' })
            .setTimestamp();
    }
    return createSongEmbed(song, '🎵 Now Playing');
}

function createSongEmbed(song, title) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription('**[' + song.title + '](' + song.uri + ')**\n' +
            '`' + formatTime(song.length) + '` · requested by ' + song.requestedBy)
        .setThumbnail(song.thumbnail)
        .setColor('#FF0000')
        .setFooter({ text: 'Powered by Lavalink + yt-dlp' })
        .setTimestamp();
}

function formatTime(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));

    if (hours > 0) {
        return hours + ':' + minutes.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
    }
    return minutes + ':' + seconds.toString().padStart(2, '0');
}

function parseTimeString(timeStr) {
    const parts = timeStr.split(':').map(Number).reverse();
    let seconds = 0;
    if (parts[0]) seconds += parts[0];
    if (parts[1]) seconds += parts[1] * 60;
    if (parts[2]) seconds += parts[2] * 3600;
    return seconds * 1000;
}

function scheduleDisconnect(guildId) {
    const existing = disconnectTimeouts.get(guildId);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(async () => {
        const queue = queues.get(guildId);
        if (!queue || !queue.player) return;

        try {
            if (queue.textChannel) {
                await queue.textChannel.send('👋 Disconnected due to inactivity');
            }
            releaseQueueFiles(queue);
            if (queue.player) queue.player.stopTrack();
            shoukaku.leaveVoiceChannel(guildId);

            const guild = queue.player.connection?.guildId;
            if (guild) {
                const discordGuild = client.guilds.cache.get(guild);
                if (discordGuild?.members?.me?.voice?.channel) {
                    await discordGuild.members.me.voice.disconnect();
                }
            }

            queues.delete(guildId);
            disconnectTimeouts.delete(guildId);
            logInfo('Auto-disconnected from guild ' + guildId);
        } catch (error) {
            logError('Error during auto-disconnect: ' + (error && error.stack ? error.stack : error));
            releaseQueueFiles(queue);
            queues.delete(guildId);
            disconnectTimeouts.delete(guildId);
        }
    }, IDLE_TIMEOUT);

    disconnectTimeouts.set(guildId, timeout);
}

function cancelDisconnect(guildId) {
    const timeout = disconnectTimeouts.get(guildId);
    if (timeout) {
        clearTimeout(timeout);
        disconnectTimeouts.delete(guildId);
    }
}

async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue || !queue.player) return;

    // .skip sets skipNext so a looped track actually advances instead of replaying.
    const skipRequested = queue.skipNext;
    queue.skipNext = false;

    if (queue.loop && queue.currentSong && !skipRequested) {
        await playSong(guildId, queue.currentSong);
        return;
    }

    if (queue.loopQueue && queue.currentSong) {
        queue.songs.push(queue.currentSong);
    }

    // Free the file we just stopped playing so cache cleanup can reclaim it later.
    if (queue.currentSong && queue.currentSong.localFile) {
        markFree(queue.currentSong.localFile);
    }

    if (queue.songs.length === 0) {
        queue.playing = false;
        queue.currentSong = null;
        await queue.textChannel.send('📭 Queue ended.');
        scheduleDisconnect(guildId);
        return;
    }

    const song = queue.songs.shift();
    await playSong(guildId, song);
}

async function playSong(guildId, song, suppressAnnounce = false) {
    const queue = queues.get(guildId);
    if (!queue || !queue.player) return;

    try {
        queue.currentSong = song;
        queue.playing = true;
        cancelDisconnect(guildId);

        let encoded = song.encoded;

        // If this is a YouTube song, ensure the local audio file is present.
        if (song.useYtDlp) {
            // Fast path: localFile already resolved (set by .play handler upfront) -- skip yt-dlp entirely.
            let localFile = song.localFile;

            const localFileUsable = (p) => {
                if (!p) return false;
                try {
                    const st = fs.statSync(p);
                    return st.isFile() && st.size > 1024;
                } catch (_) { return false; }
            };

            if (!localFileUsable(localFile)) {
                logInfo('Resolving via yt-dlp for: ' + song.title);
                const resolved = await resolveYtDlp(song.uri);
                if (!resolved || !resolved.ok || !resolved.localFile) {
                    const reason = (resolved && resolved.reason) ? resolved.reason : 'unknown';
                    await queue.textChannel.send('❌ Failed to download audio: `' + reason.slice(0, 200) + '`');
                    await playNext(guildId);
                    return;
                }
                localFile = resolved.localFile;
                song.localFile = localFile;
                song.title = resolved.title || song.title;
                song.length = resolved.length || song.length;
                song.thumbnail = resolved.thumbnail || song.thumbnail;
            } else {
                logInfo('Cached fast-path: ' + localFile);
            }

            markInUse(localFile);

            // Load the local file through Lavalink
            const node = [...shoukaku.nodes.values()].find(n => n.state === State.CONNECTED);
            if (!node) {
                await queue.textChannel.send('❌ Lavalink not connected!');
                return;
            }

            logInfo('Loading local file: ' + localFile);
            const localResult = await node.rest.resolve(localFile);

            // Explicit loadType switch (Lavalink v4 lowercase enum) instead of relying on
            // the data shape falling through correctly by accident.
            let localTrack = null;
            switch (localResult && localResult.loadType) {
                case 'track':
                    localTrack = localResult.data;
                    break;
                case 'search':
                case 'playlist':
                    localTrack = Array.isArray(localResult.data) ? localResult.data[0]
                               : (localResult.data && localResult.data.tracks ? localResult.data.tracks[0] : null);
                    break;
                case 'error':
                case 'empty':
                default:
                    localTrack = null;
            }

            if (!localTrack || !localTrack.encoded) {
                logError('Lavalink local load failed: ' + JSON.stringify(localResult));
                await queue.textChannel.send('❌ Lavalink could not load the audio file!');
                await playNext(guildId);
                return;
            }
            encoded = localTrack.encoded;
            logInfo('Local file loaded successfully');
            // Don't call cleanAudioCache here -- the periodic interval handles it, plus
            // calling it from inside play would risk deleting files we just queued.
        }

        const playOptions = {
            track: { encoded: encoded }
        };

        if (song.startTime) playOptions.position = song.startTime;
        if (song.startTime && song.duration) playOptions.track.endTime = song.startTime + song.duration;

        await queue.player.playTrack(playOptions);

        // The .play/.playfrom handlers announce the first track by editing their
        // placeholder message; announcing here too produced duplicate embeds.
        if (!suppressAnnounce) {
            await queue.textChannel.send({ embeds: [buildNowPlayingEmbed(song)] });
        }
    } catch (error) {
        logError('Error playing song: ' + (error && error.stack ? error.stack : error));
        await queue.textChannel.send('❌ Error playing song!');
        await playNext(guildId);
    }
}

// Track if Lavalink is ready
let lavalinkReady = false;

// Bot ready event
client.once('ready', () => {
    logInfo('Logged in as ' + client.user.tag);
    logInfo('Serving ' + client.guilds.cache.size + ' servers');
    logInfo('Waiting for Lavalink to connect...');
    startCacheCleanInterval();
});

// Self-heal: Shoukaku gives up after reconnectTries and the bot would otherwise sit
// zombie forever ("Lavalink is still connecting..." on every command). If Lavalink stays
// down past the deadline, exit(1) -- systemd's Restart=on-failure + Requires=lavalink
// brings the whole stack back up cleanly.
let lavalinkDeadTimer = null;
function armLavalinkDeadTimer() {
    if (lavalinkDeadTimer) return;
    lavalinkDeadTimer = setTimeout(() => {
        logError('Lavalink has been down for ' + (LAVALINK_DEAD_EXIT_MS / 1000) + 's; exiting so systemd can restart the stack.');
        process.exit(1);
    }, LAVALINK_DEAD_EXIT_MS);
}
function disarmLavalinkDeadTimer() {
    if (lavalinkDeadTimer) {
        clearTimeout(lavalinkDeadTimer);
        lavalinkDeadTimer = null;
    }
}

// Shoukaku events
shoukaku.on('ready', (name) => {
    logInfo('Lavalink ' + name + ' is ready!');
    logInfo('Bot is now fully operational and ready to play music!');
    lavalinkReady = true;
    disarmLavalinkDeadTimer();
});

shoukaku.on('error', (name, error) => {
    logError('Lavalink node ' + name + ' error: ' + (error && error.stack ? error.stack : error));
    lavalinkReady = false;
    armLavalinkDeadTimer();
});

shoukaku.on('close', (name, code, reason) => {
    logInfo('Lavalink node ' + name + ' closed: ' + code + ' - ' + reason);
    lavalinkReady = false;
    armLavalinkDeadTimer();
});

shoukaku.on('disconnect', (name, count) => {
    logInfo('Lavalink node ' + name + ' disconnected. Reconnect attempts: ' + count);
    lavalinkReady = false;
    armLavalinkDeadTimer();
});

// Map common yt-dlp stderr substrings to friendlier user messages.
function friendlyYtdlpReason(reason) {
    if (!reason) return 'Could not find that song!';
    const r = reason.toLowerCase();
    if (r.includes('drm protected')) return 'YouTube refused this video (DRM/Made-for-Kids restriction).';
    if (r.includes('please sign in') || r.includes('sign in')) return 'YouTube requires sign-in for this video. The bot\'s cookies.txt may be missing or expired.';
    if (r.includes('video is not available')) return 'YouTube reports this video is not available (region/Made-for-Kids/private).';
    if (r.includes('format is not available')) return 'No audio format available for this video.';
    if (r.includes('private video')) return 'This video is private.';
    if (r.includes('age')) return 'This video is age-restricted; the bot\'s cookies.txt may be missing or expired.';
    if (r.includes('removed') || r.includes('terminated')) return 'This video has been removed.';
    if (r.includes('unavailable')) return 'This video is unavailable.';
    // Fallback - show the first line of the actual yt-dlp error so the owner can debug.
    return 'Could not load track: `' + reason.slice(0, 160) + '`';
}

// Message handler
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    let command = args.shift().toLowerCase();

    // News command: enumerate the top date-sorted YouTube search hits via --flat-playlist
    // (cheap, ~3s for 10 results — no per-video API call), pick the first non-live entry of
    // sensible duration, then rewrite to .play with a direct watch URL. Full metadata
    // resolution + download is left to the play handler.
    if (command === 'news') {
        if (!args.length) {
            return message.reply('❌ Usage: `.news <topic>` (e.g. `.news usa`)');
        }
        const topic = args.join(' ') + ' news';
        const searchUrl = 'https://www.youtube.com/results?search_query=' +
            encodeURIComponent(topic) + '&sp=CAI%253D';
        const placeholder = await message.reply('📰 Finding latest `' + topic + '`...');
        const flatRes = await runYtDlp(
            ['--no-warnings', '--flat-playlist', '--playlist-end', '10', '-j', searchUrl],
            15000
        );
        if (!flatRes.ok) {
            return placeholder.edit('❌ News search failed: ' + (flatRes.reason || 'unknown'));
        }
        let chosenId = null;
        let chosenTitle = null;
        for (const line of flatRes.stdout.split('\n')) {
            if (!line.trim().startsWith('{')) continue;
            let v;
            try { v = JSON.parse(line); } catch (_) { continue; }
            if (v.live_status) continue;             // skip is_live and was_live (livestream replays)
            const dur = v.duration;
            if (!dur || dur < 60 || dur > 3600) continue;  // skip Shorts and >1hr
            chosenId = v.id;
            chosenTitle = v.title;
            break;
        }
        if (!chosenId) {
            return placeholder.edit('❌ No suitable news video found for `' + topic + '`');
        }
        logInfo('News pick: ' + chosenId + ' — ' + chosenTitle);
        try { await placeholder.delete(); } catch (_) {}
        args.splice(0, args.length, 'https://www.youtube.com/watch?v=' + chosenId);
        command = 'play';
    }

    // Play command
    if (command === 'play') {
        if (!lavalinkReady) {
            return message.reply('Lavalink is still connecting, please wait a few seconds...');
        }

        if (!message.member.voice.channel) {
            return message.reply('❌ You need to be in a voice channel!');
        }

        if (!args.length) {
            return message.reply('❌ Please provide a song name or URL!');
        }

        const query = args.join(' ');

        // Single deferred-reply pattern: send placeholder up front, then EDIT it.
        const placeholder = await message.reply('🔍 Searching...');

        try {
            const node = [...shoukaku.nodes.values()].find(node => node.state === State.CONNECTED);
            if (!node) {
                return placeholder.edit('❌ Lavalink node is not connected! Please wait a moment and try again.');
            }

            // Resolve via yt-dlp (async, non-blocking).
            logInfo('Resolving via yt-dlp: ' + query);
            const ytInfo = await resolveYtDlp(query);

            if (!ytInfo || !ytInfo.ok) {
                const friendly = friendlyYtdlpReason(ytInfo && ytInfo.reason);
                return placeholder.edit('❌ ' + friendly);
            }

            logInfo('Found: ' + ytInfo.title);

            const song = {
                title: ytInfo.title,
                uri: ytInfo.uri,
                length: ytInfo.length,
                thumbnail: ytInfo.thumbnail,
                requestedBy: message.author.tag,
                encoded: null,
                useYtDlp: true,
                localFile: ytInfo.localFile, // already-resolved local file -> playSong fast path
                videoId: ytInfo.videoId
            };

            // Queue mutations run under the guild lock so two near-simultaneous .play
            // commands can't both see playing=false and clobber each other's track.
            await withGuildLock(message.guild.id, async () => {
                let queue = queues.get(message.guild.id);
                if (!queue) {
                    queue = createQueue(message.guild.id);
                    queue.textChannel = message.channel;
                    queue.voiceChannel = message.member.voice.channel;
                    queues.set(message.guild.id, queue);

                    try {
                        queue.player = await shoukaku.joinVoiceChannel({
                            guildId: message.guild.id,
                            channelId: message.member.voice.channel.id,
                            shardId: 0
                        });
                        logInfo('Connected to voice channel: ' + message.member.voice.channel.name);
                        attachPlayerEvents(message.guild.id, queue);
                    } catch (error) {
                        logError('Error joining voice channel: ' + (error && error.stack ? error.stack : error));
                        queues.delete(message.guild.id);
                        await placeholder.edit('❌ Could not join voice channel!');
                        return;
                    }
                }

                if (queue.playing) {
                    queue.songs.push(song);
                    const embed = createSongEmbed(song, '📝 Added to Queue');
                    embed.addFields({ name: '🔢 Position', value: '`' + queue.songs.length + '`', inline: true });
                    cancelDisconnect(message.guild.id);
                    await placeholder.edit({ content: null, embeds: [embed] });
                    return;
                }

                // playSong's announcement is suppressed; the placeholder edit below is
                // the single "Now Playing" message for the first track.
                await playSong(message.guild.id, song, true);
                try {
                    await placeholder.edit({ content: null, embeds: [buildNowPlayingEmbed(song)] });
                } catch (_) { /* placeholder may already be irrelevant */ }
            });

        } catch (error) {
            logError('Play command error: ' + (error && error.stack ? error.stack : error));
            const msg = (error && error.code === 'ECONNREFUSED')
                ? '❌ Cannot connect to Lavalink! Please wait a moment for it to start.'
                : '❌ An error occurred while searching! Check console for details.';
            try { await placeholder.edit(msg); } catch (_) {}
        }
    }

    // Playfrom command
    if (command === 'playfrom') {
        if (!lavalinkReady) {
            return message.reply('Lavalink is still connecting, please wait a few seconds...');
        }

        if (!message.member.voice.channel) {
            return message.reply('❌ You need to be in a voice channel!');
        }

        if (args.length < 3) {
            return message.reply('❌ Usage: `.playfrom <url> <start_time> <duration>`\nExample: `.playfrom https://youtube.com/... 1:30 2:00`');
        }

        const url = args[0];
        const startTimeStr = args[1];
        const durationStr = args[2];

        const placeholder = await message.reply('🔍 Searching...');

        try {
            const startTime = parseTimeString(startTimeStr);
            const duration = parseTimeString(durationStr);

            const node = [...shoukaku.nodes.values()].find(node => node.state === State.CONNECTED);
            if (!node) {
                return placeholder.edit('❌ Lavalink node is not connected!');
            }

            const ytInfo = await resolveYtDlp(url);
            if (!ytInfo || !ytInfo.ok) {
                const friendly = friendlyYtdlpReason(ytInfo && ytInfo.reason);
                return placeholder.edit('❌ ' + friendly);
            }

            const song = {
                title: ytInfo.title,
                uri: ytInfo.uri,
                length: ytInfo.length,
                thumbnail: ytInfo.thumbnail,
                requestedBy: message.author.tag,
                startTime: startTime,
                duration: duration,
                encoded: null,
                useYtDlp: true,
                localFile: ytInfo.localFile,
                videoId: ytInfo.videoId
            };

            await withGuildLock(message.guild.id, async () => {
                let queue = queues.get(message.guild.id);
                if (!queue) {
                    queue = createQueue(message.guild.id);
                    queue.textChannel = message.channel;
                    queue.voiceChannel = message.member.voice.channel;
                    queues.set(message.guild.id, queue);

                    try {
                        queue.player = await shoukaku.joinVoiceChannel({
                            guildId: message.guild.id,
                            channelId: message.member.voice.channel.id,
                            shardId: 0
                        });
                        attachPlayerEvents(message.guild.id, queue);
                    } catch (error) {
                        logError('Error joining voice channel: ' + (error && error.stack ? error.stack : error));
                        queues.delete(message.guild.id);
                        await placeholder.edit('❌ Could not join voice channel!');
                        return;
                    }
                }

                if (queue.playing) {
                    queue.songs.push(song);
                    cancelDisconnect(message.guild.id);
                    await placeholder.edit('📝 Added to queue!');
                    return;
                }

                await playSong(message.guild.id, song, true);
                try {
                    await placeholder.edit({ content: null, embeds: [buildNowPlayingEmbed(song)] });
                } catch (_) {}
            });

        } catch (error) {
            logError('Error in playfrom command: ' + (error && error.stack ? error.stack : error));
            try { await placeholder.edit('❌ An error occurred!'); } catch (_) {}
        }
    }

    // Skip command
    if (command === 'skip') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        // Advance even when loop is on -- replaying the track you just skipped is never
        // what anyone means by "skip". Loop stays enabled for the next track.
        queue.skipNext = true;
        if (queue.paused) {
            queue.paused = false;
            try { await queue.player.setPaused(false); } catch (_) {}
        }
        await message.reply('⏭️ Skipped!');
        queue.player.stopTrack();
    }

    // Stop command
    if (command === 'stop') {
        const queue = queues.get(message.guild.id);
        if (!queue) {
            return message.reply('❌ Nothing is playing!');
        }
        releaseQueueFiles(queue);
        queue.songs = [];
        queue.loop = false;
        queue.loopQueue = false;
        queue.playing = false;
        queue.paused = false;
        queue.currentSong = null;
        if (queue.player) queue.player.stopTrack();
        scheduleDisconnect(message.guild.id);
        await message.reply('⏹️ Stopped and cleared queue!');
    }

    // Pause / resume commands
    if (command === 'pause') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        if (queue.paused) {
            return message.reply('⏸️ Already paused! Use `.resume` to continue.');
        }
        await queue.player.setPaused(true);
        queue.paused = true;
        await message.reply('⏸️ Paused! Use `.resume` to continue.');
    }

    if (command === 'resume' || command === 'unpause') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        if (!queue.paused) {
            return message.reply('▶️ Not paused!');
        }
        await queue.player.setPaused(false);
        queue.paused = false;
        await message.reply('▶️ Resumed!');
    }

    // Volume command (0-150, Lavalink treats 100 as unity gain)
    if (command === 'volume' || command === 'vol') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.player) {
            return message.reply('❌ Nothing is playing!');
        }
        const vol = parseInt(args[0], 10);
        if (isNaN(vol) || vol < 0 || vol > 150) {
            return message.reply('❌ Usage: `.volume <0-150>` (100 = normal)');
        }
        await queue.player.setGlobalVolume(vol);
        await message.reply('🔊 Volume set to `' + vol + '`');
    }

    // Now playing command with live position
    if (command === 'np' || command === 'nowplaying') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing || !queue.currentSong) {
            return message.reply('❌ Nothing is playing!');
        }
        const song = queue.currentSong;
        const pos = Math.min(queue.player.position || 0, song.length || 0);
        const barLen = 20;
        const filled = song.length ? Math.round((pos / song.length) * barLen) : 0;
        const bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, barLen - filled));
        const embed = createSongEmbed(song, queue.paused ? '⏸️ Now Playing (paused)' : '🎵 Now Playing');
        embed.setDescription(embed.data.description + '\n\n' + bar + '\n`' + formatTime(pos) + ' / ' + formatTime(song.length) + '`');
        await message.reply({ embeds: [embed] });
    }

    // Shuffle command
    if (command === 'shuffle') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length < 2) {
            return message.reply('❌ Need at least 2 queued songs to shuffle!');
        }
        for (let i = queue.songs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue.songs[i], queue.songs[j]] = [queue.songs[j], queue.songs[i]];
        }
        await message.reply('🔀 Queue shuffled! (' + queue.songs.length + ' songs)');
    }

    // Remove command
    if (command === 'remove' || command === 'rm') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length === 0) {
            return message.reply('❌ Queue is empty!');
        }
        const n = parseInt(args[0], 10);
        if (isNaN(n) || n < 1 || n > queue.songs.length) {
            return message.reply('❌ Usage: `.remove <1-' + queue.songs.length + '>` (see `.queue` for numbers)');
        }
        const [removed] = queue.songs.splice(n - 1, 1);
        markFree(removed.localFile);
        await message.reply('🗑️ Removed **' + removed.title + '** from the queue.');
    }

    // Queue command
    if (command === 'queue' || command === 'q') {
        const queue = queues.get(message.guild.id);
        if (!queue || (!queue.playing && queue.songs.length === 0)) {
            return message.reply('📭 Queue is empty!');
        }

        const embed = new EmbedBuilder()
            .setTitle('📋 Music Queue')
            .setColor('#FF0000')
            .setFooter({ text: queue.loop ? '🔂 Loop: ON' : queue.loopQueue ? '🔁 Loop Queue: ON' : 'Powered by Lavalink + yt-dlp' })
            .setTimestamp();

        if (queue.currentSong) {
            embed.addFields({
                name: '🎵 Now Playing',
                value: '**[' + queue.currentSong.title + '](' + queue.currentSong.uri + ')**\n⏰ `' + formatTime(queue.currentSong.length) + '`'
            });
        }

        if (queue.songs.length > 0) {
            const queueList = queue.songs.slice(0, 10).map((song, i) =>
                '**' + (i + 1) + '.** [' + song.title + '](' + song.uri + ') - `' + formatTime(song.length) + '`'
            ).join('\n');

            embed.addFields({
                name: '📝 Up Next (' + queue.songs.length + ' song' + (queue.songs.length === 1 ? '' : 's') + ')',
                value: queueList + (queue.songs.length > 10 ? '\n*...and ' + (queue.songs.length - 10) + ' more*' : '')
            });
        }

        await message.reply({ embeds: [embed] });
    }

    // Clear command
    if (command === 'clear') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length === 0) {
            return message.reply('❌ Queue is already empty!');
        }
        queue.songs = [];
        await message.reply('🗑️ Queue cleared!');
    }

    // Loop command
    if (command === 'loop') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        queue.loop = !queue.loop;
        queue.loopQueue = false;
        await message.reply(queue.loop ? '🔂 Loop enabled!' : '🔂 Loop disabled!');
    }

    // Loop queue command
    if (command === 'loopqueue' || command === 'lq') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        queue.loopQueue = !queue.loopQueue;
        queue.loop = false;
        await message.reply(queue.loopQueue ? '🔁 Loop queue enabled!' : '🔁 Loop queue disabled!');
    }

    // Disconnect command
    if (command === 'dc' || command === 'disconnect' || command === 'leave') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.player) {
            return message.reply('❌ Bot is not in a voice channel!');
        }

        try {
            logInfo('Disconnecting from voice channel...');
            cancelDisconnect(message.guild.id);
            releaseQueueFiles(queue);
            if (queue.player) queue.player.stopTrack();
            shoukaku.leaveVoiceChannel(message.guild.id);
            if (message.guild.members.me.voice.channel) {
                await message.guild.members.me.voice.disconnect();
            }
            queues.delete(message.guild.id);
            await message.reply('👋 Disconnected!');
        } catch (error) {
            logError('Error during disconnect: ' + (error && error.stack ? error.stack : error));
            queues.delete(message.guild.id);
            await message.reply('👋 Disconnected!');
        }
    }
});

// Login
client.login(TOKEN);
