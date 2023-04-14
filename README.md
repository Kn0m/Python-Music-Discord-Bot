# Python-Music-Discord-Bot


 

import asyncio
import discord
from discord.ext import commands
from youtube_dl import YoutubeDL

bot = commands.Bot(command_prefix='!')

class MusicPlayer:
    def __init__(self, ctx):
        self.ctx = ctx
        self.queue = asyncio.Queue()
        self.next = asyncio.Event()
        self.voice = discord.utils.get(bot.voice_clients, guild=ctx.guild)

        bot.loop.create_task(self.player_loop())

    async def player_loop(self):
        await bot.wait_until_ready()

        while not bot.is_closed():
            self.next.clear()
            url = await self.queue.get()
            YDL_OPTIONS = {'format': 'bestaudio', 'noplaylist':'True'}
            FFMPEG_OPTIONS = {
                'before_options': '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5', 'options': '-vn'}
            with YoutubeDL(YDL_OPTIONS) as ydl:
                info = ydl.extract_info(url, download=False)
            URL = info['formats'][0]['url']
            self.voice.play(discord.FFmpegPCMAudio(URL, **FFMPEG_OPTIONS), after=lambda e: self.next.set())
            await self.next.wait()

players = {}

@bot.command(name='play')
async def play(ctx, url):
    if ctx.guild.id not in players:
        players[ctx.guild.id] = MusicPlayer(ctx)
    player = players[ctx.guild.id]
    await player.queue.put(url)

@bot.command(name='pause')
async def pause(ctx):
    voice = discord.utils.get(bot.voice_clients, guild=ctx.guild)
    if voice.is_playing():
        voice.pause()

@bot.command(name='resume')
async def resume(ctx):
    voice = discord.utils.get(bot.voice_clients, guild=ctx.guild)
    if voice.is_paused():
        voice.resume()

@bot.command(name='skip')
async def skip(ctx):
    voice = discord.utils.get(bot.voice_clients, guild=ctx.guild)
    voice.stop()

@bot.command(name='stop')
async def stop(ctx):
    voice = discord.utils.get(bot.voice_clients, guild=ctx.guild)
    voice.stop()

bot.run('YOUR_TOKEN_HERE')
