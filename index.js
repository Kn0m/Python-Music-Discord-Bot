const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, getVoiceConnection, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytsr = require('@distube/ytsr');

process.env.YTDL_NO_UPDATE = 'true';
process.env.DISCORD_DISABLE_MENTIONS = 'true';
require('events').EventEmitter.defaultMaxListeners = 0;

const TOKEN = ''; 
const PREFIX = '.';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const queues = new Map();

function createQueue() {
    return {
        songs: [],
        player: createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play,
                maxMissedFrames: Math.round(3000 / 20), // 3 seconds of buffering
            },
            debug: false // Disable debug for better performance
        }),
        connection: null,
        textChannel: null,
        voiceChannel: null,
        volume: 1,
        playing: false,
        loop: false,
        loopQueue: false
    };
}

function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function createEmbed(song, title) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(`[${song.title}](${song.url})`)
        .addFields(
            { name: 'Duration', value: song.duration, inline: true },
            { name: 'Requested by', value: song.requestedBy, inline: true }
        )
        .setThumbnail(song.thumbnail)
        .setColor('#FF0000');
}

async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) {
        if (queue) {
            queue.playing = false;
            await queue.textChannel.send('📭 Queue is empty! Add more songs to continue.');
        }
        return;
    }

    const song = queue.songs[0];
    
    try {
        console.log(`Attempting to play: ${song.url}`);
        
        // Create stream from YouTube with optimized settings
        const stream = ytdl(song.url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
            // Add additional options for better streaming
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }
        });
        
        // Pre-buffer the stream
        console.log('Pre-buffering stream...');
        await new Promise(resolve => setTimeout(resolve, 1500)); // Increased buffer time
        
        // Wait for stream to be readable
        if (!stream.readable) {
            await new Promise((resolve) => {
                stream.once('readable', resolve);
                // Timeout after 5 seconds
                setTimeout(resolve, 5000);
            });
        }
        
        // Create optimized audio resource
        const resource = createAudioResource(stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
            silencePaddingFrames: 5, // Add padding for smooth playback
            metadata: {
                title: song.title
            }
        });
        
        // Set volume
        resource.volume?.setVolume(queue.volume);
        
        // Add delay before playing to ensure proper buffering
        setTimeout(() => {
            queue.player.play(resource);
            queue.playing = true;
            console.log(`Now playing: ${song.title}`);
        }, 500); // 500ms delay for smooth start
        
        // Send now playing message
        const embed = createEmbed(song, '🎵 Now Playing');
        await queue.textChannel.send({ embeds: [embed] });
        
    } catch (error) {
        console.error('Error playing song:', error);
        await queue.textChannel.send(`❌ Error playing: ${song.title}. Skipping to next song...`);
        
        // Skip to next song if error
        if (!queue.loop) {
            queue.songs.shift();
        }
        setTimeout(() => playNext(guildId), 1000);
    }
}

function setupPlayer(queue, guildId) {
    queue.player.on(AudioPlayerStatus.Playing, () => {
        console.log('Audio player status: Playing');
    });

    queue.player.on(AudioPlayerStatus.Buffering, () => {
        console.log('Audio player status: Buffering...');
    });

    queue.player.on(AudioPlayerStatus.Idle, () => {
        console.log('Song finished, determining next action...');
        // Handle song end
        if (queue.loop) {
            // Play same song again
            setTimeout(() => playNext(guildId), 500);
        } else if (queue.loopQueue) {
            // Move song to end of queue
            const song = queue.songs.shift();
            queue.songs.push(song);
            setTimeout(() => playNext(guildId), 500);
        } else {
            // Remove song and play next
            queue.songs.shift();
            setTimeout(() => playNext(guildId), 500);
        }
    });
    
    queue.player.on('error', error => {
        console.error('Player error:', error);
        if (queue.textChannel) {
            queue.textChannel.send('❌ An error occurred while playing audio. Skipping...');
        }
        if (!queue.loop) {
            queue.songs.shift();
        }
        setTimeout(() => playNext(guildId), 1000);
    });
}

function joinVoiceChannelOptimized(voiceChannel, guildId) {
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true, // Bot doesn't need to hear
        selfMute: false
    });

    // Set up connection optimization
    connection.on(VoiceConnectionStatus.Ready, () => {
        console.log('Voice connection ready and optimized');
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log('Voice connection disconnected');
    });

    return connection;
}

function cleanupMemory() {
    if (global.gc) {
        global.gc();
        console.log('Memory cleanup performed');
    }
}

setInterval(cleanupMemory, 5 * 60 * 1000);

client.once('ready', () => {
    console.log(`✅ ${client.user.tag} is online!`);
    console.log(`Bot is in ${client.guilds.cache.size} servers`);
    console.log('Listening for messages starting with:', PREFIX);
    console.log('Using optimized ytdl-core for YouTube streaming');
    client.user.setActivity('.help for commands');
});

client.on('messageCreate', async message => {
    // Log EVERY message the bot can see
    console.log(`[${message.guild?.name}] ${message.author.tag}: ${message.content}`);
    
    if (message.author.bot) {
        console.log('^ Skipped - bot message');
        return;
    }
    
    if (!message.content.startsWith(PREFIX)) {
        console.log(`^ Skipped - doesn't start with ${PREFIX}`);
        return;
    }
    
    console.log('^ Processing command!');
    
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    console.log(`Command: ${command}, Args: ${args.join(', ')}`);
    
    // Command: play
    if (command === 'play' || command === 'p') {
        if (!args.length) {
            return message.reply('❌ Please provide a YouTube URL or search query!');
        }
        
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            return message.reply('❌ You need to be in a voice channel!');
        }
        
        const permissions = voiceChannel.permissionsFor(message.client.user);
        if (!permissions.has('Connect') || !permissions.has('Speak')) {
            return message.reply('❌ I need permissions to join and speak in your voice channel!');
        }
        
        let queue = queues.get(message.guild.id);
        
        if (!queue) {
            queue = createQueue();
            queues.set(message.guild.id, queue);
            setupPlayer(queue, message.guild.id);
        }
        
        queue.textChannel = message.channel;
        queue.voiceChannel = voiceChannel;
        
        // Search or get video info
        const query = args.join(' ');
        let songInfo;
        let videoUrl;
        
        try {
            await message.channel.send('🔍 Searching...');
            
            // Check if it's a URL or search query
            if (ytdl.validateURL(query)) {
                videoUrl = query;
                console.log('Valid YouTube URL provided:', videoUrl);
            } else {
                // Search for the video
                console.log('Searching for:', query);
                const searchResults = await ytsr(query, { limit: 1 });
                
                if (!searchResults.items || searchResults.items.length === 0) {
                    return message.reply('❌ No results found!');
                }
                
                const video = searchResults.items[0];
                if (video.type !== 'video') {
                    return message.reply('❌ No video found for that search!');
                }
                
                videoUrl = video.url;
                console.log('Found video URL:', videoUrl);
            }
            
            // Get video info
            songInfo = await ytdl.getInfo(videoUrl);
            console.log('Got video info:', songInfo.videoDetails.title);
            
            const song = {
                title: songInfo.videoDetails.title,
                url: songInfo.videoDetails.video_url,
                duration: formatDuration(parseInt(songInfo.videoDetails.lengthSeconds)),
                thumbnail: songInfo.videoDetails.thumbnails[0].url,
                requestedBy: message.author.tag
            };
            
            queue.songs.push(song);
            console.log('Added to queue:', song.title);
            
            // Join voice channel if not connected (using optimized function)
            if (!queue.connection) {
                queue.connection = joinVoiceChannelOptimized(voiceChannel, message.guild.id);
                queue.connection.subscribe(queue.player);
                console.log('Joined voice channel with optimizations');
            }
            
            // Start playing if not already
            if (!queue.playing) {
                playNext(message.guild.id);
            } else {
                const embed = createEmbed(song, '✅ Added to Queue');
                embed.addFields({ name: 'Position', value: `${queue.songs.length}`, inline: true });
                message.channel.send({ embeds: [embed] });
            }
            
        } catch (error) {
            console.error('Error in play command:', error);
            return message.reply('❌ Error processing your request! Make sure it\'s a valid YouTube video.');
        }
    }
    
    // Command: skip
    else if (command === 'skip' || command === 's') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        
        if (!message.member.voice.channel) {
            return message.reply('❌ You need to be in a voice channel!');
        }
        
        queue.player.stop();
        message.channel.send('⏭️ Skipped!');
    }
    
    // Command: stop
    else if (command === 'stop') {
        const queue = queues.get(message.guild.id);
        if (!queue) {
            return message.reply('❌ Nothing is playing!');
        }
        
        queue.songs = [];
        queue.player.stop();
        if (queue.connection) {
            queue.connection.destroy();
        }
        queues.delete(message.guild.id);
        message.channel.send('⏹️ Stopped and cleared the queue!');
    }
    
    // Command: pause
    else if (command === 'pause') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        
        queue.player.pause();
        message.channel.send('⏸️ Paused!');
    }
    
    // Command: resume
    else if (command === 'resume') {
        const queue = queues.get(message.guild.id);
        if (!queue) {
            return message.reply('❌ Nothing to resume!');
        }
        
        queue.player.unpause();
        message.channel.send('▶️ Resumed!');
    }
    
    // Command: queue
    else if (command === 'queue' || command === 'q') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length === 0) {
            return message.reply('📭 Queue is empty!');
        }
        
        const embed = new EmbedBuilder()
            .setTitle('🎵 Music Queue')
            .setColor('#FF0000')
            .setFooter({ text: `${queue.songs.length} songs in queue` });
        
        const songList = queue.songs.slice(0, 10).map((song, index) => {
            return `${index === 0 ? '**Now Playing:**' : `${index}.`} ${song.title} - \`${song.duration}\``;
        }).join('\n');
        
        embed.setDescription(songList);
        
        if (queue.songs.length > 10) {
            embed.addFields({ name: 'And more...', value: `${queue.songs.length - 10} more songs` });
        }
        
        message.channel.send({ embeds: [embed] });
    }
    
    // Command: nowplaying
    else if (command === 'nowplaying' || command === 'np') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing || queue.songs.length === 0) {
            return message.reply('❌ Nothing is playing!');
        }
        
        const song = queue.songs[0];
        const embed = createEmbed(song, '🎵 Now Playing');
        message.channel.send({ embeds: [embed] });
    }
    
    // Command: loop
    else if (command === 'loop' || command === 'l') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        
        queue.loop = !queue.loop;
        message.channel.send(`🔁 Loop ${queue.loop ? 'enabled' : 'disabled'}!`);
    }
    
    // Command: loopqueue
    else if (command === 'loopqueue' || command === 'lq') {
        const queue = queues.get(message.guild.id);
        if (!queue || !queue.playing) {
            return message.reply('❌ Nothing is playing!');
        }
        
        queue.loopQueue = !queue.loopQueue;
        message.channel.send(`🔁 Queue loop ${queue.loopQueue ? 'enabled' : 'disabled'}!`);
    }
    
    // Command: remove
    else if (command === 'remove' || command === 'rm') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length === 0) {
            return message.reply('📭 Queue is empty!');
        }
        
        const index = parseInt(args[0]);
        if (isNaN(index) || index < 1 || index >= queue.songs.length) {
            return message.reply('❌ Invalid song number!');
        }
        
        const removed = queue.songs.splice(index, 1)[0];
        message.channel.send(`❌ Removed: **${removed.title}**`);
    }
    
    // Command: clear
    else if (command === 'clear') {
        const queue = queues.get(message.guild.id);
        if (!queue || queue.songs.length <= 1) {
            return message.reply('📭 Queue is already empty!');
        }
        
        queue.songs = [queue.songs[0]]; // Keep current song
        message.channel.send('🗑️ Cleared the queue!');
    }
    
    // Command: help
    else if (command === 'help' || command === 'h') {
        console.log('Sending help message...');
        const embed = new EmbedBuilder()
            .setTitle('🎵 Music Bot Commands')
            .setColor('#FF0000')
            .setDescription('All commands use the `.` prefix')
            .addFields(
                { name: '.play [URL/search]', value: 'Play a song or add to queue', inline: true },
                { name: '.skip', value: 'Skip current song', inline: true },
                { name: '.stop', value: 'Stop and clear queue', inline: true },
                { name: '.pause', value: 'Pause playback', inline: true },
                { name: '.resume', value: 'Resume playback', inline: true },
                { name: '.queue', value: 'Show queue', inline: true },
                { name: '.nowplaying', value: 'Show current song', inline: true },
                { name: '.loop', value: 'Toggle song loop', inline: true },
                { name: '.loopqueue', value: 'Toggle queue loop', inline: true },
                { name: '.remove [number]', value: 'Remove song from queue', inline: true },
                { name: '.clear', value: 'Clear queue', inline: true },
                { name: '.help', value: 'Show this menu', inline: true }
            )
            .setFooter({ text: 'Shortcuts: p = play, s = skip, q = queue, np = nowplaying, l = loop, lq = loopqueue, rm = remove, h = help' });
        
        message.channel.send({ embeds: [embed] });
    }
});

client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.member.user.id === client.user.id && !newState.channel) {
        const queue = queues.get(oldState.guild.id);
        if (queue) {
            queue.son
            queues.delete(oldState.guild.id);
        }
    }
});

client.on('error', error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

client.login(TOKEN)
