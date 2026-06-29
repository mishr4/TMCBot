'use strict';

/*
 * TMC radio bot
 * - /play        join your voice channel and stream the AzuraCast radio
 * - /stop        leave the voice channel
 * - /nowplaying  show the current song from AzuraCast
 * - /staff-dm    DM everyone in a role (or two) an announcement  [Manage Server only]
 *
 * Audio is bundled end to end: ffmpeg-static supplies ffmpeg, ffmpeg encodes the
 * stream straight to Ogg/Opus, and libsodium-wrappers handles voice encryption.
 * No system ffmpeg, no native opus build, no compiler required.
 */

const {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
  entersState, getVoiceConnection
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('node:child_process');

// ---- config (from environment) ----
const TOKEN = process.env.DISCORD_TOKEN;
const STREAM_URL = process.env.TMCAST_STREAM_URL || process.env.AZURACAST_STREAM_URL;            // e.g. https://cast.tmc.gg/listen/one/radio.mp3
const NOWPLAYING_URL = process.env.TMCAST_NOWPLAYING_URL || process.env.AZURACAST_NOWPLAYING_URL || ''; // e.g. https://cast.tmc.gg/api/np/one
const STATION_NAME = process.env.STATION_NAME || 'the radio';
const GUILD_ID = process.env.GUILD_ID || '';                   // optional: instant slash-command registration
const AUTOPLAY_CHANNEL_ID = process.env.AUTOPLAY_CHANNEL_ID || ''; // optional: auto-join + play on startup
const BITRATE = process.env.AUDIO_BITRATE || '96k';            // lower (e.g. 64k) to cut outbound bandwidth
const ACCENT = 0x7c4dff;

if (!TOKEN) { console.error('FATAL: DISCORD_TOKEN is not set.'); process.exit(1); }
if (!STREAM_URL) { console.error('FATAL: AZURACAST_STREAM_URL is not set.'); process.exit(1); }
if (!ffmpegPath) { console.error('FATAL: ffmpeg-static did not provide a binary.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- audio ----
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
const connections = new Map(); // guildId -> VoiceConnection
let currentFfmpeg = null;

function spawnStream() {
  // Long-lived internet radio: reconnect automatically and re-encode to Ogg/Opus.
  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', STREAM_URL,
    '-vn',
    '-c:a', 'libopus',
    '-b:a', BITRATE,
    '-ar', '48000',
    '-ac', '2',
    '-f', 'ogg',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.on('error', (e) => console.error('ffmpeg spawn error:', e.message));
  ff.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.error('ffmpeg:', line);
  });
  return ff;
}

function startStream() {
  stopFfmpeg();
  const ff = spawnStream();
  currentFfmpeg = ff;
  const resource = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus });
  player.play(resource);
}

function stopFfmpeg() {
  if (currentFfmpeg) {
    try { currentFfmpeg.kill('SIGKILL'); } catch {}
    currentFfmpeg = null;
  }
}

function stopEverythingIfIdle() {
  // No one is listening anywhere -> stop the encoder to save CPU.
  if (connections.size === 0) { stopFfmpeg(); player.stop(); }
}

// Radio should never "end" — if the encoder dies or the source hiccups, restart it.
player.on(AudioPlayerStatus.Idle, () => {
  if (connections.size > 0) { console.log('Stream went idle — restarting.'); startStream(); }
});
player.on('error', (err) => {
  console.error('Audio player error:', err.message);
  if (connections.size > 0) startStream();
});

async function connectAndPlay(channel) {
  const existing = getVoiceConnection(channel.guild.id);
  if (existing) { try { existing.destroy(); } catch {} }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  });
  connections.set(channel.guild.id, connection);
  connection.on('stateChange', (o, n) => console.log(`Voice connection: ${o.status} -> ${n.status}`));

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Could be a move or a brief network blip — give it a chance to resume.
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      try { connection.destroy(); } catch {}
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    connections.delete(channel.guild.id);
    stopEverythingIfIdle();
  });

  connection.subscribe(player);
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    try { connection.destroy(); } catch {}
    throw new Error('Couldn’t establish the voice connection in time — please try again in a moment.');
  }

  if (player.state.status !== AudioPlayerStatus.Playing) startStream();
}

// ---- slash commands ----
const commands = [
  new SlashCommandBuilder().setName('play').setDescription(`Stream ${STATION_NAME} in your current voice channel`),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the radio and leave the voice channel'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show what is currently playing on the radio'),
  new SlashCommandBuilder()
    .setName('staff-dm')
    .setDescription('DM everyone in a role an announcement')
    .addRoleOption((o) => o.setName('role').setDescription('Role to DM').setRequired(true))
    .addStringOption((o) => o.setName('message').setDescription('The announcement text').setRequired(true))
    .addRoleOption((o) => o.setName('also_role').setDescription('Optional second role to include').setRequired(false))
    .addStringOption((o) => o.setName('title').setDescription('Optional title for the announcement').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
].map((c) => c.toJSON());

async function registerCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body: commands });
    console.log('Registered guild commands (available immediately).');
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Registered global commands (can take up to ~1 hour to appear).');
  }
}

// ---- command handlers ----
async function cmdPlay(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    return interaction.reply({ content: 'Join a voice channel first, then run **/play**.', flags: MessageFlags.Ephemeral });
  }
  const me = interaction.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return interaction.reply({ content: `I need **Connect** and **Speak** permissions in **${channel.name}**.`, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply();
  await connectAndPlay(channel);
  await interaction.editReply(`▶️ Now streaming **${STATION_NAME}** in **${channel.name}**.`);
}

async function cmdStop(interaction) {
  const connection = connections.get(interaction.guildId);
  if (!connection) {
    return interaction.reply({ content: 'I’m not playing in this server.', flags: MessageFlags.Ephemeral });
  }
  try { connection.destroy(); } catch {}
  connections.delete(interaction.guildId);
  stopEverythingIfIdle();
  return interaction.reply('⏹️ Stopped and left the voice channel.');
}

async function cmdNowPlaying(interaction) {
  if (!NOWPLAYING_URL) {
    return interaction.reply({ content: 'Now-playing isn’t configured (set `AZURACAST_NOWPLAYING_URL`).', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply();
  const res = await fetch(NOWPLAYING_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Could not reach the radio API.');
  let data = await res.json();
  if (Array.isArray(data)) data = data[0] || {}; // /api/nowplaying returns an array of stations

  // Tolerate both TMCast (flat now_playing, numeric listeners, top-level is_live)
  // and standard AzuraCast (now_playing.song, listeners.current, live.is_live).
  const npRaw = data.now_playing || {};
  const song = npRaw.song || npRaw;
  const title = song.title || 'Unknown track';
  const artist = song.artist || '';
  const art = song.artwork_url || song.art || (data.station && data.station.logo_url) || null;
  const station = (data.station && data.station.name) || STATION_NAME;
  const listeners = typeof data.listeners === 'number'
    ? data.listeners
    : (data.listeners && (data.listeners.current ?? data.listeners.total));
  const isLive = data.is_live ?? (data.live && data.live.is_live) ?? false;
  const streamer = (data.live && data.live.streamer_name) || data.streamer_name;

  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: isLive ? `🔴 Live on ${station}` : `🎵 Now playing on ${station}` })
    .setTitle(title)
    .setDescription(artist || '​');
  if (art) embed.setThumbnail(art);
  const footer = [];
  if (isLive && streamer) footer.push(`DJ: ${streamer}`);
  if (listeners != null) footer.push(`${listeners} listening`);
  if (footer.length) embed.setFooter({ text: footer.join(' • ') });

  return interaction.editReply({ embeds: [embed] });
}

async function cmdStaffDm(interaction) {
  const role = interaction.options.getRole('role');
  const role2 = interaction.options.getRole('also_role');
  const message = interaction.options.getString('message');
  const title = interaction.options.getString('title') || `Announcement — ${interaction.guild.name}`;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Make sure the member list is loaded so role membership is complete.
  await interaction.guild.members.fetch();

  const targets = new Map();
  for (const r of [role, role2]) {
    if (!r) continue;
    const full = interaction.guild.roles.cache.get(r.id);
    full?.members?.forEach((m) => { if (!m.user.bot) targets.set(m.id, m); });
  }
  if (targets.size === 0) return interaction.editReply('That role has no (non-bot) members to DM.');

  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(title)
    .setDescription(message)
    .setFooter({ text: `Sent by ${interaction.user.tag} • ${interaction.guild.name}` })
    .setTimestamp();

  let sent = 0, failed = 0;
  for (const member of targets.values()) {
    try { await member.send({ embeds: [embed] }); sent++; }
    catch { failed++; }
    await sleep(350); // gentle pace so Discord doesn't flag the burst
  }

  const roleNames = [role, role2].filter(Boolean).map((r) => `@${r.name}`).join(', ');
  let summary = `📣 Delivered to **${sent}** member(s) of **${roleNames}**.`;
  if (failed) summary += ` **${failed}** couldn’t be reached (DMs closed or blocked).`;
  return interaction.editReply(summary);
}

// ---- wiring ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers // privileged — enable "Server Members Intent" in the Dev Portal
  ]
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try { await registerCommands(c.user.id); } catch (e) { console.error('Command registration failed:', e.message); }

  if (AUTOPLAY_CHANNEL_ID) {
    try {
      const ch = await c.channels.fetch(AUTOPLAY_CHANNEL_ID);
      if (ch && ch.isVoiceBased()) { await connectAndPlay(ch); console.log(`Auto-joined ${ch.name}.`); }
      else console.error('AUTOPLAY_CHANNEL_ID is not a voice channel.');
    } catch (e) { console.error('Autoplay failed:', e.message); }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'play') return await cmdPlay(interaction);
    if (interaction.commandName === 'stop') return await cmdStop(interaction);
    if (interaction.commandName === 'nowplaying') return await cmdNowPlaying(interaction);
    if (interaction.commandName === 'staff-dm') return await cmdStaffDm(interaction);
  } catch (e) {
    console.error(`/${interaction.commandName} error:`, e);
    const payload = { content: '⚠️ ' + (e.message || 'Something went wrong.'), flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); process.exit(1); });

client.login(TOKEN);
