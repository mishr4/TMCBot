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
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType
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
const NOWPLAYING_CHANNEL = process.env.NOWPLAYING_CHANNEL || 'now-playing'; // channel name for the live card
const RADIO_LINK = process.env.RADIO_LINK || 'https://mavion.tmc.gg/radio'; // "Listen Live" button target
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
    // Wipe any leftover GLOBAL commands (e.g. stale ones from a previous bot that reused this app).
    try { await rest.put(Routes.applicationCommands(clientId), { body: [] }); } catch (e) {}
    console.log('Registered guild commands + cleared any stale global commands.');
  } else {
    // Global registration already REPLACES the full set, so old commands are wiped here too.
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
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
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'play') return await cmdPlay(interaction);
    if (interaction.commandName === 'stop') return await cmdStop(interaction);
    if (interaction.commandName === 'nowplaying') return await cmdNowPlaying(interaction);
    if (interaction.commandName === 'roblox') return await cmdRoblox(interaction);
    if (interaction.commandName === 'staff-dm') return await cmdStaffDm(interaction);
  } catch (e) {
    console.error(`/${interaction.commandName} error:`, e);
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
});
client.on(Events.GuildMemberRemove, async (m) => {
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
  if (oldTo !== newTo) {
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
async function updateNowPlaying(guild, np) {
  const channel = logChannel(guild, NOWPLAYING_CHANNEL);
  if (!channel) return;
  const payload = { embeds: [npEmbed(np)], components: [npRow()] };
  let msg = npMessages.get(guild.id);
  try {
    if (!msg) {
      // Reuse the bot's existing card if one's already there (e.g. after a restart).
      const recent = await channel.messages.fetch({ limit: 10 }).catch(() => null);
      const mine = recent && recent.find((m) => m.author.id === client.user.id && m.embeds.length);
      msg = mine || await channel.send(payload);
      npMessages.set(guild.id, msg);
      if (mine) await msg.edit(payload);
    } else {
      await msg.edit(payload);
    }
  } catch {
    npMessages.delete(guild.id); // message gone -> repost next cycle
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
