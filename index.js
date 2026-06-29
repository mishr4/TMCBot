'use strict';

/*
 * TMC bot — admin + logging (with optional radio).
 * Commands: /play /stop /nowplaying /staff-dm
 * Logging: auto-routes events to channels BY NAME (no channel IDs to set up):
 *   msg-logs  · deletes, edits, purges
 *   mod-logs  · bans, unbans, kicks, timeouts
 *   role-logs · role add/remove, role create/delete
 *   user-logs · joins, leaves, nickname changes
 *   vc-logs   · voice join/leave/move
 *
 * Audio is bundled: ffmpeg-static + ffmpeg→Ogg/Opus + @noble/ciphers encryption —
 * no system ffmpeg, no native build.
 */

const {
  Client, GatewayIntentBits, Events, Partials, AuditLogEvent, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, ChannelType, AttachmentBuilder,
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, SeparatorBuilder, ThumbnailBuilder
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
  entersState, getVoiceConnection
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('node:child_process');
const path = require('node:path');

// Welcome-card rendering (prebuilt canvas; falls back to an embed if unavailable).
let Canvas = null;
try {
  Canvas = require('@napi-rs/canvas');
  Canvas.GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'Poppins-Bold.ttf'), 'Poppins Bold');
  Canvas.GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'Poppins-Regular.ttf'), 'Poppins');
} catch (e) { console.warn('@napi-rs/canvas unavailable — welcome cards will use an embed.', e.message); }

async function fetchImg(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await Canvas.loadImage(Buffer.from(await r.arrayBuffer())); } catch { return null; }
}
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
async function makeWelcomeCard(member) {
  if (!Canvas) return null;
  try {
    const W = 800, H = 260;
    const c = Canvas.createCanvas(W, H);
    const ctx = c.getContext('2d');
    roundRectPath(ctx, 0, 0, W, H, 26); ctx.clip();
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#7C4DFF'); g.addColorStop(1, '#3A1A9E');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const rg = ctx.createRadialGradient(W * 0.8, H * 0.5, 10, W * 0.8, H * 0.5, 280);
    rg.addColorStop(0, 'rgba(255,255,255,0.16)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '22px "Poppins Bold"'; ctx.fillText('WELCOME TO MAVION', 46, 58);
    ctx.fillStyle = '#ffffff';
    ctx.font = '44px "Poppins Bold"'; ctx.fillText(fitText(ctx, member.user.username, 430), 46, 112);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.font = '24px "Poppins"'; ctx.fillText(`You're member #${member.guild.memberCount}`, 46, 152);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(46, 182); ctx.lineTo(486, 182); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '18px "Poppins"';
    ctx.fillText('We’d love to have you — apply in #careers', 46, 214);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '16px "Poppins"';
    ctx.fillText('tmc.gg', 46, 240);

    const av = await fetchImg(member.user.displayAvatarURL({ extension: 'png', size: 256 }));
    if (av) {
      const cx = W - 150, cy = H / 2, rad = 82;
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
      ctx.drawImage(av, cx - rad, cy - rad, rad * 2, rad * 2); ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    }
    return c.toBuffer('image/png');
  } catch (e) { console.error('welcome card failed:', e.message); return null; }
}

// ---- config (from environment) ----
const TOKEN = process.env.DISCORD_TOKEN;
const STREAM_URL = process.env.TMCAST_STREAM_URL || process.env.AZURACAST_STREAM_URL;            // e.g. https://cast.tmc.gg/listen/one/radio.mp3
const NOWPLAYING_URL = process.env.TMCAST_NOWPLAYING_URL || process.env.AZURACAST_NOWPLAYING_URL || ''; // e.g. https://cast.tmc.gg/api/np/one
const STATION_NAME = process.env.STATION_NAME || 'the radio';
const GUILD_ID = process.env.GUILD_ID || '';                   // optional: instant slash-command registration
const AUTOPLAY_CHANNEL_ID = process.env.AUTOPLAY_CHANNEL_ID || ''; // optional: auto-join + play on startup
const BITRATE = process.env.AUDIO_BITRATE || '96k';            // lower (e.g. 64k) to cut outbound bandwidth
const NOWPLAYING_CHANNEL = process.env.NOWPLAYING_CHANNEL || 'now-playing'; // channel name for the live card
const RADIO_LINK = process.env.RADIO_LINK || 'https://mavion.tmc.gg/radio'; // "Listen Live" button target
const APPEAL_URL = process.env.APPEAL_URL || 'https://tmc.gg/appeal'; // shown to banned/kicked users
// Roles allowed to use the moderation commands (plus anyone with Administrator). Comma-separated.
const MOD_ROLE_IDS = (process.env.MOD_ROLE_IDS || '1447075918089687090').split(',').map((s) => s.trim()).filter(Boolean);
const MOD_CMDS = new Set(['ban', 'kick', 'timeout', 'untimeout', 'warn', 'purge', 'slowmode']);
function isMod(member) {
  if (!member) return false;
  if (member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return MOD_ROLE_IDS.some((id) => member.roles && member.roles.cache && member.roles.cache.has(id));
}
const ACCENT = 0x7c4dff;

if (!TOKEN) { console.error('FATAL: DISCORD_TOKEN is not set.'); process.exit(1); }
if (!STREAM_URL) console.warn('Note: TMCAST_STREAM_URL not set — /play (radio) is disabled; admin + logging work normally.');
if (!ffmpegPath) console.warn('Note: ffmpeg-static unavailable — /play (radio) is disabled.');

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
  new SlashCommandBuilder().setName('roblox').setDescription('Look up a Roblox profile')
    .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true)),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
    .addUserOption((o) => o.setName('user').setDescription('Who to ban').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false))
    .addIntegerOption((o) => o.setName('delete_days').setDescription('Delete their messages from the last N days (0-7)').setRequired(false))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
    .addUserOption((o) => o.setName('user').setDescription('Who to kick').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('timeout').setDescription('Time a member out')
    .addUserOption((o) => o.setName('user').setDescription('Who to time out').setRequired(true))
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 30s, 10m, 1h, 1d (max 28d)').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member’s timeout')
    .addUserOption((o) => o.setName('user').setDescription('Who to un-timeout').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member (logged + DM’d)')
    .addUserOption((o) => o.setName('user').setDescription('Who to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('purge').setDescription('Bulk-delete recent messages in this channel')
    .addIntegerOption((o) => o.setName('count').setDescription('How many (1-100)').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('slowmode').setDescription('Set this channel’s slowmode')
    .addIntegerOption((o) => o.setName('seconds').setDescription('Seconds between messages (0 = off)').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('partner').setDescription('Manage partner listings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('add').setDescription('Add a partner to #partners')
      .addStringOption((o) => o.setName('name').setDescription('Partner name').setRequired(true))
      .addStringOption((o) => o.setName('invite').setDescription('Invite link / URL').setRequired(true))
      .addStringOption((o) => o.setName('description').setDescription('Short description').setRequired(false))
      .addStringOption((o) => o.setName('banner').setDescription('Banner image URL').setRequired(false)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a partner by exact name')
      .addStringOption((o) => o.setName('name').setDescription('Exact partner name').setRequired(true))),
  new SlashCommandBuilder().setName('ticket-panel').setDescription('Post an Apply / ticket panel in this channel')
    .addStringOption((o) => o.setName('title').setDescription('Panel title').setRequired(false))
    .addStringOption((o) => o.setName('description').setDescription('Panel text').setRequired(false))
    .addStringOption((o) => o.setName('button_label').setDescription('Button label').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false),
  new SlashCommandBuilder().setName('selfroles-panel').setDescription('Post a self-roles button panel in this channel')
    .addRoleOption((o) => o.setName('role').setDescription('Role 1').setRequired(true))
    .addStringOption((o) => o.setName('title').setDescription('Panel title').setRequired(false))
    .addRoleOption((o) => o.setName('role2').setDescription('Role 2').setRequired(false))
    .addRoleOption((o) => o.setName('role3').setDescription('Role 3').setRequired(false))
    .addRoleOption((o) => o.setName('role4').setDescription('Role 4').setRequired(false))
    .addRoleOption((o) => o.setName('role5').setDescription('Role 5').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false),
  new SlashCommandBuilder().setName('verify-panel').setDescription('Post a verify button that grants a role (anti-bot gate)')
    .addRoleOption((o) => o.setName('role').setDescription('Role to grant when they verify').setRequired(true))
    .addStringOption((o) => o.setName('title').setDescription('Panel title').setRequired(false))
    .addStringOption((o) => o.setName('description').setDescription('Panel text').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false),
  new SlashCommandBuilder().setName('testcard').setDescription('Preview the welcome card (test rendering)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false),
  new SlashCommandBuilder()
    .setName('staff-dm')
    .setDescription('DM everyone in a role an announcement')
    .addRoleOption((o) => o.setName('role').setDescription('Role to DM').setRequired(true))
    .addStringOption((o) => o.setName('message').setDescription('The announcement text').setRequired(true))
    .addRoleOption((o) => o.setName('also_role').setDescription('Optional second role to include').setRequired(false))
    .addStringOption((o) => o.setName('title').setDescription('Optional title for the announcement').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
].map((c) => c.toJSON());

// Discord requires required options before optional ones. Auto-reorder so a mistake
// can never reject the whole batch (which would leave commands un-updated).
function reorderRequired(cmd) {
  if (Array.isArray(cmd.options) && cmd.options.length) {
    const hasSub = cmd.options.some((o) => o.type === 1 || o.type === 2);
    if (hasSub) cmd.options.forEach((sub) => { if (Array.isArray(sub.options)) sub.options.sort((a, b) => (b.required === true) - (a.required === true)); });
    else cmd.options.sort((a, b) => (b.required === true) - (a.required === true));
  }
  return cmd;
}
async function registerCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map(reorderRequired);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body });
    // Wipe any leftover GLOBAL commands (e.g. stale ones from a previous bot that reused this app).
    try { await rest.put(Routes.applicationCommands(clientId), { body: [] }); } catch (e) {}
    console.log('Registered guild commands + cleared any stale global commands.');
  } else {
    // Global registration already REPLACES the full set, so old commands are wiped here too.
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log('Registered global commands (can take up to ~1 hour to appear).');
  }
}

// ---- command handlers ----
async function cmdPlay(interaction) {
  if (!STREAM_URL || !ffmpegPath) return interaction.reply({ content: 'Radio isn’t configured on this bot.', flags: MessageFlags.Ephemeral });
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
  const isLive = data.is_live ?? (typeof data.live === 'boolean' ? data.live : (data.live && data.live.is_live)) ?? false;
  const streamer = (data.live && typeof data.live === 'object' && data.live.streamer_name) || data.streamer_name;

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

async function robloxProfile(username) {
  const u = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  });
  const ud = await u.json();
  const hit = ud.data && ud.data[0];
  if (!hit) return null;
  const id = hit.id;
  const j = (url) => fetch(url, { headers: { accept: 'application/json' } }).then((r) => r.json()).catch(() => ({}));
  const [info, friends, followers, following, av] = await Promise.all([
    j(`https://users.roblox.com/v1/users/${id}`),
    j(`https://friends.roblox.com/v1/users/${id}/friends/count`),
    j(`https://friends.roblox.com/v1/users/${id}/followers/count`),
    j(`https://friends.roblox.com/v1/users/${id}/followings/count`),
    j(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=420x420&format=Png&isCircular=false`)
  ]);
  return {
    id,
    name: info.name || hit.name,
    displayName: info.displayName || hit.displayName || hit.name,
    description: info.description || '',
    created: info.created || null,
    friends: friends.count ?? null,
    followers: followers.count ?? null,
    following: following.count ?? null,
    avatar: (av.data && av.data[0] && av.data[0].imageUrl) || null
  };
}
async function cmdRoblox(interaction) {
  const username = interaction.options.getString('username');
  await interaction.deferReply();
  const p = await robloxProfile(username).catch(() => null);
  if (!p) return interaction.editReply(`Couldn't find a Roblox user named **${username}**.`);
  const created = p.created ? new Date(p.created) : null;
  const ageDays = created ? Math.floor((Date.now() - created.getTime()) / 86400000) : null;
  const profileUrl = `https://www.roblox.com/users/${p.id}/profile`;
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: '🟦 Roblox Profile' })
    .setTitle(`${p.displayName} (@${p.name})`)
    .setURL(profileUrl)
    .addFields(
      { name: 'Friends', value: `${p.friends ?? '—'}`, inline: true },
      { name: 'Following', value: `${p.following ?? '—'}`, inline: true },
      { name: 'Followers', value: `${p.followers ?? '—'}`, inline: true },
      { name: 'Joined', value: created ? `<t:${Math.floor(created.getTime() / 1000)}:D>` : '—', inline: true },
      { name: 'Account age', value: ageDays != null ? `${ageDays} days` : '—', inline: true },
      { name: 'ID', value: `${p.id}`, inline: true }
    )
    .setFooter({ text: 'Roblox · TMC' });
  if (p.description) e.setDescription(cut(p.description, 400));
  if (p.avatar) e.setThumbnail(p.avatar);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('View Profile').setStyle(ButtonStyle.Link).setURL(profileUrl)
  );
  return interaction.editReply({ embeds: [e], components: [row] });
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

// ---- moderation + community commands ----
// Suppress duplicate logs: a command marks its action so the gateway event handler skips it.
const recentActions = new Set();
function markAction(key) { recentActions.add(key); setTimeout(() => recentActions.delete(key), 10000); }
function wasRecent(key) { if (recentActions.has(key)) { recentActions.delete(key); return true; } return false; }

function parseDuration(str) {
  const m = String(str || '').trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) return null;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || 'm').toLowerCase()];
  return parseInt(m[1], 10) * mult;
}
function modLog(guild, color, title, target, mod, reason, extraField) {
  const e = logEmbed(color, title, target).setDescription(`<@${target.id}>`)
    .addFields(
      { name: 'Moderator', value: mod ? `<@${mod.id}>` : 'Unknown', inline: true },
      { name: 'Reason', value: reason || 'No reason given', inline: true }
    );
  if (extraField) e.addFields(extraField);
  sendLog(guild, LOG.mod, e);
}
// DM the punished user (best-effort) with the reason and, optionally, the appeal link.
async function dmPunish(user, title, bodyLine, reason, color, appeal) {
  try {
    const e = new EmbedBuilder().setColor(color).setTitle(title).setDescription(bodyLine)
      .addFields({ name: 'Reason', value: reason || 'No reason given' });
    if (appeal) e.addFields({ name: '📩 Appeal', value: `Think this was a mistake? Submit an appeal here:\n${APPEAL_URL}` });
    await user.send({ embeds: [e] });
    return true;
  } catch (e) { console.error(`DM to ${user && user.id} failed:`, e.message); return false; }
}
// Ban + DM a "click to unban" button (a banned real user can still click it in DMs;
// an automated/stolen-account script won't). DM is sent before the ban so it lands.
async function banWithUnbanButton(guild, user, reason) {
  let dmed = false;
  try {
    const e = new EmbedBuilder().setColor(0x8b0000).setTitle('🔨 You were banned')
      .setDescription(`You were auto-banned from **${guild.name}** for suspected spam.\n\nIf you're a **real person**, click the button below and you'll be unbanned right away.`)
      .addFields({ name: 'Reason', value: reason || 'Suspected spam' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`unban:${guild.id}`).setLabel("I'm human — unban me").setEmoji('✅').setStyle(ButtonStyle.Success)
    );
    await user.send({ embeds: [e], components: [row] });
    dmed = true;
  } catch (e) { console.error(`unban-DM to ${user && user.id} failed:`, e.message); }
  try { await guild.bans.create(user.id, { reason: reason || 'Automod: suspected spam' }); } catch (e) { console.error('auto-ban failed:', e.message); }
  return dmed;
}

async function cmdBan(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason given';
  const days = Math.min(7, Math.max(0, interaction.options.getInteger('delete_days') || 0));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const dmed = await dmPunish(user, '🔨 You were banned', `You have been banned from **${interaction.guild.name}**.`, reason, 0x8b0000, true);
  try {
    markAction('ban:' + user.id);
    await interaction.guild.bans.create(user.id, { reason: `${reason} — by ${interaction.user.tag}`, deleteMessageSeconds: days * 86400 });
    modLog(interaction.guild, 0x8b0000, '🔨 Member Banned', user, interaction.user, reason);
    return interaction.editReply(`🔨 Banned **${user.tag}** — ${reason}${dmed ? ' · DM sent' : ' · (couldn’t DM)'}`);
  } catch (e) { recentActions.delete('ban:' + user.id); return interaction.editReply(`Couldn't ban: ${e.message}`); }
}
async function cmdKick(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason given';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const dmed = await dmPunish(user, '👢 You were kicked', `You have been kicked from **${interaction.guild.name}**.`, reason, 0xe5484d, true);
  try {
    markAction('kick:' + user.id);
    await interaction.guild.members.kick(user.id, `${reason} — by ${interaction.user.tag}`);
    modLog(interaction.guild, 0xe5484d, '👢 Member Kicked', user, interaction.user, reason);
    return interaction.editReply(`👢 Kicked **${user.tag}** — ${reason}${dmed ? ' · DM sent' : ' · (couldn’t DM)'}`);
  } catch (e) { recentActions.delete('kick:' + user.id); return interaction.editReply(`Couldn't kick: ${e.message}`); }
}
async function cmdTimeout(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason given';
  const ms = parseDuration(interaction.options.getString('duration'));
  if (!ms || ms > 28 * 86400000) return interaction.reply({ content: 'Use a duration like `30s`, `10m`, `1h`, `1d` (max 28d).', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const dmed = await dmPunish(user, '⏳ You were timed out', `You have been timed out in **${interaction.guild.name}** for ${interaction.options.getString('duration')}.`, reason, 0xb06d00, false);
  try {
    const member = await interaction.guild.members.fetch(user.id);
    markAction('timeout:' + user.id);
    await member.timeout(ms, `${reason} — by ${interaction.user.tag}`);
    modLog(interaction.guild, 0xb06d00, '⏳ Member Timed Out', user, interaction.user, reason, { name: 'Duration', value: interaction.options.getString('duration'), inline: true });
    return interaction.editReply(`⏳ Timed out **${user.tag}** for ${interaction.options.getString('duration')} — ${reason}${dmed ? ' · DM sent' : ''}`);
  } catch (e) { recentActions.delete('timeout:' + user.id); return interaction.editReply(`Couldn't time out: ${e.message}`); }
}
async function cmdUntimeout(interaction) {
  const user = interaction.options.getUser('user');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const member = await interaction.guild.members.fetch(user.id);
    markAction('timeout:' + user.id);
    await member.timeout(null, `by ${interaction.user.tag}`);
    modLog(interaction.guild, 0x0a9d6c, '⏳ Timeout Removed', user, interaction.user, 'Manual removal');
    return interaction.editReply(`Removed timeout on **${user.tag}**.`);
  } catch (e) { recentActions.delete('timeout:' + user.id); return interaction.editReply(`Couldn't remove timeout: ${e.message}`); }
}
async function cmdWarn(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  modLog(interaction.guild, 0xf5a623, '⚠️ Member Warned', user, interaction.user, reason);
  let dm = '';
  try { await user.send(`⚠️ You were warned in **${interaction.guild.name}**: ${reason}`); } catch (e) { console.error('warn DM failed:', e.message); dm = ' (couldn’t DM them)'; }
  return interaction.editReply(`⚠️ Warned **${user.tag}** — ${reason}${dm}`);
}
async function cmdPurge(interaction) {
  const count = Math.min(100, Math.max(1, interaction.options.getInteger('count')));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const deleted = await interaction.channel.bulkDelete(count, true);
    return interaction.editReply(`🧹 Deleted ${deleted.size} message(s). (Messages older than 14 days can’t be bulk-deleted.)`);
  } catch (e) { return interaction.editReply(`Couldn't purge: ${e.message}`); }
}
async function cmdSlowmode(interaction) {
  const sec = Math.min(21600, Math.max(0, interaction.options.getInteger('seconds')));
  try {
    await interaction.channel.setRateLimitPerSecond(sec, `by ${interaction.user.tag}`);
    return interaction.reply({ content: sec ? `🐌 Slowmode set to ${sec}s.` : 'Slowmode turned off.', flags: MessageFlags.Ephemeral });
  } catch (e) { return interaction.reply({ content: `Couldn't set slowmode: ${e.message}`, flags: MessageFlags.Ephemeral }); }
}

async function cmdPartner(interaction) {
  const channel = logChannel(interaction.guild, 'partners');
  if (!channel) return interaction.reply({ content: 'Create a channel named **#partners** first.', flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') {
    const name = interaction.options.getString('name');
    let invite = interaction.options.getString('invite');
    if (!/^https?:\/\//i.test(invite)) invite = 'https://' + invite;
    const desc = interaction.options.getString('description') || '';
    const banner = interaction.options.getString('banner');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const e = new EmbedBuilder().setColor(ACCENT).setTitle(`🤝 ${name}`).setDescription(desc || '​').setFooter({ text: 'Partner of TMC' }).setTimestamp();
    if (banner) e.setImage(banner);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Join').setStyle(ButtonStyle.Link).setURL(invite));
    try { await channel.send({ embeds: [e], components: [row] }); }
    catch (err) { return interaction.editReply(`Couldn't post (is the invite a valid URL?): ${err.message}`); }
    return interaction.editReply(`Added partner **${name}** to ${channel}.`);
  }
  const name = interaction.options.getString('name');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const msgs = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const hit = msgs && msgs.find((m) => m.author.id === client.user.id && m.embeds[0] && m.embeds[0].title === `🤝 ${name}`);
  if (!hit) return interaction.editReply(`No partner titled **${name}** found in ${channel}.`);
  await hit.delete().catch(() => {});
  return interaction.editReply(`Removed partner **${name}**.`);
}

async function cmdTicketPanel(interaction) {
  const title = interaction.options.getString('title') || '📋 Apply / Support';
  const desc = interaction.options.getString('description') || 'Click the button below to open a private ticket with the staff team.';
  const label = interaction.options.getString('button_label') || 'Open a Ticket';
  const e = new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription(desc).setFooter({ text: 'TMC' });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_open').setLabel(label).setEmoji('🎫').setStyle(ButtonStyle.Primary));
  await interaction.channel.send({ embeds: [e], components: [row] });
  return interaction.reply({ content: 'Ticket panel posted.', flags: MessageFlags.Ephemeral });
}

async function cmdSelfroles(interaction) {
  const title = interaction.options.getString('title') || '🎭 Self Roles';
  const roles = [];
  for (const k of ['role', 'role2', 'role3', 'role4', 'role5']) { const r = interaction.options.getRole(k); if (r) roles.push(r); }
  if (!roles.length) return interaction.reply({ content: 'Add at least one role.', flags: MessageFlags.Ephemeral });
  const e = new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription('Click a button to toggle a role on yourself.');
  const row = new ActionRowBuilder().addComponents(roles.slice(0, 5).map((r) => new ButtonBuilder().setCustomId(`selfrole_${r.id}`).setLabel(r.name).setStyle(ButtonStyle.Secondary)));
  await interaction.channel.send({ embeds: [e], components: [row] });
  return interaction.reply({ content: 'Self-roles panel posted.', flags: MessageFlags.Ephemeral });
}

async function cmdVerifyPanel(interaction) {
  const role = interaction.options.getRole('role');
  const title = interaction.options.getString('title') || '✅ Verify yourself';
  const desc = interaction.options.getString('description') || 'Click the button below to verify you’re human and unlock the rest of the server. Bots can’t click it.';
  const e = new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription(desc).setFooter({ text: 'TMC' });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`verify_${role.id}`).setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success));
  await interaction.channel.send({ embeds: [e], components: [row] });
  return interaction.reply({ content: `Verification panel posted — clicking it grants <@&${role.id}>.`, flags: MessageFlags.Ephemeral });
}

async function cmdTestcard(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!Canvas) return interaction.editReply('Canvas isn’t available here — welcome would use the embed fallback.');
  const buf = await makeWelcomeCard(interaction.member);
  if (!buf) return interaction.editReply('Card render returned nothing — check the logs for "welcome card failed".');
  return interaction.editReply({ content: '🖼️ Welcome card preview:', files: [new AttachmentBuilder(buf, { name: 'welcome.png' })] });
}

async function handleButton(interaction) {
  const id = interaction.customId;
  if (id === 'ticket_open') {
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) return interaction.reply({ content: 'Tickets must be opened from a normal text channel.', flags: MessageFlags.Ephemeral });
    const thread = await ch.threads.create({ name: `ticket-${interaction.user.username}`.slice(0, 90), type: ChannelType.PrivateThread, invitable: false, reason: 'Ticket opened' }).catch(() => null);
    if (!thread) return interaction.reply({ content: 'Couldn’t create a ticket — I need Manage Threads / Create Private Threads here.', flags: MessageFlags.Ephemeral });
    await thread.members.add(interaction.user.id).catch(() => {});
    const e = new EmbedBuilder().setColor(ACCENT).setTitle('🎫 Ticket opened')
      .setDescription(`Hi <@${interaction.user.id}> — a staff member will be with you shortly. Tell us what you need below.`);
    const closeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger));
    await thread.send({ content: `<@${interaction.user.id}>`, embeds: [e], components: [closeRow] });
    return interaction.reply({ content: `Your ticket: ${thread}`, flags: MessageFlags.Ephemeral });
  }
  if (id === 'ticket_close') {
    if (!interaction.channel?.isThread?.()) return interaction.reply({ content: 'This isn’t a ticket.', flags: MessageFlags.Ephemeral });
    await interaction.reply({ content: `🔒 Ticket closed by <@${interaction.user.id}>.` });
    await interaction.channel.setLocked(true).catch(() => {});
    await interaction.channel.setArchived(true).catch(() => {});
    return;
  }
  if (id.startsWith('selfrole_')) {
    const roleId = id.slice('selfrole_'.length);
    const member = interaction.member;
    const has = member.roles.cache.has(roleId);
    try {
      if (has) await member.roles.remove(roleId); else await member.roles.add(roleId);
      return interaction.reply({ content: has ? `Removed <@&${roleId}>` : `Added <@&${roleId}>`, flags: MessageFlags.Ephemeral });
    } catch (e) { return interaction.reply({ content: 'Couldn’t change that role — make sure my role is above it.', flags: MessageFlags.Ephemeral }); }
  }
  if (id.startsWith('verify_')) {
    const roleId = id.slice('verify_'.length);
    const member = interaction.member;
    if (member.roles.cache.has(roleId)) return interaction.reply({ content: 'You’re already verified ✅', flags: MessageFlags.Ephemeral });
    try { await member.roles.add(roleId); return interaction.reply({ content: 'Verified — welcome in! ✅', flags: MessageFlags.Ephemeral }); }
    catch (e) { return interaction.reply({ content: 'Couldn’t verify you — a staff member needs to move my role above the verified role.', flags: MessageFlags.Ephemeral }); }
  }
  if (id.startsWith('unban:')) {
    // a banned (real) user clicked "I'm human" in their DM — unban them from that guild
    const guildId = id.slice('unban:'.length);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return interaction.reply({ content: 'That server isn’t available anymore.', flags: MessageFlags.Ephemeral });
    try {
      await guild.bans.remove(interaction.user.id, 'Self-unban via human verification');
      return interaction.reply({ content: `✅ You’ve been unbanned from **${guild.name}**. You can rejoin now — please don’t spam.`, flags: MessageFlags.Ephemeral });
    } catch (e) { return interaction.reply({ content: 'Couldn’t unban you (you may not be banned, or staff removed the option). Contact a staff member.', flags: MessageFlags.Ephemeral }); }
  }
}

// ---- wiring ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,    // privileged — "Server Members Intent"
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // privileged — "Message Content Intent"
    GatewayIntentBits.GuildModeration  // ban / unban events
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User]
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try { await registerCommands(c.user.id); } catch (e) { console.error('Command registration failed:', e.message); }

  if (AUTOPLAY_CHANNEL_ID && STREAM_URL) {
    try {
      const ch = await c.channels.fetch(AUTOPLAY_CHANNEL_ID);
      if (ch && ch.isVoiceBased()) { await connectAndPlay(ch); console.log(`Auto-joined ${ch.name}.`); }
      else console.error('AUTOPLAY_CHANNEL_ID is not a voice channel.');
    } catch (e) { console.error('Autoplay failed:', e.message); }
  }

  startNowPlaying();

  // startup diagnostics — shows WHY cards/logs might not appear
  console.log('Welcome-card canvas:', Canvas ? 'loaded ✓' : 'NOT loaded (welcome falls back to embed)');
  for (const g of c.guilds.cache.values()) {
    const names = ['welcome', 'now-playing', 'partners', 'msg-logs', 'mod-logs', 'role-logs', 'user-logs', 'vc-logs'];
    const found = names.filter((n) => logChannel(g, n));
    const me = g.members.me;
    console.log(`[${g.name}] card/log channels found: ${found.join(', ') || 'NONE — channel names must match exactly'}`);
    console.log(`[${g.name}] my perms: Admin=${!!(me && me.permissions.has(PermissionFlagsBits.Administrator))} Send=${!!(me && me.permissions.has(PermissionFlagsBits.SendMessages))} Embed=${!!(me && me.permissions.has(PermissionFlagsBits.EmbedLinks))} Attach=${!!(me && me.permissions.has(PermissionFlagsBits.AttachFiles))}`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) return await handleButton(interaction);
    if (!interaction.isChatInputCommand()) return;
    const n = interaction.commandName;
    if (MOD_CMDS.has(n) && !isMod(interaction.member)) {
      return interaction.reply({ content: 'You don’t have permission to use this command.', flags: MessageFlags.Ephemeral });
    }
    if (n === 'play') return await cmdPlay(interaction);
    if (n === 'stop') return await cmdStop(interaction);
    if (n === 'nowplaying') return await cmdNowPlaying(interaction);
    if (n === 'roblox') return await cmdRoblox(interaction);
    if (n === 'staff-dm') return await cmdStaffDm(interaction);
    if (n === 'ban') return await cmdBan(interaction);
    if (n === 'kick') return await cmdKick(interaction);
    if (n === 'timeout') return await cmdTimeout(interaction);
    if (n === 'untimeout') return await cmdUntimeout(interaction);
    if (n === 'warn') return await cmdWarn(interaction);
    if (n === 'purge') return await cmdPurge(interaction);
    if (n === 'slowmode') return await cmdSlowmode(interaction);
    if (n === 'partner') return await cmdPartner(interaction);
    if (n === 'ticket-panel') return await cmdTicketPanel(interaction);
    if (n === 'selfroles-panel') return await cmdSelfroles(interaction);
    if (n === 'verify-panel') return await cmdVerifyPanel(interaction);
    if (n === 'testcard') return await cmdTestcard(interaction);
  } catch (e) {
    console.error('interaction error:', e);
    const payload = { content: '⚠️ ' + (e.message || 'Something went wrong.'), flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  }
});

// ---- server logging ----
// Routes each event to the right channel BY NAME — no channel IDs to configure.
const LOG = { msg: 'msg-logs', mod: 'mod-logs', role: 'role-logs', user: 'user-logs', vc: 'vc-logs' };

function logChannel(guild, name) {
  if (!guild) return null;
  return guild.channels.cache.find((c) => c.name === name && c.isTextBased()) || null;
}
async function sendLog(guild, name, embed) {
  const ch = logChannel(guild, name);
  if (!ch) return; // channel doesn't exist -> silently skip
  try { await ch.send({ embeds: [embed] }); } catch (e) {}
}
const cut = (s, n = 1024) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));
const rel = (ts) => (ts ? `<t:${Math.floor(ts / 1000)}:R>` : '—');
const full = (ts) => (ts ? `<t:${Math.floor(ts / 1000)}:F>` : '—');

// Base embed: avatar header + thumbnail (card look), copyable User ID in the footer.
function logEmbed(color, title, user) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (user) {
    const av = user.displayAvatarURL ? user.displayAvatarURL() : null;
    e.setAuthor({ name: user.tag || user.username || 'Unknown', iconURL: av || undefined });
    if (av) e.setThumbnail(av);
    if (user.id) e.setFooter({ text: `User ID: ${user.id}` });
  }
  return e;
}
async function findExecutor(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    return logs.entries.find((e) => e.target?.id === targetId && Date.now() - e.createdTimestamp < 8000) || null;
  } catch { return null; }
}

// messages -> msg-logs
client.on(Events.MessageDelete, (msg) => {
  if (!msg.guild || msg.author?.bot) return;
  const e = logEmbed(0xe5484d, '🗑️ Message Deleted', msg.author)
    .setDescription(cut(msg.content) || '*No text (embed, sticker, or not cached).*')
    .addFields(
      { name: 'Author', value: msg.author ? `<@${msg.author.id}>` : 'Unknown', inline: true },
      { name: 'Channel', value: `<#${msg.channelId}>`, inline: true },
      { name: 'Sent', value: rel(msg.createdTimestamp), inline: true }
    )
    .setFooter({ text: `Author: ${msg.author?.id || '?'} • Message: ${msg.id}` });
  sendLog(msg.guild, LOG.msg, e);
});
client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.author?.bot) return;
  if ((oldMsg.content || '') === (newMsg.content || '')) return;
  const e = logEmbed(0xf5a623, '✏️ Message Edited', newMsg.author).addFields(
    { name: 'Before', value: cut(oldMsg.content) || '*(not cached)*' },
    { name: 'After', value: cut(newMsg.content) || '*(empty)*' },
    { name: 'Channel', value: `<#${newMsg.channelId}>`, inline: true }
  ).setFooter({ text: `Author: ${newMsg.author?.id || '?'} • Message: ${newMsg.id}` });
  if (newMsg.url) e.setURL(newMsg.url);
  sendLog(newMsg.guild, LOG.msg, e);
});
client.on(Events.MessageBulkDelete, (messages) => {
  const first = messages.first();
  if (!first?.guild) return;
  sendLog(first.guild, LOG.msg, new EmbedBuilder().setColor(0xe5484d).setTitle('🧹 Messages Purged').setTimestamp()
    .setDescription(`**${messages.size}** messages were bulk-deleted in <#${first.channelId}>.`));
});

// joins / leaves / kicks
client.on(Events.GuildMemberAdd, (m) => {
  sendLog(m.guild, LOG.user, logEmbed(0x0a9d6c, '📥 Member Joined', m.user)
    .setDescription(`<@${m.id}> joined — member **#${m.guild.memberCount}**.`)
    .addFields({ name: 'Account Created', value: `${full(m.user.createdTimestamp)} (${rel(m.user.createdTimestamp)})` }));
  // welcome message in #welcome (if it exists)
  const wc = logChannel(m.guild, 'welcome');
  if (wc) {
    const w = new EmbedBuilder().setColor(0x0a9d6c).setTitle(`👋 Welcome to ${m.guild.name}!`)
      .setDescription(`Hey <@${m.id}>, glad you're here — you're member **#${m.guild.memberCount}**! 🎉`)
      .setThumbnail(m.user.displayAvatarURL());
    wc.send({ content: `<@${m.id}>`, embeds: [w] }).catch(() => {});
  }
});
client.on(Events.GuildMemberRemove, async (m) => {
  if (wasRecent('kick:' + m.id)) return; // already logged by /kick
  const kick = await findExecutor(m.guild, AuditLogEvent.MemberKick, m.id);
  if (kick) {
    sendLog(m.guild, LOG.mod, logEmbed(0xe5484d, '👢 Member Kicked', m.user)
      .setDescription(`<@${m.id}>`)
      .addFields(
        { name: 'Moderator', value: kick.executor ? `<@${kick.executor.id}>` : 'Unknown', inline: true },
        { name: 'Reason', value: kick.reason || 'No reason given', inline: true }
      ));
  } else {
    const roles = m.roles?.cache?.filter((r) => r.id !== m.guild.id).map((r) => `<@&${r.id}>`).join(' ');
    sendLog(m.guild, LOG.user, logEmbed(0x99662b, '📤 Member Left', m.user)
      .setDescription(`<@${m.id}> left the server.`)
      .addFields(
        { name: 'Joined', value: rel(m.joinedTimestamp), inline: true },
        { name: 'Roles', value: cut(roles) || '—' }
      ));
  }
});

// bans -> mod-logs
client.on(Events.GuildBanAdd, async (ban) => {
  if (wasRecent('ban:' + ban.user.id)) return; // already logged by /ban
  const entry = await findExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  sendLog(ban.guild, LOG.mod, logEmbed(0x8b0000, '🔨 Member Banned', ban.user)
    .setDescription(`<@${ban.user.id}>`)
    .addFields(
      { name: 'Moderator', value: entry?.executor ? `<@${entry.executor.id}>` : 'Unknown', inline: true },
      { name: 'Reason', value: entry?.reason || ban.reason || 'No reason given', inline: true }
    ));
});
client.on(Events.GuildBanRemove, async (ban) => {
  const entry = await findExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
  sendLog(ban.guild, LOG.mod, logEmbed(0x0a9d6c, '♻️ Member Unbanned', ban.user)
    .setDescription(`<@${ban.user.id}>`)
    .addFields({ name: 'Moderator', value: entry?.executor ? `<@${entry.executor.id}>` : 'Unknown', inline: true }));
});

// roles, nickname, timeout -> role-logs / user-logs / mod-logs
client.on(Events.GuildMemberUpdate, (oldM, newM) => {
  const before = oldM.roles.cache, after = newM.roles.cache;
  const added = after.filter((r) => !before.has(r.id));
  const removed = before.filter((r) => !after.has(r.id));
  if (added.size || removed.size) {
    const color = added.size && !removed.size ? 0x0a9d6c : (removed.size && !added.size ? 0xe5484d : 0x5865f2);
    const e = logEmbed(color, '🎭 Roles Updated', newM.user).setDescription(`<@${newM.id}>`);
    if (added.size) e.addFields({ name: `✅ Added (${added.size})`, value: cut(added.map((r) => `<@&${r.id}>`).join(' ')) });
    if (removed.size) e.addFields({ name: `❌ Removed (${removed.size})`, value: cut(removed.map((r) => `<@&${r.id}>`).join(' ')) });
    sendLog(newM.guild, LOG.role, e);
  }
  if ((oldM.nickname || '') !== (newM.nickname || '')) {
    sendLog(newM.guild, LOG.user, logEmbed(0x5865f2, '🏷️ Nickname Changed', newM.user).addFields(
      { name: 'Before', value: oldM.nickname || '*(none)*', inline: true },
      { name: 'After', value: newM.nickname || '*(none)*', inline: true }
    ));
  }
  const oldTo = oldM.communicationDisabledUntilTimestamp || 0;
  const newTo = newM.communicationDisabledUntilTimestamp || 0;
  if (oldTo !== newTo && !wasRecent('timeout:' + newM.id)) {
    if (newTo > Date.now()) {
      sendLog(newM.guild, LOG.mod, logEmbed(0xb06d00, '⏳ Member Timed Out', newM.user)
        .setDescription(`<@${newM.id}>`)
        .addFields({ name: 'Until', value: `${full(newTo)} (${rel(newTo)})` }));
    } else {
      sendLog(newM.guild, LOG.mod, logEmbed(0x0a9d6c, '⏳ Timeout Removed', newM.user).setDescription(`<@${newM.id}>`));
    }
  }
});

// voice activity -> vc-logs (with live channel headcount)
client.on(Events.VoiceStateUpdate, (oldS, newS) => {
  const member = newS.member || oldS.member;
  if (!member || member.user.bot) return;
  let e;
  if (!oldS.channelId && newS.channelId) {
    e = logEmbed(0x0a9d6c, '🔊 Joined Voice', member.user).addFields(
      { name: 'Channel', value: `<#${newS.channelId}>`, inline: true },
      { name: 'In channel', value: `${newS.channel?.members?.size ?? '?'}`, inline: true }
    );
  } else if (oldS.channelId && !newS.channelId) {
    e = logEmbed(0xe5484d, '🔇 Left Voice', member.user).addFields(
      { name: 'Channel', value: `<#${oldS.channelId}>`, inline: true },
      { name: 'In channel', value: `${oldS.channel?.members?.size ?? '?'}`, inline: true }
    );
  } else if (oldS.channelId !== newS.channelId) {
    e = logEmbed(0x5865f2, '🔀 Moved Voice', member.user).addFields(
      { name: 'From', value: `<#${oldS.channelId}>`, inline: true },
      { name: 'To', value: `<#${newS.channelId}>`, inline: true }
    );
  } else return;
  sendLog(newS.guild, LOG.vc, e);
});

// role create / delete -> role-logs
client.on(Events.GuildRoleCreate, (role) => sendLog(role.guild, LOG.role, new EmbedBuilder().setColor(0x0a9d6c).setTitle('➕ Role Created').setTimestamp().setDescription(`<@&${role.id}> · \`${role.name}\``).setFooter({ text: `Role ID: ${role.id}` })));
client.on(Events.GuildRoleDelete, (role) => sendLog(role.guild, LOG.role, new EmbedBuilder().setColor(0xe5484d).setTitle('➖ Role Deleted').setTimestamp().setDescription(`\`${role.name}\``).setFooter({ text: `Role ID: ${role.id}` })));

// ---- automod ----
const AUTOMOD = process.env.AUTOMOD !== 'off'; // on by default; set AUTOMOD=off to disable
const LINK_RE = /(https?:\/\/|www\.|discord(?:app)?\.com\/invite\/|discord\.gg\/|dsc\.gg\/|\b[a-z0-9-]+\.[a-z]{2,}\/\S+)/i;
// Severe slurs blocked by default; add your own (comma-separated) via the BADWORDS env var.
const DEFAULT_BADWORDS = ['nigger', 'nigga', 'faggot', 'fag', 'kike', 'spic', 'chink', 'tranny', 'retard'];
const BADWORDS = [...DEFAULT_BADWORDS, ...((process.env.BADWORDS || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean))];
function leet(s) {
  return (s || '').toLowerCase()
    .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't');
}
const BAD_RES = BADWORDS.map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
function hasBadWord(text) { const t = leet(text); return BAD_RES.some((re) => re.test(t)); }
function isStaffMember(member) { return !!(member && member.permissions && member.permissions.has(PermissionFlagsBits.ManageMessages)); }
const imgSpam = new Map(); // userId -> [{ at, msg }]

function automodLog(msg, reason, color) {
  modLog(msg.guild, color, '🤖 Automod', msg.author, client.user, reason, { name: 'Channel', value: `<#${msg.channelId}>`, inline: true });
}
function automodNotice(msg, text) {
  msg.channel.send({ content: `<@${msg.author.id}> ${text}` })
    .then((m) => setTimeout(() => m.delete().catch(() => {}), 6000)).catch(() => {});
}

client.on(Events.MessageCreate, async (msg) => {
  if (!AUTOMOD || !msg.guild || msg.author.bot || !msg.member) return;
  if (isStaffMember(msg.member)) return; // staff are exempt from automod

  // 1) severe slurs / inappropriate language
  if (BAD_RES.length && hasBadWord(msg.content)) {
    await msg.delete().catch(() => {});
    automodLog(msg, 'Inappropriate language', 0xe5484d);
    automodNotice(msg, 'that language isn’t allowed here.');
    return;
  }
  // 2) links — members can't post them, only staff
  if (LINK_RE.test(msg.content)) {
    await msg.delete().catch(() => {});
    automodLog(msg, 'Posted a link (links are staff-only)', 0xe5484d);
    automodNotice(msg, 'links are staff-only here.');
    return;
  }
  // 3) image spam from a NEW account (classic raid-bot pattern)
  const hasImage = msg.attachments.some((a) => (a.contentType && a.contentType.startsWith('image/')) || /\.(png|jpe?g|gif|webp)$/i.test(a.name || ''));
  if (hasImage && (Date.now() - msg.author.createdTimestamp) < 14 * 86400000) {
    const arr = (imgSpam.get(msg.author.id) || []).filter((e) => Date.now() - e.at < 20000);
    arr.push({ at: Date.now(), msg });
    imgSpam.set(msg.author.id, arr);
    if (arr.length >= 4) {
      imgSpam.delete(msg.author.id);
      for (const e of arr) e.msg.delete().catch(() => {});
      const dmed = await banWithUnbanButton(msg.guild, msg.author, 'Suspected spam (rapid images from a new account)');
      automodLog(msg, `Suspected spam raid — banned${dmed ? " + DM'd an unban button" : " (couldn't DM)"}`, 0x8b0000);
    }
  }
});

// ---- live "now playing" card ----
// Maintains ONE auto-updating embed in the #now-playing channel (found by name).
const npMessages = new Map(); // guildId -> Message

function fmtTime(s) { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function progressBar(elapsed, duration, len = 18) {
  if (!duration || duration <= 0) return '';
  const pos = Math.min(len, Math.max(0, Math.round((elapsed / duration) * len)));
  return `${fmtTime(elapsed)} ${'─'.repeat(pos)}🔘${'─'.repeat(len - pos)} ${fmtTime(duration)}`;
}
function parseNP(data) {
  if (Array.isArray(data)) data = data[0] || {};
  const npRaw = data.now_playing || {};
  const song = npRaw.song || npRaw; // nested (AzuraCast) or flat (TMCast)
  const hist = (data.song_history || data.history || data.recently_played || []).map((h) => {
    const s = h.song || h;
    return { title: s.title || 'Unknown', artist: s.artist || '' };
  }).slice(0, 5);
  return {
    title: song.title || 'Unknown',
    artist: song.artist || '',
    album: song.album || '',
    art: song.artwork_url || song.art || (data.station && data.station.logo_url) || null,
    duration: npRaw.duration || song.duration || 0,
    elapsed: npRaw.elapsed || song.elapsed || 0,
    station: (data.station && data.station.name) || 'Mavion Radio',
    listeners: typeof data.listeners === 'number' ? data.listeners : (data.listeners && (data.listeners.current ?? data.listeners.total)),
    isLive: data.is_live ?? (typeof data.live === 'boolean' ? data.live : (data.live && data.live.is_live)) ?? false,
    streamer: (data.live && typeof data.live === 'object' && data.live.streamer_name) || data.streamer_name || null,
    hist
  };
}
function npEmbed(np) {
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: `${np.isLive ? '🔴 LIVE' : '🎵 Now Playing'}  ·  ${np.station}` })
    .setTitle(np.title)
    .setTimestamp();
  const lines = [];
  if (np.artist) lines.push(`by **${np.artist}**`);
  if (np.album) lines.push(`*${np.album}*`);
  const bar = progressBar(np.elapsed, np.duration);
  if (bar) lines.push('```' + bar + '```');
  e.setDescription(lines.join('\n') || '​');
  if (np.art) e.setThumbnail(np.art);
  const meta = [];
  if (np.isLive && np.streamer) meta.push(`🎙️ ${np.streamer}`);
  if (np.listeners != null) meta.push(`👥 ${np.listeners} listening`);
  if (meta.length) e.addFields({ name: '​', value: meta.join('       ') });
  if (np.hist.length) {
    e.addFields({ name: '⏮️  Recently played', value: np.hist.map((h) => `\`•\` **${h.title}**${h.artist ? ` — ${h.artist}` : ''}`).join('\n').slice(0, 1024) });
  }
  e.setFooter({ text: 'Live · updates automatically' });
  return e;
}
function npRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🎧 Listen Live').setStyle(ButtonStyle.Link).setURL(RADIO_LINK)
  );
}
// Components V2 container — the modern card layout.
function npComponents(np) {
  const c = new ContainerBuilder().setAccentColor(ACCENT);
  const head = `### ${np.isLive ? '🔴 LIVE' : '🎵 Now Playing'} · ${np.station}\n## ${np.title}${np.artist ? `\n*by ${np.artist}*` : ''}`;
  if (np.art) {
    c.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(head))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(np.art))
    );
  } else {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(head));
  }
  const meta = [];
  const bar = progressBar(np.elapsed, np.duration);
  if (bar) meta.push('`' + bar + '`');
  const sub = [];
  if (np.isLive && np.streamer) sub.push(`🎙️ ${np.streamer}`);
  if (np.listeners != null) sub.push(`👥 ${np.listeners} listening`);
  if (sub.length) meta.push(sub.join('    ·    '));
  if (meta.length) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(meta.join('\n')));
  if (np.hist.length) {
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent('**Recently played**\n' + np.hist.map((h) => `\`•\` ${h.title}${h.artist ? ` — ${h.artist}` : ''}`).join('\n')));
  }
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🎧 Listen Live').setStyle(ButtonStyle.Link).setURL(RADIO_LINK)
  ));
  return c;
}
async function updateNowPlaying(guild, np) {
  const channel = logChannel(guild, NOWPLAYING_CHANNEL);
  if (!channel) return;
  let msg = npMessages.get(guild.id);
  if (!msg) {
    const recent = await channel.messages.fetch({ limit: 10 }).catch(() => null);
    msg = (recent && recent.find((m) => m.author.id === client.user.id && (m.components.length || m.embeds.length))) || null;
  }
  try {
    if (msg && msg.flags && msg.flags.has(MessageFlags.IsComponentsV2)) {
      await msg.edit({ components: [npComponents(np)] });
    } else {
      if (msg) await msg.delete().catch(() => {}); // replace an old (embed) card with the V2 one
      msg = await channel.send({ flags: MessageFlags.IsComponentsV2, components: [npComponents(np)] });
    }
    npMessages.set(guild.id, msg);
  } catch (e) {
    console.error('now-playing update failed:', e.message);
    npMessages.delete(guild.id); // retry fresh next cycle
  }
}
async function tickNowPlaying() {
  if (!NOWPLAYING_URL) return;
  let data;
  try {
    const res = await fetch(NOWPLAYING_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }
  const np = parseNP(data);
  // Live bot status = the current track.
  try {
    client.user.setPresence({
      activities: [{ name: `${np.title}${np.artist ? ` — ${np.artist}` : ''}`, type: ActivityType.Listening }],
      status: 'online'
    });
  } catch (e) {}
  for (const g of client.guilds.cache.values()) updateNowPlaying(g, np);
}
function startNowPlaying() {
  if (!NOWPLAYING_URL) {
    try { client.user.setPresence({ activities: [{ name: 'the server 👀', type: ActivityType.Watching }], status: 'online' }); } catch (e) {}
    console.log('Now-playing card disabled (set TMCAST_NOWPLAYING_URL to enable). Default status set.');
    return;
  }
  tickNowPlaying();
  setInterval(tickNowPlaying, 15000);
  console.log('Now-playing card + live "Listening to…" status active (every 15s).');
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); process.exit(1); });

client.login(TOKEN).catch((err) => {
  const msg = String(err && (err.code || err.message));
  if (/DisallowedIntents|disallowed intents/i.test(msg)) {
    console.error('\n⚠️  Login blocked: a PRIVILEGED INTENT is turned off.\n' +
      '    Turn ON both "Server Members Intent" and "Message Content Intent" here:\n' +
      '    https://discord.com/developers/applications  →  your app  →  Bot  →  Privileged Gateway Intents\n' +
      '    Save, then restart the bot.\n');
  } else if (/TokenInvalid/i.test(msg)) {
    console.error('\n⚠️  DISCORD_TOKEN is wrong or missing. Copy it again from\n' +
      '    Dev Portal → Bot → Reset Token (no quotes, no spaces).\n');
  } else {
    console.error('Login failed:', err);
  }
  process.exit(1);
});
