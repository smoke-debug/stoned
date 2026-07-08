'use strict';
const fs   = require('node:fs');
const path = require('node:path');
const {
  Client, GatewayIntentBits, PermissionsBitField,
  ChannelType, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle,
  REST, Routes, ActivityType,
} = require('discord.js');

// =========================
// CONFIG
// =========================
const TOKEN                = process.env.DISCORD_TOKEN;
const PREFIX               = process.env.PREFIX               || '*';
const DATA_FILE            = process.env.DATA_FILE            || './bot-data.json';
const TEMP_VC_DELETE_DELAY = Number(process.env.TEMP_VC_DELETE_DELAY_MS || 500);
const DM_QUEUE_CONCURRENCY = Number(process.env.DM_QUEUE_CONCURRENCY   || 3);
const DM_RETRY_MAX         = Number(process.env.DM_RETRY_MAX           || 3);
const OWNER_ID             = process.env.OWNER_ID             || null;  // Discord user ID of the bot owner

if (!TOKEN) { console.error('Missing DISCORD_TOKEN.'); process.exit(1); }

// =========================
// CLIENT
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,  // required for presenceUpdate & status tracking
  ],
});

// =========================
// DM QUEUE
// =========================
class DmQueue {
  constructor(concurrency = DM_QUEUE_CONCURRENCY) {
    this.queue = []; this.running = 0; this.concurrency = concurrency;
  }
  enqueue(fn) { this.queue.push(fn); this._tick(); }
  _tick() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      this.running++; this._run(this.queue.shift());
    }
  }
  async _run(fn) {
    try { await fn(); } catch { /* handled inside fn */ }
    finally { this.running--; this._tick(); }
  }
  get size() { return this.queue.length + this.running; }
}
const dmQueue = new DmQueue();

// =========================
// STORAGE
// =========================
let db = { guilds: {} };

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function loadDb() {
  try {
    ensureDataFile();
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{"guilds":{}}');
    if (!db.guilds) db.guilds = {};
  } catch (err) { console.error('Failed to load db:', err); db = { guilds: {} }; }
}
function saveDb() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (err) { console.error('Failed to save db:', err); }
}
function getGuildData(guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      uwuTargets: [], vm: null, tempVcs: {},
      economy: { users: {} }, welcomeDm: null,
      vcMilestones: { milestones: [], announcementChannelId: null },
      vcTrack: {},
      ghostPing: { enabled: false, channelIds: [] },
      statusRoles: [],
      messageCounts: {},
      giveaways: {},
      modWallet: { whitelist: [], users: {} },
      friendGroups: {},
    };
    saveDb();
  }
  const g = db.guilds[guildId];
  if (!g.uwuTargets)         g.uwuTargets = [];
  if (!g.tempVcs)            g.tempVcs    = {};
  if (!g.economy)            g.economy    = { users: {} };
  if (!g.economy.users)      g.economy.users = {};
  if (g.welcomeDm === undefined) g.welcomeDm = null;
  if (!g.vcMilestones)       g.vcMilestones = { milestones: [], announcementChannelId: null };
  if (!Array.isArray(g.vcMilestones.milestones)) g.vcMilestones.milestones = [];
  if (!g.vcTrack)            g.vcTrack    = {};
  if (!g.ghostPing)          g.ghostPing  = { enabled: false, channelIds: [] };
  if (!Array.isArray(g.ghostPing.channelIds)) g.ghostPing.channelIds = [];
  if (!Array.isArray(g.statusRoles))  g.statusRoles  = [];
  if (!g.messageCounts)                 g.messageCounts = {};
  if (!g.giveaways)                     g.giveaways     = {};
  if (!g.modWallet)                     g.modWallet     = { whitelist: [], users: {} };
  if (!Array.isArray(g.modWallet.whitelist)) g.modWallet.whitelist = [];
  if (!g.modWallet.users)               g.modWallet.users = {};
  if (!g.friendGroups)                  g.friendGroups  = {};
  return g;
}
loadDb();

// =========================
// WELCOME DM
// =========================
function defaultWelcomeDmConfig() {
  return {
    enabled: false, content: null,
    embed: { title: null, description: null, color: null, thumbnailUrl: null, imageUrl: null, footerText: null, fields: [] },
  };
}
function getWelcomeDm(guildId) {
  const data = getGuildData(guildId);
  if (!data.welcomeDm) data.welcomeDm = defaultWelcomeDmConfig();
  const cfg = data.welcomeDm;
  if (!cfg.embed)                     cfg.embed = defaultWelcomeDmConfig().embed;
  if (!Array.isArray(cfg.embed.fields)) cfg.embed.fields = [];
  return cfg;
}
function hasWelcomeDmContent(cfg) {
  const e = cfg.embed || {};
  return Boolean(cfg.content || e.title || e.description || (e.fields && e.fields.length > 0));
}
function resolveVariables(text, member) {
  if (!text || !member) return text || '';
  const { guild } = member;
  const { user }  = member;
  const icon = guild.iconURL({ extension: 'png', size: 256 }) || '';
  return String(text)
    .replace(/\{user\.mention\}/gi,      `<@${member.id}>`)
    .replace(/\{user\.username\}/gi,     user.username)
    .replace(/\{user\.globalName\}/gi,   user.globalName  || user.username)
    .replace(/\{user\.displayName\}/gi,  member.displayName || user.username)
    .replace(/\{user\.tag\}/gi,          user.tag         || user.username)
    .replace(/\{user\.id\}/gi,           member.id)
    .replace(/\{user\.createdAt\}/gi,    `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`)
    .replace(/\{server\.name\}/gi,       guild.name)
    .replace(/\{server\.memberCount\}/gi,String(guild.memberCount))
    .replace(/\{server\.id\}/gi,         guild.id)
    .replace(/\{server\.icon\}/gi,       icon);
}
function buildWelcomeDmPayload(member, cfg) {
  const rv = (t) => resolveVariables(t, member);
  const payload = {};
  if (cfg.content) payload.content = rv(cfg.content).slice(0, 2000);
  const e = cfg.embed || {};
  if (e.title || e.description || (e.fields && e.fields.length > 0)) {
    const embed = new EmbedBuilder();
    if (e.color) { try { embed.setColor(Number.parseInt(e.color.replace('#',''), 16)); } catch { /* bad color */ } }
    if (e.title)       embed.setTitle(rv(e.title).slice(0, 256));
    if (e.description) embed.setDescription(rv(e.description).slice(0, 4096));
    if (e.footerText)  embed.setFooter({ text: rv(e.footerText).slice(0, 2048) });
    if (e.thumbnailUrl){ const u = rv(e.thumbnailUrl); if (u.startsWith('http')) embed.setThumbnail(u); }
    if (e.imageUrl)    { const u = rv(e.imageUrl);     if (u.startsWith('http')) embed.setImage(u); }
    if (e.fields && e.fields.length > 0) {
      for (const f of e.fields.slice(0, 25))
        embed.addFields({ name: rv(f.name||'\u200b').slice(0,256), value: rv(f.value||'\u200b').slice(0,1024), inline: Boolean(f.inline) });
    }
    payload.embeds = [embed];
  }
  return payload;
}
async function sendDmWithRetry(user, payload, maxRetries = DM_RETRY_MAX) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try { await user.send(payload); return true; }
    catch (err) {
      if (err.code === 50007) return false;
      if (err.code === 429 || err.status === 429) {
        await sleep(Math.min(err.retryAfter ? err.retryAfter * 1000 : 1000 * 2 ** attempt, 30_000));
        continue;
      }
      console.error(`[WelcomeDM] attempt ${attempt + 1} failed for ${user.id}:`, err.message);
      return false;
    }
  }
  return false;
}
function queueWelcomeDm(member) {
  if (member.user.bot) return;
  const cfg = getWelcomeDm(member.guild.id);
  if (!cfg.enabled || !hasWelcomeDmContent(cfg)) return;
  const payload = buildWelcomeDmPayload(member, cfg);
  if (!payload.content && (!payload.embeds || !payload.embeds.length)) return;
  dmQueue.enqueue(async () => {
    const ok = await sendDmWithRetry(member.user, payload);
    if (!ok) console.log(`[WelcomeDM] Could not DM ${member.user.tag} — DMs closed or failed.`);
  });
}

// =========================
// VC MILESTONE ROLES
// In-memory: "guildId:userId" → session start timestamp
// Time is saved to DB on leave and every 60s tick.
// On restart clientReady seeds sessions for users already in VC.
// =========================
const vcSessions = new Map();

function getVcTrackUser(guildId, userId) {
  const data = getGuildData(guildId);
  if (!data.vcTrack[userId]) data.vcTrack[userId] = { totalMs: 0, milestonesGranted: [] };
  const u = data.vcTrack[userId];
  if (!Number.isFinite(u.totalMs) || u.totalMs < 0) u.totalMs = 0;
  if (!Array.isArray(u.milestonesGranted)) u.milestonesGranted = [];
  return u;
}
// Live total = persisted + current session if active
function getEffectiveTotalMs(guildId, userId) {
  const u = getVcTrackUser(guildId, userId);
  const start = vcSessions.get(`${guildId}:${userId}`);
  return (u.totalMs || 0) + (start ? Date.now() - start : 0);
}
// Add ms to persisted total; caller must saveDb() afterwards
function addVcMs(guildId, userId, ms) {
  if (!ms || ms <= 0) return;
  const u = getVcTrackUser(guildId, userId);
  u.totalMs = (u.totalMs || 0) + Math.floor(ms);
}

// Parse "24h", "7d", "90m", "1h30m", bare number=minutes
function parseTimeArg(arg) {
  const str = String(arg || '').toLowerCase().trim();
  if (!str) return null;
  const units = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
  let ms = 0; let matched = false; let match;
  while ((match = re.exec(str)) !== null) { ms += parseFloat(match[1]) * (units[match[2]] || 60_000); matched = true; }
  if (matched) return ms > 0 ? Math.floor(ms) : null;
  const n = parseFloat(str);
  return Number.isFinite(n) && n > 0 ? Math.floor(n * 60_000) : null;
}
function formatDuration(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.length ? parts.join(' ') : '< 1m';
}
function vcBar(current, goal, width = 10) {
  const filled = Math.floor(Math.min(1, (current || 0) / Math.max(1, goal)) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

async function checkAndGrantVcMilestones(guild, userId) {
  const data   = getGuildData(guild.id);
  const cfg    = data.vcMilestones;
  if (!cfg || !cfg.milestones || !cfg.milestones.length) return;

  const effectiveMs = getEffectiveTotalMs(guild.id, userId);
  const u           = getVcTrackUser(guild.id, userId);
  const sorted      = [...cfg.milestones].sort((a, b) => a.thresholdMs - b.thresholdMs);
  let anyGranted    = false;

  for (const milestone of sorted) {
    if (u.milestonesGranted.includes(milestone.roleId)) continue;
    if (effectiveMs < milestone.thresholdMs) continue;

    const role = guild.roles.cache.get(milestone.roleId);
    if (!role) continue; // role was deleted — skip silently

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;

    try {
      await member.roles.add(role, `VC Milestone: ${formatDuration(milestone.thresholdMs)} in voice`);
      u.milestonesGranted.push(milestone.roleId);
      anyGranted = true;
      console.log(`[VCMilestone] Granted "${role.name}" to ${member.user.tag} (${formatDuration(effectiveMs)} total)`);

      const ch = cfg.announcementChannelId
        ? guild.channels.cache.get(cfg.announcementChannelId)
        : null;
      if (ch?.isTextBased?.()) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0xff8a00)
            .setTitle('🎙️ VC Milestone Reached!')
            .setDescription(`<@${userId}> has spent **${formatDuration(milestone.thresholdMs)}** in voice channels and earned the **${role.name}** role!`)
            .setFooter({ text: `Total VC time: ${formatDuration(effectiveMs)}` })
            .setTimestamp()],
          allowedMentions: { users: [userId] },
        }).catch(() => null);
      }
    } catch (err) {
      console.error(`[VCMilestone] Could not grant "${role.name}" to ${userId}:`, err.message);
    }
  }
  if (anyGranted) saveDb();
}

// VC Milestone command handler
async function handleVcMilestoneCommand(message, args) {
  const sub = (args.shift() || 'list').toLowerCase();

  // ── Public subcommands ──────────────────────────────────────────────────────
  if (sub === 'list' || sub === 'milestones') {
    const data   = getGuildData(message.guild.id);
    const cfg    = data.vcMilestones;
    if (!cfg.milestones.length) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('🎙️ VC Milestone Roles').setDescription(`No milestones set yet.\n\nUse \`${PREFIX}vcm add @Role 24h\` to add one.`)] });
    }
    const sorted = [...cfg.milestones].sort((a, b) => a.thresholdMs - b.thresholdMs);
    const lines  = sorted.map((m, i) => {
      const role = message.guild.roles.cache.get(m.roleId);
      const name = role ? `<@&${m.roleId}>` : `~~<@&${m.roleId}>~~ *(deleted)*`;
      return `**${i + 1}.** ${name} — **${formatDuration(m.thresholdMs)}**`;
    });
    const announceCh = cfg.announcementChannelId ? `<#${cfg.announcementChannelId}>` : '*(not set)*';
    const tracked    = Object.keys(data.vcTrack || {}).length;
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('🎙️ VC Milestone Roles')
        .setDescription(lines.join('\n'))
        .addFields(
          { name: 'Announcement Channel', value: announceCh, inline: true },
          { name: 'Tracked Members',      value: String(tracked), inline: true },
        )
        .setFooter({ text: `${PREFIX}vcm add @Role <time>  •  ${PREFIX}vcm check  •  ${PREFIX}vcm lb` })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'check') {
    let target = message.member;
    if (args[0]) {
      const found = await getTargetMember(message, args[0]);
      if (!found) return replySyntax(message, `${PREFIX}vcm check [@user]`);
      target = found;
    }
    const effectiveMs = getEffectiveTotalMs(message.guild.id, target.id);
    const u           = getVcTrackUser(message.guild.id, target.id);
    const cfg         = getGuildData(message.guild.id).vcMilestones;
    const sorted      = [...(cfg.milestones || [])].sort((a, b) => a.thresholdMs - b.thresholdMs);
    const isLive      = vcSessions.has(`${message.guild.id}:${target.id}`);

    let milestoneLines;
    if (!sorted.length) {
      milestoneLines = '*(no milestones configured — use `*vcm add @Role 24h`)*';
    } else {
      const nextMilestone = sorted.find(
        (m) => !u.milestonesGranted.includes(m.roleId) && effectiveMs < m.thresholdMs,
      );
      const lines = sorted.map((m) => {
        const role    = message.guild.roles.cache.get(m.roleId);
        const roleTxt = role ? `<@&${m.roleId}>` : '`deleted role`';
        const earned  = u.milestonesGranted.includes(m.roleId);
        if (earned)                    return `✅ **${formatDuration(m.thresholdMs)}** — ${roleTxt}`;
        if (effectiveMs >= m.thresholdMs) return `⏳ **${formatDuration(m.thresholdMs)}** — ${roleTxt} *(pending grant)*`;
        const remaining = m.thresholdMs - effectiveMs;
        return `⬜ **${formatDuration(m.thresholdMs)}** — ${roleTxt}\n> ${vcBar(effectiveMs, m.thresholdMs)} ${formatDuration(remaining)} remaining`;
      });
      milestoneLines = lines.join('\n');
      if (nextMilestone)
        milestoneLines += `\n\n**Next milestone in:** ${formatDuration(nextMilestone.thresholdMs - effectiveMs)}`;
    }

    return message.reply({
      embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle(`🎙️ VC Time — ${target.displayName}`)
        .addFields(
          { name: 'Total VC Time',      value: `**${formatDuration(effectiveMs)}**${isLive ? '  🔴 *live*' : ''}`, inline: true },
          { name: 'Milestones Earned',  value: String(u.milestonesGranted.length), inline: true },
        )
        .setDescription(milestoneLines)
        .setThumbnail(target.user.displayAvatarURL({ extension: 'png', size: 128 }))
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'lb' || sub === 'leaderboard') {
    const data = getGuildData(message.guild.id);
    const rows = Object.entries(data.vcTrack || {})
      .map(([userId]) => ({ userId, ms: getEffectiveTotalMs(message.guild.id, userId) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10);
    if (!rows.length) return message.reply({ embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('🎙️ VC Time Leaderboard').setDescription('No VC time tracked yet.')] });
    const medals = ['🥇', '🥈', '🥉'];
    const lines  = rows.map((r, i) => {
      const live = vcSessions.has(`${message.guild.id}:${r.userId}`) ? ' 🔴' : '';
      return `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — **${formatDuration(r.ms)}**${live}`;
    });
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('🎙️ VC Time Leaderboard')
        .setDescription(lines.join('\n'))
        .setFooter({ text: '🔴 = currently in VC' })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // ── Admin-only subcommands ──────────────────────────────────────────────────
  if (!hasManagerPerm(message.member))
    return message.reply('You need Manage Server or Manage Channels for that subcommand.');

  if (sub === 'add') {
    const role    = message.mentions.roles.first();
    const timeArg = args.find((a) => !/^<@&\d+>$/.test(a));
    if (!role || !timeArg)
      return replySyntax(message, `${PREFIX}vcm add @Role <time>`, 'Examples: `*vcm add @VC+ 24h`  `*vcm add @Legend 7d`  `*vcm add @Active 90m`');
    const thresholdMs = parseTimeArg(timeArg);
    if (!thresholdMs) return message.reply({ embeds: [simpleEmbed(0xed4245, 'Invalid time. Examples: `24h` `7d` `90m` `1h30m` `2d12h`')] });
    const data = getGuildData(message.guild.id);
    const cfg  = data.vcMilestones;
    if (cfg.milestones.some((m) => m.roleId === role.id))
      return message.reply({ embeds: [simpleEmbed(0xffa500, `A milestone for ${role} already exists. Remove it first with \`${PREFIX}vcm remove\`.`)] });
    if (cfg.milestones.length >= 25)
      return message.reply({ embeds: [simpleEmbed(0xed4245, 'Maximum of 25 milestones per server.')] });
    cfg.milestones.push({ roleId: role.id, thresholdMs });
    cfg.milestones.sort((a, b) => a.thresholdMs - b.thresholdMs);
    saveDb();
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ VC Milestone Added')
        .setDescription(`Members who spend **${formatDuration(thresholdMs)}** in voice channels will earn ${role}.`)
        .setFooter({ text: `${cfg.milestones.length} milestone(s) configured` }).setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'remove') {
    const data = getGuildData(message.guild.id);
    const cfg  = data.vcMilestones;
    if (!cfg.milestones.length) return message.reply('No milestones configured yet.');
    const mentionedRole = message.mentions.roles.first();
    const sorted        = [...cfg.milestones].sort((a, b) => a.thresholdMs - b.thresholdMs);
    let idx = -1;
    if (mentionedRole) {
      idx = sorted.findIndex((m) => m.roleId === mentionedRole.id);
    } else {
      const n = Number.parseInt(args[0], 10);
      if (Number.isFinite(n) && n >= 1 && n <= sorted.length) idx = n - 1;
    }
    if (idx === -1) return replySyntax(message, `${PREFIX}vcm remove <number or @Role>`, `Use \`${PREFIX}vcm list\` to see numbered milestones.`);
    const removed = sorted[idx];
    cfg.milestones = cfg.milestones.filter((m) => m.roleId !== removed.roleId);
    saveDb();
    const removedRole = message.guild.roles.cache.get(removed.roleId);
    return message.reply({
      embeds: [simpleEmbed(0xed4245, `Removed milestone: **${formatDuration(removed.thresholdMs)}** → ${removedRole ? `<@&${removedRole.id}>` : '`deleted role`'}.`)],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'setchannel') {
    const ch = message.mentions.channels.first()
      || (args[0] ? message.guild.channels.cache.get(args[0]) : null);
    if (!ch || !ch.isTextBased()) return replySyntax(message, `${PREFIX}vcm setchannel #channel`);
    const data = getGuildData(message.guild.id);
    data.vcMilestones.announcementChannelId = ch.id;
    saveDb();
    return message.reply({ embeds: [simpleEmbed(0x57f287, `✅ Milestone announcements will be posted in ${ch}.`)] });
  }

  if (sub === 'clearchannel') {
    const data = getGuildData(message.guild.id);
    data.vcMilestones.announcementChannelId = null;
    saveDb();
    return message.reply({ embeds: [simpleEmbed(0xed4245, 'Announcement channel cleared.')] });
  }

  if (sub === 'reset') {
    const target = await getTargetMember(message, args[0]);
    if (!target) return replySyntax(message, `${PREFIX}vcm reset @user`);
    const data = getGuildData(message.guild.id);
    data.vcTrack[target.id] = { totalMs: 0, milestonesGranted: [] };
    vcSessions.delete(`${message.guild.id}:${target.id}`);
    if (target.voice?.channelId) vcSessions.set(`${message.guild.id}:${target.id}`, Date.now());
    saveDb();
    return message.reply({ embeds: [simpleEmbed(0xed4245, `VC time and milestones reset for ${target}.`)], allowedMentions: { parse: [] } });
  }

  if (sub === 'settime') {
    const target  = await getTargetMember(message, args[0]);
    const timeArg = args[1];
    if (!target || !timeArg) return replySyntax(message, `${PREFIX}vcm settime @user <time>`);
    const ms = parseTimeArg(timeArg);
    if (!ms) return message.reply({ embeds: [simpleEmbed(0xed4245, 'Invalid time. Examples: `24h` `7d` `90m`')] });
    const u = getVcTrackUser(message.guild.id, target.id);
    u.totalMs = ms;
    u.milestonesGranted = []; // clear so milestones are re-evaluated from scratch
    saveDb();
    await checkAndGrantVcMilestones(message.guild, target.id);
    return message.reply({
      embeds: [simpleEmbed(0x57f287, `Set ${target}'s VC time to **${formatDuration(ms)}** and rechecked milestones.`)],
      allowedMentions: { parse: [] },
    });
  }

  // Default help
  return message.reply({
    embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('🎙️ VC Milestone Commands').setDescription([
      `\`${PREFIX}vcm\` / \`${PREFIX}vcm list\` — View all milestones`,
      `\`${PREFIX}vcm check [@user]\` — VC time & milestone progress`,
      `\`${PREFIX}vcm lb\` — VC time leaderboard`,
      '',
      '*Requires Manage Server:*',
      `\`${PREFIX}vcm add @Role <time>\` — Add a milestone role`,
      `\`${PREFIX}vcm remove <# or @Role>\` — Remove a milestone`,
      `\`${PREFIX}vcm setchannel #channel\` — Set announcement channel`,
      `\`${PREFIX}vcm clearchannel\` — Disable announcements`,
      `\`${PREFIX}vcm reset @user\` — Reset a user's VC time to 0`,
      `\`${PREFIX}vcm settime @user <time>\` — Manually set VC time`,
      '',
      '**Time formats:** `24h` · `7d` · `90m` · `1h30m` · `2d12h`',
    ].join('\n')).setTimestamp()],
  });
}

// =========================
// STATUS ROLES
// Monitors custom status text via presenceUpdate.
// Rules: a list of substrings (ALL must be present) → one or more roles to grant.
// When a user's status no longer matches a rule, the roles are revoked.
// Requires Presence Intent enabled in the Discord Developer Portal.
// =========================

// Slash command definitions (registered per-guild on ready / guild join)
const SLASH_COMMANDS = [
  {
    name: 'statusrole',
    description: "Auto-assign roles based on what's in a user's custom status",
    default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
    options: [
      {
        name: 'add',
        type: 1,
        description: 'Add a rule: give one or more roles when status contains specific text',
        options: [
          { name: 'substrings', type: 3, required: true,  description: 'Text to look for — comma-separated for AND logic, e.g.  /pmo,link' },
          { name: 'role1',      type: 8, required: true,  description: 'Role to give' },
          { name: 'role2',      type: 8, required: false, description: 'Second role to give (optional)' },
          { name: 'role3',      type: 8, required: false, description: 'Third role to give (optional)' },
        ],
      },
      {
        name: 'remove',
        type: 1,
        description: 'Remove a rule by its number from /statusrole list',
        options: [
          { name: 'rule', type: 4, required: true, description: 'Rule number', min_value: 1 },
        ],
      },
      { name: 'list', type: 1, description: 'Show all configured status role rules', options: [] },
      {
        name: 'check',
        type: 1,
        description: "Preview which rules match a user\'s current status",
        options: [
          { name: 'user', type: 6, required: false, description: 'User to check (defaults to yourself)' },
        ],
      },
    ],
  },
  {
    name: 'giveaway',
    description: 'Create and manage giveaways with optional requirements',
    options: [
      {
        name: 'create', type: 1,
        description: 'Create a new giveaway',
        options: [
          { name: 'channel',         type: 7,  required: true,  description: 'Channel to post the giveaway in' },
          { name: 'prize',           type: 3,  required: true,  description: 'What are you giving away?' },
          { name: 'duration',        type: 3,  required: true,  description: 'How long to run, e.g. 30m 1h 24h 7d' },
          { name: 'winners',         type: 4,  required: false, description: 'Number of winners (default 1)', min_value: 1, max_value: 20 },
          { name: 'description',     type: 3,  required: false, description: 'Extra info or rules shown in the embed' },
          { name: 'status_required', type: 3,  required: false, description: 'Substring users must have in their custom status to enter' },
          { name: 'min_messages',    type: 4,  required: false, description: 'Messages user must send after clicking Enter', min_value: 1 },
          { name: 'min_vc_hours',    type: 10, required: false, description: 'VC hours user must spend after clicking Enter', min_value: 0.1 },
        ],
      },
      {
        name: 'end', type: 1,
        description: 'End a giveaway early and draw winners',
        options: [{ name: 'message_id', type: 3, required: true, description: 'Giveaway message ID (from /giveaway list)' }],
      },
      {
        name: 'reroll', type: 1,
        description: 'Reroll winners for an ended giveaway',
        options: [
          { name: 'message_id', type: 3, required: true,  description: 'Giveaway message ID' },
          { name: 'winners',    type: 4, required: false, description: 'How many winners to pick', min_value: 1 },
        ],
      },
      { name: 'list', type: 1, description: 'List all active giveaways', options: [] },
      {
        name: 'cancel', type: 1,
        description: 'Cancel a giveaway without drawing winners',
        options: [{ name: 'message_id', type: 3, required: true, description: 'Giveaway message ID' }],
      },
    ],
  },
  {
    name: 'friendgroup',
    description: 'Create and manage friend groups with shared roles and live activity stats',
    options: [
      {
        name: 'create', type: 1,
        description: 'Create a new friend group — also creates a server role with that name',
        options: [
          { name: 'name',    type: 3, required: true,  description: 'Group name (also becomes the role name)' },
          { name: 'members', type: 3, required: true,  description: 'Mention members separated by spaces, e.g. @user1 @user2 @user3' },
          { name: 'color',   type: 3, required: false, description: 'Role color hex, e.g. ff8a00' },
        ],
      },
      {
        name: 'add', type: 1,
        description: 'Add members to an existing friend group',
        options: [
          { name: 'name',    type: 3, required: true,  description: 'Friend group name', autocomplete: true },
          { name: 'members', type: 3, required: true,  description: 'Mention members separated by spaces, e.g. @user1 @user2 @user3' },
        ],
      },
      {
        name: 'remove', type: 1,
        description: 'Remove members from a friend group',
        options: [
          { name: 'name',    type: 3, required: true,  description: 'Friend group name', autocomplete: true },
          { name: 'members', type: 3, required: true,  description: 'Mention members separated by spaces, e.g. @user1 @user2 @user3' },
        ],
      },
      {
        name: 'delete', type: 1,
        description: 'Delete a friend group and remove its role',
        options: [
          { name: 'name', type: 3, required: true, description: 'Friend group name', autocomplete: true },
        ],
      },
      {
        name: 'stats', type: 1,
        description: 'Show live message and VC stats for a friend group',
        options: [
          { name: 'name', type: 3, required: true, description: 'Friend group name', autocomplete: true },
        ],
      },
      {
        name: 'list', type: 1,
        description: 'List all friend groups',
        options: [],
      },
    ],
  },
];

async function registerSlashCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: SLASH_COMMANDS });
    console.log(`[SlashCmds] Registered in guild ${guildId}`);
  } catch (err) {
    console.error(`[SlashCmds] Failed to register in guild ${guildId}:`, err.message);
  }
}

// Extract the custom status text from a Presence object
function getCustomStatus(presence) {
  if (!presence) return '';
  const act = presence.activities?.find((a) => a.type === ActivityType.Custom);
  return (act?.state || '').trim();
}

// Grant or revoke status-based roles for a single member.
// Checks every rule: if ALL substrings are in the status, grant the rule's roles;
// if not, revoke them — but only if no OTHER matching rule also grants that role.
async function applyStatusRoles(guild, userId, statusText) {
  const data  = getGuildData(guild.id);
  const rules = data.statusRoles;
  if (!rules || !rules.length) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) return;

  const lower = statusText.toLowerCase();

  // Build: roleId → true (at least one matching rule grants it) | false (no rule)
  const roleDecision = new Map();
  for (const rule of rules) {
    const matches = rule.substrings.every((sub) => lower.includes(sub.toLowerCase()));
    for (const roleId of rule.roleIds) {
      if (matches) roleDecision.set(roleId, true);
      else if (!roleDecision.has(roleId)) roleDecision.set(roleId, false);
    }
  }

  for (const [roleId, shouldHave] of roleDecision) {
    const role   = guild.roles.cache.get(roleId);
    if (!role) continue;
    const hasIt  = member.roles.cache.has(roleId);
    if (shouldHave && !hasIt) {
      await member.roles.add(role,    'StatusRole: status matches rule').catch((e) => console.error('[StatusRole] add error:', e.message));
    } else if (!shouldHave && hasIt) {
      await member.roles.remove(role, 'StatusRole: status no longer matches').catch((e) => console.error('[StatusRole] remove error:', e.message));
    }
  }
}

async function handleStatusRoleInteraction(interaction) {
  const sub  = interaction.options.getSubcommand();
  const data = getGuildData(interaction.guild.id);

  // ── list ────────────────────────────────────────────────────────────────────
  if (sub === 'list') {
    if (!data.statusRoles.length) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('📋 Status Role Rules')
          .setDescription('No rules yet.\n\nUse `/statusrole add` to create one.\n\n**Example:** substrings: `/pmo`  role1: @Pic')],
        ephemeral: true,
      });
    }
    const lines = data.statusRoles.map((rule, i) => {
      const subs  = rule.substrings.map((s) => `\`${s}\``).join(' **+** ');
      const roles = rule.roleIds.map((id) => `<@&${id}>`).join(', ');
      return `**${i + 1}.** ${subs} → ${roles}`;
    });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('📋 Status Role Rules')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${data.statusRoles.length} rule(s) • /statusrole remove <number> to delete` })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // ── check ───────────────────────────────────────────────────────────────────
  if (sub === 'check') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const member     = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) return interaction.reply({ content: 'Could not find that user.', ephemeral: true });

    const presence   = interaction.guild.presences.cache.get(targetUser.id);
    const status     = getCustomStatus(presence);

    if (!data.statusRoles.length)
      return interaction.reply({ content: 'No status role rules configured yet.', ephemeral: true });

    const lines = data.statusRoles.map((rule, i) => {
      const matches = rule.substrings.every((sub) => status.toLowerCase().includes(sub.toLowerCase()));
      const subs    = rule.substrings.map((s) => `\`${s}\``).join(' + ');
      const roles   = rule.roleIds.map((id) => `<@&${id}>`).join(', ');
      return `${matches ? '✅' : '❌'} **${i + 1}.** ${subs} → ${roles}`;
    });

    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xff8a00)
        .setTitle(`🔍 Status Check — ${member.displayName}`)
        .setDescription([
          `**Current status:** ${status ? `\`${status}\`` : '*(no custom status)*'}`, '',
          ...lines,
        ].join('\n'))
        .setTimestamp()],
      allowedMentions: { parse: [] },
      ephemeral: false,
    });
  }

  // ── add ─────────────────────────────────────────────────────────────────────
  if (sub === 'add') {
    const raw        = interaction.options.getString('substrings', true);
    const substrings = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!substrings.length)
      return interaction.reply({ content: 'Provide at least one substring.', ephemeral: true });
    if (substrings.some((s) => s.length > 100))
      return interaction.reply({ content: 'Each substring must be 100 characters or fewer.', ephemeral: true });

    const r1 = interaction.options.getRole('role1');
    const r2 = interaction.options.getRole('role2');
    const r3 = interaction.options.getRole('role3');
    const roleIds = [r1, r2, r3].filter(Boolean).map((r) => r.id);

    // Check bot can manage each role
    const me = interaction.guild.members.me;
    for (const roleId of roleIds) {
      const role = interaction.guild.roles.cache.get(roleId);
      if (role && role.position >= me.roles.highest.position) {
        return interaction.reply({ content: `I can't assign ${role} — it's the same level or higher than my highest role. Move my role above it first.`, ephemeral: true });
      }
    }

    const rule = { substrings, roleIds, createdAt: Date.now() };
    data.statusRoles.push(rule);
    saveDb();

    // Immediately apply to currently-online members so they don't have to toggle status
    await interaction.deferReply();
    let granted = 0;
    for (const [userId, presence] of interaction.guild.presences.cache) {
      const status = getCustomStatus(presence);
      if (rule.substrings.every((sub) => status.toLowerCase().includes(sub.toLowerCase()))) {
        const m = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!m || m.user.bot) continue;
        for (const roleId of roleIds) {
          const role = interaction.guild.roles.cache.get(roleId);
          if (role && !m.roles.cache.has(roleId)) {
            await m.roles.add(role, 'StatusRole: retroactive apply on rule creation').catch(() => null);
            granted++;
          }
        }
      }
    }

    const subs  = substrings.map((s) => `\`${s}\``).join(' **+** ');
    const roles = roleIds.map((id) => `<@&${id}>`).join(', ');
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ Status Role Rule Added')
        .setDescription(`When a user's status contains ${subs}, they receive: ${roles}`)
        .addFields({ name: 'Rule #', value: String(data.statusRoles.length), inline: true }, { name: 'Immediately granted to', value: `${granted} online member(s)`, inline: true })
        .setFooter({ text: 'Works for all members going forward via presence updates.' })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // ── remove ──────────────────────────────────────────────────────────────────
  if (sub === 'remove') {
    const num = interaction.options.getInteger('rule', true);
    if (num < 1 || num > data.statusRoles.length)
      return interaction.reply({ content: `Rule #${num} doesn\'t exist. Use /statusrole list to see all rules.`, ephemeral: true });

    const removed = data.statusRoles.splice(num - 1, 1)[0];
    saveDb();

    // Re-evaluate all currently online members so roles are revoked immediately
    await interaction.deferReply();
    for (const [userId, presence] of interaction.guild.presences.cache) {
      const status = getCustomStatus(presence);
      await applyStatusRoles(interaction.guild, userId, status);
    }

    const subs = removed.substrings.map((s) => `\`${s}\``).join(' + ');
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🗑️ Status Role Rule Removed')
        .setDescription(`Removed rule #${num}: ${subs}\n\nOnline members have been re-evaluated — roles have been revoked where applicable.`)
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }
}

// =========================
// GIVEAWAY SYSTEM
// Tracks per-user message counts (buffered, flushed every 60s) and VC time
// (already tracked via vcSessions + vcTrack). Requirements are snapshotted
// the first time a user clicks Enter, so progress is measured from that moment.
// Giveaways survive bot restarts — scheduled on clientReady from saved DB.
// =========================

const messageCountBuffer = new Map(); // "guildId:userId" → pending msg count
const scheduledGiveaways = new Set(); // giveaway IDs with an active setTimeout

function getUserMessageCount(guildId, userId) {
  const data = getGuildData(guildId);
  const db   = (data.messageCounts[userId] || 0);
  const buf  = (messageCountBuffer.get(`${guildId}:${userId}`) || 0);
  return db + buf;
}

function buildGiveawayEmbed(giveaway, guild) {
  const ended     = giveaway.ended || giveaway.cancelled;
  const ts        = Math.floor(giveaway.endsAt / 1000);
  const timeField = ended ? `<t:${ts}:f>` : `<t:${ts}:R>`;
  const color     = giveaway.cancelled ? 0xed4245 : ended ? 0x2b2d31 : 0x7b48cc;

  const lines = [];
  if (giveaway.description) lines.push(giveaway.description, '');

  lines.push(
    `> 🏆  **Winners** ꔷ ${giveaway.winnerCount}`,
    `> ⏰  **${ended ? 'Ended' : 'Ends'}** ꔷ ${timeField}`,
    `> 👥  **Entries** ꔷ ${giveaway.entrants.length}`,
    `> 🎟️  **Host** ꔷ <@${giveaway.hostId}>`,
  );

  const req     = giveaway.requirements || {};
  const reqLines = [];
  if (req.statusSubstring) reqLines.push(`> 📝 Have \`${req.statusSubstring}\` in your custom status`);
  if (req.minMessages > 0) reqLines.push(`> 💬 Send **${req.minMessages}** messages after clicking Enter`);
  if (req.minVcHours  > 0) reqLines.push(`> 🎙️ Spend **${req.minVcHours}h** in voice after clicking Enter`);
  if (reqLines.length) lines.push('', '**— Requirements —**', ...reqLines);

  if (giveaway.cancelled) {
    lines.push('', '> ⛔ This giveaway was cancelled.');
  } else if (ended) {
    if (giveaway.winners && giveaway.winners.length > 0) {
      lines.push('', `🎊 **Winner(s):** ${giveaway.winners.map(id => `<@${id}>`).join(', ')}`);
    } else {
      lines.push('', '> *No valid entries — no winners drawn.*');
    }
  }

  const title = giveaway.cancelled
    ? `⛔ ${giveaway.prize} — CANCELLED`
    : ended ? `🎉 ${giveaway.prize} — ENDED`
    : `🎉 ${giveaway.prize}`;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `ID: ${giveaway.id || '…'}${ended ? ' ꔷ Giveaway over' : ' ꔷ Click below to enter!'}` })
    .setTimestamp(new Date(giveaway.endsAt));
}

function buildGiveawayComponents(giveawayId, ended = false) {
  if (ended) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter:${giveawayId}`)
      .setLabel('Enter Giveaway')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Success),
  )];
}

// Returns array of missing-requirement objects (empty = all met).
// Takes a lazy snapshot of the user's stats on first call for this giveaway.
async function checkGiveawayRequirements(giveaway, member, guild) {
  const req     = giveaway.requirements || {};
  const userId  = member.id;
  const missing = [];

  // --- 1. Status substring ---
  if (req.statusSubstring) {
    const presence = guild.presences.cache.get(userId);
    const status   = getCustomStatus(presence);
    if (!status.toLowerCase().includes(req.statusSubstring.toLowerCase())) {
      missing.push({
        label: '📝 Custom Status',
        need:  `Your status must contain \`${req.statusSubstring}\``,
        have:  `Current status: ${status ? `\`${status}\`` : '*(none)*'}`,
        fix:   `Open Discord → set your status → include \`${req.statusSubstring}\``,
      });
    }
  }

  // --- snapshot (taken once per user per giveaway) ---
  if (!giveaway.snapshots) giveaway.snapshots = {};
  if (!giveaway.snapshots[userId]) {
    giveaway.snapshots[userId] = {
      messagesBase: getUserMessageCount(guild.id, userId),
      vcMsBase:     getEffectiveTotalMs(guild.id, userId),
    };
    saveDb();
  }
  const snap = giveaway.snapshots[userId];

  // --- 2. Messages ---
  if (req.minMessages > 0) {
    const done = Math.max(0, getUserMessageCount(guild.id, userId) - snap.messagesBase);
    if (done < req.minMessages) {
      missing.push({
        label: '💬 Messages',
        need:  `Send **${req.minMessages}** messages in this server`,
        have:  `**${done} / ${req.minMessages}** messages sent`,
        fix:   `Send **${req.minMessages - done}** more messages`,
      });
    }
  }

  // --- 3. VC hours ---
  if (req.minVcHours > 0) {
    const vcMsDone  = Math.max(0, getEffectiveTotalMs(guild.id, userId) - snap.vcMsBase);
    const vcHrsDone = vcMsDone / 3_600_000;
    if (vcHrsDone < req.minVcHours) {
      const remaining = req.minVcHours - vcHrsDone;
      missing.push({
        label: '🎙️ Voice Time',
        need:  `Spend **${req.minVcHours}h** in voice channels`,
        have:  `**${formatDuration(vcMsDone)} / ${req.minVcHours}h** in VC`,
        fix:   `Join any voice channel for **${formatDuration(remaining * 3_600_000)}** more`,
      });
    }
  }

  return missing;
}

// Schedule a setTimeout for giveaways ≤7 days away; longer ones rely on the 60s tick.
function scheduleGiveaway(giveaway) {
  if (!giveaway.id || scheduledGiveaways.has(giveaway.id)) return;
  const delay = giveaway.endsAt - Date.now();
  if (delay > 7 * 24 * 60 * 60 * 1000) return;
  scheduledGiveaways.add(giveaway.id);
  setTimeout(async () => {
    scheduledGiveaways.delete(giveaway.id);
    await endGiveaway(giveaway.guildId, giveaway.id).catch(console.error);
  }, Math.max(0, delay));
}

async function endGiveaway(guildId, giveawayId) {
  const data     = getGuildData(guildId);
  const giveaway = data.giveaways?.[giveawayId];
  if (!giveaway || giveaway.ended || giveaway.cancelled) return;

  giveaway.ended   = true;
  giveaway.endedAt = Date.now();

  const pool    = [...(giveaway.entrants || [])];
  const count   = Math.min(giveaway.winnerCount || 1, pool.length);
  const winners = [];
  while (winners.length < count) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  giveaway.winners = winners;
  saveDb();

  const guild   = client.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = guild.channels.cache.get(giveaway.channelId);
  if (!channel) return;

  const msg = await channel.messages.fetch(giveawayId).catch(() => null);
  if (msg) await msg.edit({ embeds: [buildGiveawayEmbed(giveaway, guild)], components: [] }).catch(() => null);

  const winnersStr = winners.length > 0
    ? winners.map(id => `<@${id}>`).join(', ')
    : 'Nobody (no valid entries)';

  await channel.send({
    content: winners.length > 0 ? winners.map(id => `<@${id}>`).join(' ') : '',
    embeds: [new EmbedBuilder()
      .setColor(0x7b48cc)
      .setTitle('🎊 Giveaway Ended!')
      .setDescription([
        `**${giveaway.prize}**`, '',
        `🏆 **Winner(s):** ${winnersStr}`, '',
        msg ? `[Jump to giveaway](https://discord.com/channels/${guildId}/${giveaway.channelId}/${giveawayId})` : '',
      ].join('\n'))
      .setFooter({ text: `${(giveaway.entrants || []).length} total entr${(giveaway.entrants || []).length === 1 ? 'y' : 'ies'}` })
      .setTimestamp()],
    allowedMentions: { users: winners },
  }).catch(() => null);
}

async function handleGiveawayEntry(interaction) {
  const giveawayId = interaction.customId.replace('giveaway_enter:', '');
  const { guild }  = interaction;
  const data       = getGuildData(guild.id);
  const giveaway   = data.giveaways?.[giveawayId];

  if (!giveaway || giveaway.ended || giveaway.cancelled)
    return interaction.reply({ content: 'This giveaway is no longer active.', ephemeral: true });
  if (Date.now() > giveaway.endsAt)
    return interaction.reply({ content: 'This giveaway has already expired.', ephemeral: true });
  if ((giveaway.entrants || []).includes(interaction.user.id)) {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`🎟️ You're already entered! Good luck — winners drawn <t:${Math.floor(giveaway.endsAt / 1000)}:R>.`)],
      ephemeral: true,
    });
  }

  // Defer early — requirement check can involve DB reads + VC time calcs
  await interaction.deferReply({ ephemeral: true });

  const missing = await checkGiveawayRequirements(giveaway, interaction.member, guild);

  if (missing.length > 0) {
    const lines = missing.flatMap(m => [
      `**${m.label}**`,
      `→ Required: ${m.need}`,
      `→ Progress: ${m.have}`,
      `→ Next step: ${m.fix}`,
      '',
    ]);
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('❌ Requirements Not Met')
        .setDescription([
          "You're missing some requirements for this giveaway.",
          'Complete them and click **Enter Giveaway** again!',
          '',
          ...lines,
        ].join('\n'))
        .setFooter({ text: 'Progress is tracked automatically — just keep going!' })
        .setTimestamp()],
    });
  }

  // All requirements met
  if (!giveaway.entrants) giveaway.entrants = [];
  giveaway.entrants.push(interaction.user.id);
  saveDb();

  // Update embed entry count on original message
  await interaction.message.edit({
    embeds:     [buildGiveawayEmbed(giveaway, guild)],
    components: buildGiveawayComponents(giveawayId),
  }).catch(() => null);

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("🎉 You're entered!")
      .setDescription(`You've been added to the **${giveaway.prize}** giveaway.\n\n🍀 Good luck! Winners drawn <t:${Math.floor(giveaway.endsAt / 1000)}:R>.`)
      .setTimestamp()],
  });
}

async function handleGiveawaySlashCommand(interaction) {
  const sub  = interaction.options.getSubcommand();
  const data = getGuildData(interaction.guild.id);

  // /giveaway list — public
  if (sub === 'list') {
    const active = Object.values(data.giveaways || {}).filter(g => !g.ended && !g.cancelled);
    if (!active.length) return interaction.reply({ embeds: [simpleEmbed(0xff8a00, 'No active giveaways right now.')], ephemeral: true });
    const lines = active.map((g, i) => {
      const ch = interaction.guild.channels.cache.get(g.channelId);
      return `**${i + 1}.** **${g.prize}** in ${ch ? `<#${g.channelId}>` : '`unknown`'} — ends <t:${Math.floor(g.endsAt / 1000)}:R> — **${(g.entrants||[]).length}** ${(g.entrants||[]).length === 1 ? 'entry' : 'entries'}`;
    });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x7b48cc).setTitle('🎉 Active Giveaways').setDescription(lines.join('\n')).setTimestamp()],
    });
  }

  // All other subcommands require Manage Server
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
    return interaction.reply({ content: 'You need **Manage Server** for this command.', ephemeral: true });

  // /giveaway create
  if (sub === 'create') {
    const channel     = interaction.options.getChannel('channel', true);
    const prize       = interaction.options.getString('prize', true);
    const durationStr = interaction.options.getString('duration', true);
    const winnerCount = interaction.options.getInteger('winners') ?? 1;
    const description = interaction.options.getString('description') ?? null;
    const statusReq   = interaction.options.getString('status_required') ?? null;
    const minMessages = interaction.options.getInteger('min_messages') ?? 0;
    const minVcHours  = interaction.options.getNumber('min_vc_hours') ?? 0;

    if (!channel.isTextBased()) return interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
    const durationMs = parseTimeArg(durationStr);
    if (!durationMs || durationMs < 60_000) return interaction.reply({ content: 'Invalid duration. Try `30m`, `1h`, `24h`, or `7d`.', ephemeral: true });
    if (prize.length > 100) return interaction.reply({ content: 'Prize name must be 100 characters or fewer.', ephemeral: true });

    const endsAt   = Date.now() + durationMs;
    const giveaway = {
      id: null, channelId: channel.id, guildId: interaction.guild.id,
      prize, description, winnerCount,
      hostId: interaction.user.id,
      createdAt: Date.now(), endsAt,
      ended: false, endedAt: null, cancelled: false,
      winners: [], entrants: [],
      requirements: { statusSubstring: statusReq, minMessages, minVcHours },
      snapshots: {},
    };

    await interaction.deferReply({ ephemeral: true });

    const msg = await channel.send({
      embeds:     [buildGiveawayEmbed({ ...giveaway, id: 'pending' }, interaction.guild)],
      components: buildGiveawayComponents('pending'),
    }).catch((err) => { console.error('[Giveaway] post error:', err.message); return null; });

    if (!msg) return interaction.editReply('❌ Could not post in that channel — check my permissions.');

    giveaway.id = msg.id;
    await msg.edit({ embeds: [buildGiveawayEmbed(giveaway, interaction.guild)], components: buildGiveawayComponents(msg.id) }).catch(() => null);

    if (!data.giveaways) data.giveaways = {};
    data.giveaways[msg.id] = giveaway;
    saveDb();
    scheduleGiveaway(giveaway);

    const reqSummary = [
      statusReq   ? `📝 Status: \`${statusReq}\``   : null,
      minMessages ? `💬 Messages: ${minMessages}`     : null,
      minVcHours  ? `🎙️ VC Hours: ${minVcHours}h`   : null,
    ].filter(Boolean);

    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ Giveaway Created!')
        .addFields(
          { name: 'Prize',         value: prize,                                   inline: true },
          { name: 'Channel',       value: `<#${channel.id}>`,                      inline: true },
          { name: 'Ends',          value: `<t:${Math.floor(endsAt / 1000)}:R>`,    inline: true },
          { name: 'Winners',       value: String(winnerCount),                     inline: true },
          { name: 'Message ID',    value: `\`${msg.id}\``,                         inline: true },
          { name: 'Requirements',  value: reqSummary.length ? reqSummary.join('\n') : 'None', inline: false },
        ).setTimestamp()],
    });
  }

  // /giveaway end
  if (sub === 'end') {
    const msgId    = interaction.options.getString('message_id', true).trim();
    const giveaway = data.giveaways?.[msgId];
    if (!giveaway)          return interaction.reply({ content: 'Giveaway not found. Check the message ID with `/giveaway list`.', ephemeral: true });
    if (giveaway.ended)     return interaction.reply({ content: 'That giveaway already ended.', ephemeral: true });
    if (giveaway.cancelled) return interaction.reply({ content: 'That giveaway was cancelled.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    await endGiveaway(interaction.guild.id, msgId);
    return interaction.editReply(`✅ **${giveaway.prize}** has ended — winners have been announced.`);
  }

  // /giveaway reroll
  if (sub === 'reroll') {
    const msgId    = interaction.options.getString('message_id', true).trim();
    const newCount = interaction.options.getInteger('winners');
    const giveaway = data.giveaways?.[msgId];
    if (!giveaway)              return interaction.reply({ content: 'Giveaway not found.', ephemeral: true });
    if (!giveaway.ended)        return interaction.reply({ content: "That giveaway hasn't ended yet. Use `/giveaway end` first.", ephemeral: true });
    if (!(giveaway.entrants||[]).length) return interaction.reply({ content: 'No entries to reroll from.', ephemeral: true });

    const count   = newCount ?? giveaway.winnerCount;
    const pool    = [...(giveaway.entrants || [])];
    const winners = [];
    while (winners.length < Math.min(count, pool.length)) {
      const idx = Math.floor(Math.random() * pool.length);
      winners.push(pool.splice(idx, 1)[0]);
    }
    giveaway.winners = winners;
    saveDb();

    const channel = interaction.guild.channels.cache.get(giveaway.channelId);
    if (channel) {
      await channel.send({
        content: winners.map(id => `<@${id}>`).join(' '),
        embeds: [new EmbedBuilder().setColor(0x7b48cc).setTitle('🎊 Giveaway Rerolled!')
          .setDescription(`**Prize:** ${giveaway.prize}\n**New winner(s):** ${winners.map(id => `<@${id}>`).join(', ')}`)
          .setTimestamp()],
        allowedMentions: { users: winners },
      }).catch(() => null);
    }
    return interaction.reply({ content: `✅ Rerolled! New winner(s): ${winners.map(id => `<@${id}>`).join(', ')}`, ephemeral: true });
  }

  // /giveaway cancel
  if (sub === 'cancel') {
    const msgId    = interaction.options.getString('message_id', true).trim();
    const giveaway = data.giveaways?.[msgId];
    if (!giveaway)                              return interaction.reply({ content: 'Giveaway not found.', ephemeral: true });
    if (giveaway.cancelled)                     return interaction.reply({ content: 'Already cancelled.', ephemeral: true });
    if (giveaway.ended && !giveaway.cancelled)  return interaction.reply({ content: 'That giveaway already ended.', ephemeral: true });

    giveaway.cancelled = true;
    giveaway.ended     = true;
    giveaway.endedAt   = Date.now();
    saveDb();

    const channel = interaction.guild.channels.cache.get(giveaway.channelId);
    if (channel) {
      const msg = await channel.messages.fetch(msgId).catch(() => null);
      if (msg) await msg.edit({ embeds: [buildGiveawayEmbed(giveaway, interaction.guild)], components: [] }).catch(() => null);
    }
    return interaction.reply({ content: `✅ **${giveaway.prize}** giveaway cancelled.`, ephemeral: true });
  }
}

// =========================
// MOD WALLET SYSTEM
// Tracks per-user mod credits with a full timestamped history.
// Editors: whitelisted users OR users with Manage Server.
// History capped at 500 entries per user to keep DB lean.
// =========================

function getModWalletData(guildId) {
  const data = getGuildData(guildId);
  if (!data.modWallet) data.modWallet = { whitelist: [], users: {} };
  if (!Array.isArray(data.modWallet.whitelist)) data.modWallet.whitelist = [];
  if (!data.modWallet.users) data.modWallet.users = {};
  return data.modWallet;
}

function getModWalletUser(guildId, userId) {
  const mw = getModWalletData(guildId);
  if (!mw.users[userId]) mw.users[userId] = { balance: 0, totalEarned: 0, history: [] };
  const u = mw.users[userId];
  if (!Array.isArray(u.history))    u.history     = [];
  if (!Number.isFinite(u.balance))  u.balance     = 0;
  if (!Number.isFinite(u.totalEarned)) u.totalEarned = 0;
  return u;
}

// Returns true if the member can edit mod wallets
function isModWalletEditor(guildId, member) {
  return hasManagerPerm(member) || getModWalletData(guildId).whitelist.includes(member.id);
}

// Sum of positive deltas (credits gained) since a given timestamp
function calcEarnedSince(history, sinceMs) {
  return history.filter(h => h.at >= sinceMs && h.delta > 0).reduce((s, h) => s + h.delta, 0);
}

// Append a transaction to the user's history and update their balance.
// Caller is responsible for calling saveDb() afterwards.
function logModWalletTx(guildId, userId, type, delta, newBalance, reason, byId) {
  const u = getModWalletUser(guildId, userId);
  if (delta > 0) u.totalEarned = (u.totalEarned || 0) + delta;
  u.history.push({ type, delta, balance: newBalance, reason: reason || null, by: byId, at: Date.now() });
  if (u.history.length > 500) u.history = u.history.slice(-500); // keep last 500
  u.balance = newBalance;
}

function buildModWalletEmbed(guildId, member) {
  const u     = getModWalletUser(guildId, member.id);
  const now   = Date.now();
  const DAY   = 86_400_000;

  const e24h  = calcEarnedSince(u.history, now - DAY);
  const e7d   = calcEarnedSince(u.history, now - 7 * DAY);
  const e30d  = calcEarnedSince(u.history, now - 30 * DAY);
  const eAll  = u.totalEarned || 0;

  const fmt = (n) => n.toLocaleString('en-US');

  // Recent activity — last 5 transactions, newest first
  const recent = [...u.history].reverse().slice(0, 5);
  const recentValue = recent.length > 0
    ? recent.map(h => {
        const sign   = h.delta >= 0 ? `+${fmt(h.delta)}` : fmt(h.delta);
        const reason = h.reason ? ` ꔷ *${h.reason}*` : '';
        return `> **${sign}**${reason}\n> by <@${h.by}> ꔷ <t:${Math.floor(h.at / 1000)}:R>`;
      }).join('\n\n')
    : '*(no transactions yet)*';

  return new EmbedBuilder()
    .setColor(0xf5a623)
    .setTitle(`💎 Mod Wallet — ${member.displayName}`)
    .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 128 }))
    .addFields(
      {
        name:  '💰 Balance',
        value: `**${fmt(u.balance)}** credits`,
        inline: false,
      },
      {
        name: '📊 Credits Earned',
        value: [
          `> **Last 24h** ꔷ +${fmt(e24h)}`,
          `> **Last 7d** ꔷ +${fmt(e7d)}`,
          `> **Last 30d** ꔷ +${fmt(e30d)}`,
          `> **All Time** ꔷ +${fmt(eAll)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name:  '📋 Recent Activity',
        value: recentValue,
        inline: false,
      },
    )
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();
}

async function handleModWalletCommand(message, args) {
  const sub = (args.shift() || 'check').toLowerCase();

  // ── PUBLIC ──────────────────────────────────────────────────────────────────
  if (sub === 'check' || sub === 'balance' || sub === 'bal') {
    let target = message.member;
    if (args[0]) {
      const found = await getTargetMember(message, args[0]);
      if (found) target = found;
    }
    return message.reply({ embeds: [buildModWalletEmbed(message.guild.id, target)], allowedMentions: { parse: [] } });
  }

  if (sub === 'lb' || sub === 'leaderboard' || sub === 'top') {
    const mw   = getModWalletData(message.guild.id);
    const rows = Object.entries(mw.users)
      .map(([id, u]) => ({ id, balance: u.balance || 0 }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 10);
    if (!rows.length) return message.reply({ embeds: [simpleEmbed(0xf5a623, 'No mod wallet data yet.')] });
    const medals = ['🥇', '🥈', '🥉'];
    const lines  = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.id}> — **${r.balance.toLocaleString('en-US')}** credits`);
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0xf5a623).setTitle('💎 Mod Wallet Leaderboard').setDescription(lines.join('\n')).setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // ── WHITELIST MANAGEMENT (Manage Server only) ────────────────────────────────
  if (sub === 'whitelist' || sub === 'wl') {
    if (!hasManagerPerm(message.member)) return message.reply('You need Manage Server to manage the editor whitelist.');
    const sub2 = (args.shift() || 'list').toLowerCase();
    const mw   = getModWalletData(message.guild.id);

    if (sub2 === 'add') {
      const target = await getTargetMember(message, args[0]);
      if (!target) return replySyntax(message, `${PREFIX}mw whitelist add @user`);
      if (mw.whitelist.includes(target.id))
        return message.reply({ embeds: [simpleEmbed(0xffa500, `${target} is already on the editor whitelist.`)], allowedMentions: { parse: [] } });
      mw.whitelist.push(target.id); saveDb();
      return message.reply({ embeds: [simpleEmbed(0x57f287, `✅ Added ${target} to the mod wallet editor whitelist.`)], allowedMentions: { parse: [] } });
    }

    if (sub2 === 'remove' || sub2 === 'rm') {
      const target = await getTargetMember(message, args[0]);
      if (!target) return replySyntax(message, `${PREFIX}mw whitelist remove @user`);
      if (!mw.whitelist.includes(target.id))
        return message.reply({ embeds: [simpleEmbed(0xffa500, `${target} is not on the whitelist.`)], allowedMentions: { parse: [] } });
      mw.whitelist = mw.whitelist.filter(id => id !== target.id); saveDb();
      return message.reply({ embeds: [simpleEmbed(0xed4245, `Removed ${target} from the editor whitelist.`)], allowedMentions: { parse: [] } });
    }

    // list
    if (!mw.whitelist.length) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xf5a623).setTitle('💎 Mod Wallet Whitelist')
        .setDescription('No users whitelisted yet.\n\nUse `*mw whitelist add @user` to allow someone to edit wallets.\n\n*Users with Manage Server can always edit regardless of whitelist.*')
        .setTimestamp()] });
    }
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0xf5a623).setTitle('💎 Mod Wallet Editor Whitelist')
        .setDescription(mw.whitelist.map((id, i) => `**${i + 1}.** <@${id}>`).join('\n'))
        .setFooter({ text: 'Users with Manage Server can always edit without being whitelisted.' })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // ── EDITOR COMMANDS (whitelist OR Manage Server) ─────────────────────────────
  if (!isModWalletEditor(message.guild.id, message.member)) {
    return message.reply({
      embeds: [simpleEmbed(0xed4245,
        "You don't have permission to edit mod wallets.\nAsk an admin to whitelist you: `*mw whitelist add @you`")],
    });
  }

  if (sub === 'add') {
    const target = await getTargetMember(message, args[0]);
    const amount = Math.floor(Number((args[1] || '').replace(/,/g, '')));
    if (!target || !Number.isFinite(amount) || amount <= 0)
      return replySyntax(message, `${PREFIX}mw add @user <amount> [reason]`);
    if (target.user.bot) return message.reply('Cannot add credits to a bot.');
    const reason = args.slice(2).join(' ').trim() || null;
    const u      = getModWalletUser(message.guild.id, target.id);
    const before = u.balance;
    const after  = before + amount;
    logModWalletTx(message.guild.id, target.id, 'add', amount, after, reason, message.author.id);
    saveDb();
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('💎 Mod Credits Added')
        .setDescription([
          `${target} received **+${amount.toLocaleString('en-US')}** credits.`,
          reason ? `\n> **Reason:** ${reason}` : '',
          `\n\n> Before: **${before.toLocaleString('en-US')}** → After: **${after.toLocaleString('en-US')}**`,
        ].join(''))
        .setFooter({ text: `Added by ${message.author.username}` }).setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'deduct' || sub === 'remove' || sub === 'subtract' || sub === 'sub') {
    const target = await getTargetMember(message, args[0]);
    const amount = Math.floor(Number((args[1] || '').replace(/,/g, '')));
    if (!target || !Number.isFinite(amount) || amount <= 0)
      return replySyntax(message, `${PREFIX}mw deduct @user <amount> [reason]`);
    const reason = args.slice(2).join(' ').trim() || null;
    const u      = getModWalletUser(message.guild.id, target.id);
    const before = u.balance;
    const after  = Math.max(0, before - amount);
    const actual = before - after; // how much was actually removed (capped at balance)
    logModWalletTx(message.guild.id, target.id, 'deduct', -actual, after, reason, message.author.id);
    saveDb();
    return message.reply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('💎 Mod Credits Deducted')
        .setDescription([
          `${target} lost **\u2212${actual.toLocaleString('en-US')}** credits.`,
          reason ? `\n> **Reason:** ${reason}` : '',
          `\n\n> Before: **${before.toLocaleString('en-US')}** → After: **${after.toLocaleString('en-US')}**`,
        ].join(''))
        .setFooter({ text: `Deducted by ${message.author.username}` }).setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'set') {
    const target = await getTargetMember(message, args[0]);
    const amount = Math.floor(Number((args[1] || '').replace(/,/g, '')));
    if (!target || !Number.isFinite(amount) || amount < 0)
      return replySyntax(message, `${PREFIX}mw set @user <amount> [reason]`);
    const reason = args.slice(2).join(' ').trim() || null;
    const u      = getModWalletUser(message.guild.id, target.id);
    const before = u.balance;
    const delta  = amount - before;
    logModWalletTx(message.guild.id, target.id, 'set', delta, amount, reason, message.author.id);
    saveDb();
    const color  = amount >= before ? 0x57f287 : 0xed4245;
    const sign   = delta >= 0 ? `+${delta.toLocaleString('en-US')}` : `\u2212${Math.abs(delta).toLocaleString('en-US')}`;
    return message.reply({
      embeds: [new EmbedBuilder().setColor(color).setTitle('💎 Mod Credits Set')
        .setDescription([
          `${target}'s credits set to **${amount.toLocaleString('en-US')}** (${sign}).`,
          reason ? `\n> **Reason:** ${reason}` : '',
          `\n\n> Before: **${before.toLocaleString('en-US')}** → After: **${amount.toLocaleString('en-US')}**`,
        ].join(''))
        .setFooter({ text: `Set by ${message.author.username}` }).setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'reset') {
    const target = await getTargetMember(message, args[0]);
    if (!target) return replySyntax(message, `${PREFIX}mw reset @user [reason]`);
    const reason = args.slice(1).join(' ').trim() || null;
    const u      = getModWalletUser(message.guild.id, target.id);
    const before = u.balance;
    logModWalletTx(message.guild.id, target.id, 'set', -before, 0, reason || 'Reset', message.author.id);
    saveDb();
    return message.reply({
      embeds: [simpleEmbed(0xed4245, `Reset ${target}'s mod wallet to **0** (was ${before.toLocaleString('en-US')} credits).`)],
      allowedMentions: { parse: [] },
    });
  }

  // Default: show help embed
  return message.reply({
    embeds: [new EmbedBuilder().setColor(0xf5a623).setTitle('💎 Mod Wallet — Commands').setDescription([
      '**Public**',
      `> \`${PREFIX}mw\` / \`${PREFIX}mw check [@user]\` — View wallet`,
      `> \`${PREFIX}mw lb\` — Leaderboard`,
      '',
      '**Editors** *(whitelisted or Manage Server)*',
      `> \`${PREFIX}mw add @user <amount> [reason]\` — Add credits`,
      `> \`${PREFIX}mw deduct @user <amount> [reason]\` — Deduct credits`,
      `> \`${PREFIX}mw set @user <amount> [reason]\` — Set balance to exact amount`,
      `> \`${PREFIX}mw reset @user [reason]\` — Reset balance to 0`,
      '',
      '**Admin** *(Manage Server only)*',
      `> \`${PREFIX}mw whitelist add @user\` — Grant edit access`,
      `> \`${PREFIX}mw whitelist remove @user\` — Revoke edit access`,
      `> \`${PREFIX}mw whitelist list\` — View all editors`,
    ].join('\n')).setTimestamp()],
  });
}

// =========================
// FRIEND GROUPS
// Groups are stored by display name. Stats pull from existing
// messageCounts + vcTrack data — which auto-update every tick
// and include live in-memory session data for zero-lag accuracy.
// =========================

function getFriendGroupList(guildId) {
  const data = getGuildData(guildId);
  if (!data.friendGroups) data.friendGroups = {};
  return data.friendGroups;
}

// Case-insensitive group lookup — returns { key, group } or null
function findFriendGroup(guildId, name) {
  const groups = getFriendGroupList(guildId);
  const key    = Object.keys(groups).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? { key, group: groups[key] } : null;
}

// Parses a string like "@user1 @user2 123456789012345678" into a deduped
// list of user IDs. Accepts both <@id> / <@!id> mentions and raw snowflakes,
// in any quantity, separated by whitespace.
function parseUserIdsFromText(text) {
  const matches = String(text || '').match(/<@!?(\d{16,25})>|\b(\d{16,25})\b/g) || [];
  const ids = matches.map((m) => (m.match(/\d{16,25}/) || [])[0]).filter(Boolean);
  return [...new Set(ids)];
}

// Resolves parsed IDs to actual guild members, separating valid hits from
// IDs that don't correspond to a member of this guild.
async function resolveMembersFromIds(guild, ids) {
  const resolved = [];
  const failed   = [];
  for (const id of ids) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member) resolved.push(member);
    else failed.push(id);
  }
  return { resolved, failed };
}

function buildFriendGroupStatsEmbed(guildId, guild, group) {
  const role  = group.roleId ? guild.roles.cache.get(group.roleId) : null;
  const color = role?.color || 0x5865f2;

  // Gather live stats for every member
  const members = (group.memberIds || []).map(id => ({
    id,
    member:   guild.members.cache.get(id),
    messages: getUserMessageCount(guildId, id),
    vcMs:     getEffectiveTotalMs(guildId, id),
  })).sort((a, b) => b.messages - a.messages);

  const totalMessages = members.reduce((s, m) => s + m.messages, 0);
  const totalVcMs     = members.reduce((s, m) => s + m.vcMs, 0);

  const memberLines = members.length > 0
    ? members.map((m, i) => {
        const live = vcSessions.has(`${guildId}:${m.id}`) ? ' 🔴' : '';
        return [
          `> **${i + 1}.** ${m.member ? `<@${m.id}>` : `\`${m.id}\``}${live}`,
          `> ‎ ‎ ‎ ‎ 💬 **${m.messages.toLocaleString('en-US')}** msgs  ꔷ  🎙️ **${formatDuration(m.vcMs)}** in VC`,
        ].join('\n');
      }).join('\n\n')
    : '*(no members)*';

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`👥 ${group.name}`)
    .setDescription(role ? `<@&${group.roleId}>  ꔷ  ${members.length} member${members.length === 1 ? '' : 's'}` : `${members.length} member${members.length === 1 ? '' : 's'} *(role deleted)*`)
    .addFields(
      {
        name:  '📊 Group Totals',
        value: [
          `> 💬 **${totalMessages.toLocaleString('en-US')}** total messages`,
          `> 🎙️ **${formatDuration(totalVcMs)}** total voice time`,
        ].join('\n'),
        inline: false,
      },
      {
        name:  '👤 Members — ranked by messages',
        value: memberLines,
        inline: false,
      },
    )
    .setFooter({ text: '🔴 = currently in VC  ꔷ  Click 🔄 to refresh' })
    .setTimestamp();
}

function buildFriendGroupRefreshRow(groupKey) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`fg_refresh:${groupKey}`)
      .setLabel('Refresh Stats')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  )];
}

async function handleFriendGroupInteraction(interaction) {
  const sub  = interaction.options.getSubcommand();
  const data = getGuildData(interaction.guild.id);
  if (!data.friendGroups) data.friendGroups = {};

  // ── PUBLIC: list, stats ─────────────────────────────────────────────────────
  if (sub === 'list') {
    const groups = Object.values(data.friendGroups);
    if (!groups.length) {
      return interaction.reply({
        embeds: [simpleEmbed(0x5865f2, 'No friend groups yet.\n\nCreate one with `/friendgroup create`.')],
        ephemeral: true,
      });
    }
    const lines = groups.map((g, i) => {
      const role    = g.roleId ? interaction.guild.roles.cache.get(g.roleId) : null;
      const roleTxt = role ? ` ꔷ <@&${g.roleId}>` : '';
      return `**${i + 1}.** **${g.name}**${roleTxt} ꔷ **${(g.memberIds || []).length}** member(s)`;
    });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('👥 Friend Groups')
        .setDescription(lines.join('\n')).setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  if (sub === 'stats') {
    const name  = interaction.options.getString('name', true);
    const found = findFriendGroup(interaction.guild.id, name);
    if (!found)
      return interaction.reply({ content: `Friend group \`${name}\` not found. Use \`/friendgroup list\` to see all groups.`, ephemeral: true });
    return interaction.reply({
      embeds:     [buildFriendGroupStatsEmbed(interaction.guild.id, interaction.guild, found.group)],
      components: buildFriendGroupRefreshRow(found.key),
      allowedMentions: { parse: [] },
    });
  }

  // ── Manage Server required below ───────────────────────────────────────────
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
    return interaction.reply({ content: 'You need **Manage Server** to manage friend groups.', ephemeral: true });

  // ── create ─────────────────────────────────────────────────────────────────
  if (sub === 'create') {
    const name      = interaction.options.getString('name', true).trim();
    const colorHex  = (interaction.options.getString('color') || '').replace('#', '').trim();
    const membersIn = interaction.options.getString('members', true);
    const userIds   = parseUserIdsFromText(membersIn);

    if (!name || name.length > 50)
      return interaction.reply({ content: 'Group name must be 1–50 characters.', ephemeral: true });
    if (findFriendGroup(interaction.guild.id, name))
      return interaction.reply({ content: `A group called \`${name}\` already exists.`, ephemeral: true });
    if (!userIds.length)
      return interaction.reply({ content: 'Mention at least one member, e.g. `@user1 @user2 @user3`.', ephemeral: true });

    await interaction.deferReply();

    const roleColor = /^[0-9a-fA-F]{6}$/.test(colorHex) ? Number.parseInt(colorHex, 16) : 0x5865f2;

    const role = await interaction.guild.roles.create({
      name, color: roleColor,
      reason: `Friend group "${name}" created by ${interaction.user.tag}`,
    }).catch(err => { console.error('[FriendGroup] role create error:', err.message); return null; });

    if (!role) return interaction.editReply('❌ Failed to create the role — check I have Manage Roles permission.');

    const { resolved, failed } = await resolveMembersFromIds(interaction.guild, userIds);
    const memberIds = [];
    const added     = [];

    for (const member of resolved) {
      if (member.user.bot) continue;
      try {
        await member.roles.add(role, `Friend group "${name}" — initial member`);
        memberIds.push(member.id);
        added.push(`<@${member.id}>`);
      } catch { failed.push(member.id); }
    }

    data.friendGroups[name] = {
      name, roleId: role.id, memberIds,
      createdAt: Date.now(), createdBy: interaction.user.id,
    };
    saveDb();

    const desc = [
      `Created **${name}** with role ${role}!`,
      added.length  ? `\nMembers added: ${added.join(', ')}`         : '',
      failed.length ? `\nCould not add: ${failed.map(id => `\`${id}\``).join(', ')}` : '',
      '\n\nUse `/friendgroup add` to add more members and `/friendgroup stats` to view activity.',
    ].join('');

    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(roleColor).setTitle('👥 Friend Group Created!')
        .setDescription(desc)
        .addFields(
          { name: 'Group',   value: name,          inline: true },
          { name: 'Role',    value: `${role}`,      inline: true },
          { name: 'Members', value: String(memberIds.length), inline: true },
        )
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // ── add ────────────────────────────────────────────────────────────────────
  if (sub === 'add') {
    const name      = interaction.options.getString('name', true);
    const found     = findFriendGroup(interaction.guild.id, name);
    if (!found) return interaction.reply({ content: `Group \`${name}\` not found.`, ephemeral: true });
    const { key, group } = found;
    const role      = group.roleId ? interaction.guild.roles.cache.get(group.roleId) : null;
    const membersIn = interaction.options.getString('members', true);
    const userIds   = parseUserIdsFromText(membersIn);

    if (!userIds.length)
      return interaction.reply({ content: 'Mention at least one member, e.g. `@user1 @user2 @user3`.', ephemeral: true });

    await interaction.deferReply();

    const { resolved, failed: unresolved } = await resolveMembersFromIds(interaction.guild, userIds);
    const added   = [];
    const already = [];
    const failed  = [...unresolved];

    for (const member of resolved) {
      if (member.user.bot) continue;
      if ((group.memberIds || []).includes(member.id)) { already.push(`<@${member.id}>`); continue; }
      try {
        if (role) await member.roles.add(role, `Added to friend group "${group.name}"`);
        if (!group.memberIds) group.memberIds = [];
        group.memberIds.push(member.id);
        added.push(`<@${member.id}>`);
      } catch { failed.push(member.id); }
    }
    saveDb();

    const lines = [
      added.length   ? `✅ Added: ${added.join(', ')}`                                  : '',
      already.length ? `⚠️ Already in group: ${already.join(', ')}`                    : '',
      failed.length  ? `❌ Failed: ${failed.map(id => `\`${id}\``).join(', ')}`         : '',
    ].filter(Boolean);

    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`👥 ${group.name} — Members Updated`)
        .setDescription(lines.join('\n') || 'No changes made.')
        .setFooter({ text: `${(group.memberIds || []).length} member(s) in group` })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // ── remove ─────────────────────────────────────────────────────────────────
  if (sub === 'remove') {
    const name      = interaction.options.getString('name', true);
    const found     = findFriendGroup(interaction.guild.id, name);
    if (!found) return interaction.reply({ content: `Group \`${name}\` not found.`, ephemeral: true });
    const { key, group } = found;
    const role      = group.roleId ? interaction.guild.roles.cache.get(group.roleId) : null;
    const membersIn = interaction.options.getString('members', true);
    const userIds   = parseUserIdsFromText(membersIn);

    if (!userIds.length)
      return interaction.reply({ content: 'Mention at least one member, e.g. `@user1 @user2 @user3`.', ephemeral: true });

    await interaction.deferReply();

    const removed = [];
    const notIn   = [];

    for (const userId of userIds) {
      if (!(group.memberIds || []).includes(userId)) { notIn.push(`<@${userId}>`); continue; }
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (member && role) await member.roles.remove(role, `Removed from friend group "${group.name}"`).catch(() => null);
      group.memberIds = (group.memberIds || []).filter(id => id !== userId);
      removed.push(`<@${userId}>`);
    }
    saveDb();

    const lines = [
      removed.length ? `✅ Removed: ${removed.join(', ')}`     : '',
      notIn.length   ? `⚠️ Not in group: ${notIn.join(', ')}`  : '',
    ].filter(Boolean);

    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`👥 ${group.name} — Members Removed`)
        .setDescription(lines.join('\n') || 'No changes made.')
        .setFooter({ text: `${(group.memberIds || []).length} member(s) remaining` })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // ── delete ─────────────────────────────────────────────────────────────────
  if (sub === 'delete') {
    const name  = interaction.options.getString('name', true);
    const found = findFriendGroup(interaction.guild.id, name);
    if (!found) return interaction.reply({ content: `Group \`${name}\` not found.`, ephemeral: true });
    const { key, group } = found;

    await interaction.deferReply();

    const role = group.roleId ? interaction.guild.roles.cache.get(group.roleId) : null;
    if (role) await role.delete(`Friend group "${group.name}" deleted by ${interaction.user.tag}`).catch(() => null);

    delete data.friendGroups[key];
    saveDb();

    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('👥 Friend Group Deleted')
        .setDescription(`**${group.name}** has been deleted${role ? ' and its role removed' : ''}.`)
        .setTimestamp()],
    });
  }
}

// =========================
// ANTISPAM / RATE LIMITER
// Keeps command usage feeling smooth while preventing spam and API hammering.
// Cooldowns are short and only felt by people actively spamming.
// The bot owner is always exempt.
//
// Tuning (all configurable via env):
//   COOLDOWN_GENERAL  — ms between any commands           (default 1500)
//   COOLDOWN_HEAVY    — ms between economy/gambling cmds  (default 2500)
//   SPAM_THRESHOLD    — commands in window before block    (default 6)
//   SPAM_WINDOW_MS    — sliding window length in ms        (default 8000)
//   SPAM_BLOCK_MS     — how long a block lasts            (default 25000)
// =========================

const COOLDOWN_GENERAL = Number(process.env.COOLDOWN_GENERAL || 1500);
const COOLDOWN_HEAVY   = Number(process.env.COOLDOWN_HEAVY   || 2500);
const SPAM_THRESHOLD   = Number(process.env.SPAM_THRESHOLD   || 6);
const SPAM_WINDOW_MS   = Number(process.env.SPAM_WINDOW_MS   || 8_000);
const SPAM_BLOCK_MS    = Number(process.env.SPAM_BLOCK_MS    || 25_000);

// In-memory only — resets on restart, no DB needed
const _cmdCooldowns = new Map(); // "guildId:userId" → last command timestamp
const _spamTrackers = new Map(); // "guildId:userId" → { count, windowStart, blockedUntil, lastWarnAt }

// Commands that get a longer cooldown (balance-affecting / resource-intensive)
const HEAVY_CMDS = new Set([
  'coinflip','cf','slots','slot','dice','roulette','rl',
  'blackjack','bj','tictactoe','ttt','daily','work','beg','donate','pay',
]);

/**
 * Check whether a command from this user should be allowed right now.
 * Returns null if allowed, or an object describing the block if not.
 */
function checkRateLimit(guildId, userId, command) {
  if (isBotOwner(userId)) return null;  // owner is always exempt

  const key = `${guildId}:${userId}`;
  const now = Date.now();

  // ── Spam tracker (sliding window) ──────────────────────────────────────────
  let tracker = _spamTrackers.get(key);
  if (!tracker) {
    tracker = { count: 0, windowStart: now, blockedUntil: 0, lastWarnAt: 0 };
    _spamTrackers.set(key, tracker);
  }

  // Still blocked?
  if (now < tracker.blockedUntil) {
    const remaining = tracker.blockedUntil - now;
    // Only surface a warning message every 5 seconds so the replies don't pile up
    if (now - tracker.lastWarnAt >= 5_000) {
      tracker.lastWarnAt = now;
      return { type: 'blocked', remainingMs: remaining };
    }
    return { type: 'silent' };
  }

  // Reset window if it has expired
  if (now - tracker.windowStart > SPAM_WINDOW_MS) {
    tracker.count       = 0;
    tracker.windowStart = now;
  }
  tracker.count++;

  // Too many commands in the window — apply a block
  if (tracker.count >= SPAM_THRESHOLD) {
    tracker.blockedUntil = now + SPAM_BLOCK_MS;
    tracker.count        = 0;
    tracker.lastWarnAt   = now;
    return { type: 'blocked', remainingMs: SPAM_BLOCK_MS };
  }

  // ── Per-command cooldown ────────────────────────────────────────────────────
  const cooldownMs = HEAVY_CMDS.has(command) ? COOLDOWN_HEAVY : COOLDOWN_GENERAL;
  const lastUsed   = _cmdCooldowns.get(key) || 0;
  const elapsed    = now - lastUsed;

  if (elapsed < cooldownMs) {
    const remaining = cooldownMs - elapsed;
    // Don't bother replying for tiny remainders (< 400ms) — just silently drop
    return remaining < 400 ? { type: 'silent' } : { type: 'cooldown', remainingMs: remaining };
  }

  _cmdCooldowns.set(key, now);
  return null; // allowed
}

async function handleRateLimitReply(message, result) {
  if (result.type === 'silent') return;

  const embed = result.type === 'blocked'
    ? new EmbedBuilder().setColor(0xed4245)
        .setDescription(`⛔ Slow down! You're sending commands too fast.\nTry again in **${Math.ceil(result.remainingMs / 1000)}s**.`)
    : new EmbedBuilder().setColor(0xffa500)
        .setDescription(`⏱️ Wait **${(result.remainingMs / 1000).toFixed(1)}s** before using another command.`);

  const ttl   = result.type === 'blocked' ? 5_000 : 3_000;
  const reply = await message.reply({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  if (reply) setTimeout(() => reply.delete().catch(() => null), ttl);
}

// =========================
// GENERAL HELPERS
// =========================
// Returns true only for the user whose ID matches OWNER_ID env var.
function isBotOwner(userId) {
  if (!OWNER_ID) return false;
  return userId === OWNER_ID;
}

// =========================
// OWNER: SERVER LIST + LEAVE
// =========================
async function handleServersCommand(message, args) {
  if (!isBotOwner(message.author.id)) {
    return message.reply({ embeds: [simpleEmbed(0xed4245, '❌ This command is restricted to the bot owner.')] });
  }

  const PAGE_SIZE  = 15;
  const page       = Math.max(1, Number.parseInt(args[0] || '1', 10) || 1);
  const allGuilds  = [...client.guilds.cache.values()]
    .sort((a, b) => b.memberCount - a.memberCount);
  const totalPages = Math.max(1, Math.ceil(allGuilds.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const offset     = (safePage - 1) * PAGE_SIZE;
  const slice      = allGuilds.slice(offset, offset + PAGE_SIZE);

  const lines = slice.map((g, i) => {
    const ts = g.joinedTimestamp ? `<t:${Math.floor(g.joinedTimestamp / 1000)}:d>` : 'unknown';
    return [
      `**${offset + i + 1}.** **${g.name}**`,
      `> 👥 **${g.memberCount.toLocaleString('en-US')}** members ꔷ \`${g.id}\` ꔷ joined ${ts}`,
    ].join('\n');
  });

  return message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🌐 Servers')
      .setDescription(lines.join('\n\n') || '*(no servers)*')
      .setFooter({ text: `Page ${safePage}/${totalPages} ꔷ ${allGuilds.length} total servers ꔷ ${PREFIX}servers <page> to navigate` })
      .setTimestamp()],
  });
}

async function handleLeaveCommand(message, args) {
  if (!isBotOwner(message.author.id)) {
    return message.reply({ embeds: [simpleEmbed(0xed4245, '❌ This command is restricted to the bot owner.')] });
  }

  const guildId = (args[0] || '').trim();
  if (!guildId || !/^\d{16,25}$/.test(guildId))
    return replySyntax(message, `${PREFIX}leave <serverId>`, `Use \`${PREFIX}servers\` to get server IDs.`);

  const guild = client.guilds.cache.get(guildId);
  if (!guild)
    return message.reply({ embeds: [simpleEmbed(0xed4245, `Bot is not in a server with ID \`${guildId}\`.`)] });

  const leavingCurrent = message.guild?.id === guildId;
  const confirmId      = `lv_${Date.now()}`;

  const confirmMsg = await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle('⚠️ Confirm Leave')
      .setDescription([
        `Leave **${guild.name}**?`,
        `> 👥 **${guild.memberCount.toLocaleString('en-US')}** members`,
        `> 🆔 \`${guild.id}\``,
        leavingCurrent ? '\n> ⚠️ **This is the current server** — the bot will leave and this message will be the last one.' : '',
      ].join('\n'))
      .setFooter({ text: 'This action cannot be undone — the bot will have to be re-invited.' })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${confirmId}:yes`).setLabel('Leave Server').setStyle(ButtonStyle.Danger).setEmoji('🚪'),
      new ButtonBuilder().setCustomId(`${confirmId}:no`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });

  const collector = confirmMsg.createMessageComponentCollector({ time: 30_000 });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id)
      return interaction.reply({ content: 'Only the bot owner can confirm this.', ephemeral: true });

    if (interaction.customId === `${confirmId}:no`) {
      collector.stop('cancelled');
      return interaction.update({ embeds: [simpleEmbed(0x57f287, '✅ Leave cancelled.')], components: [] });
    }

    if (interaction.customId === `${confirmId}:yes`) {
      collector.stop('confirmed');
      if (!leavingCurrent) {
        await interaction.update({
          embeds: [simpleEmbed(0x57f287, `✅ Successfully left **${guild.name}**.`)],
          components: [],
        });
      }
      await guild.leave().catch((err) => console.error('[Leave] error:', err.message));
    }
  });

  collector.on('end', async (_c, reason) => {
    if (reason === 'time') {
      await confirmMsg.edit({ embeds: [simpleEmbed(0x888888, 'Leave request timed out.')], components: [] }).catch(() => null);
    }
  });
}

function hasManagerPerm(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
    || member.permissions.has(PermissionsBitField.Flags.ManageChannels);
}
function hasUwUPerm(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
    || member.permissions.has(PermissionsBitField.Flags.ManageMessages);
}
function cleanName(name) {
  return String(name || 'User').replace(/[^a-zA-Z0-9 _.-]/g, '').trim().slice(0, 24) || 'User';
}
function getVcUsername(member) {
  return cleanName(member?.user?.username || member?.user?.globalName || member?.displayName || 'User');
}
function parseUserId(text) {
  if (!text) return null;
  const m = text.match(/^<@!?(\d{16,25})>$/) || text.match(/^(\d{16,25})$/);
  return m ? m[1] : null;
}
function syntaxEmbed(syntax, extra = '') {
  return new EmbedBuilder().setTitle('Incorrect Syntax')
    .setDescription(['**Syntax:**', `\`${syntax}\``, extra ? `\n${extra}` : ''].join('\n'));
}
function economyErrorEmbed(title, desc) { return new EmbedBuilder().setTitle(title).setDescription(desc); }
function premiumEmbed(title, description, color = 0xff8a00) {
  const text = Array.isArray(description) ? description.join('\n') : String(description || '');
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(text)
    .setFooter({ text: 'Smoke Bucks Economy • Premium Games' }).setTimestamp();
}
function simpleEmbed(color, desc) { return new EmbedBuilder().setColor(color).setDescription(desc).setTimestamp(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function animatedReply(message, frames = [], finalPayload = null, delayMs = 900) {
  const safeFrames = Array.isArray(frames) ? frames.filter(Boolean) : [];
  let sent;
  try {
    if (safeFrames.length > 0) sent = await message.reply({ ...safeFrames[0], allowedMentions: { parse: [] } });
    else if (finalPayload)     return message.reply({ ...finalPayload, allowedMentions: { parse: [] } });
    else return null;
    for (const frame of safeFrames.slice(1)) {
      await sleep(delayMs);
      await sent.edit({ ...frame, allowedMentions: { parse: [] } }).catch(() => null);
    }
    if (finalPayload) { await sleep(delayMs); await sent.edit({ ...finalPayload, allowedMentions: { parse: [] } }).catch(() => null); }
    return sent;
  } catch (err) {
    console.error('animatedReply error:', err);
    return finalPayload ? message.reply({ ...finalPayload, allowedMentions: { parse: [] } }).catch(() => null) : null;
  }
}
function replySyntax(message, syntax, extra = '') {
  return message.reply({ embeds: [syntaxEmbed(syntax, extra)], allowedMentions: { parse: [] } });
}
function formatBucks(n) { return Number(n || 0).toLocaleString('en-US'); }
const activeBlackjackGames = new Map();
const activeTttGames       = new Map();
function makeGameId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

async function getTargetMember(message, arg) {
  const mentioned = message.mentions.members.first();
  if (mentioned) return mentioned;
  const id = parseUserId(arg);
  if (!id) return null;
  try { return await message.guild.members.fetch(id); } catch { return null; }
}
function isTempVcChat(channel) {
  if (!channel || !channel.guild || channel.type !== ChannelType.GuildVoice) return false;
  return Boolean(getGuildData(channel.guild.id).tempVcs[channel.id]);
}
function vcHelpEmbed() {
  return new EmbedBuilder().setTitle('Voice Channel Controls').setDescription([
    `Use these commands anywhere with prefix \`${PREFIX}\`.`, '',
    `\`${PREFIX}vc lock\` - Lock your VC`,      `\`${PREFIX}vc unlock\` - Unlock your VC`,
    `\`${PREFIX}vc hide\` - Hide your VC`,       `\`${PREFIX}vc unhide\` - Unhide your VC`,
    `\`${PREFIX}vc permit @user\` - Let a user join`, `\`${PREFIX}vc reject @user\` - Remove/block a user`,
    `\`${PREFIX}vc transfer @user\` - Transfer ownership`, `\`${PREFIX}vc limit 5\` - Set user limit`,
    `\`${PREFIX}vc rename new name\` - Rename VC`, `\`${PREFIX}vc bitrate 96\` - Set bitrate kbps`,
    `\`${PREFIX}vc claim\` - Claim if owner left`,  `\`${PREFIX}vc info\` - Show VC info`,
  ].join('\n')).setFooter({ text: 'Users cannot chat inside created VC chats.' });
}

// =========================
// UWUIFY
// =========================
const UWU_FACES = ['uwu','owo','UwU','OwO','>w<','^w^','(≧◡≦)','(｡♥‿♥｡)','(つ✧ω✧)つ','~','nya~','hehe~'];
const UWU_REPLACEMENTS = [
  [/\br\b/gi,'w'],[/\bl\b/gi,'w'],[/r/gi,'w'],[/l/gi,'w'],[/ove/gi,'uv'],[/you/gi,'chu'],
  [/no/gi,'nu'],[/the/gi,'da'],[/this/gi,'dis'],[/that/gi,'dat'],[/what/gi,'wut'],
  [/hello/gi,'hewwo'],[/hi/gi,'hai'],[/friend/gi,'fwiend'],[/server/gi,'sewvew'],
  [/really/gi,'weawwy'],[/little/gi,'wittle'],[/cute/gi,'kawaii'],[/cool/gi,'coow'],
  [/na/gi,'nya'],[/ne/gi,'nye'],[/ni/gi,'nyi'],[/nu/gi,'nyu'],
];
function maybeStutterWord(word) {
  if (!/^[a-zA-Z]{3,}$/.test(word) || Math.random() > 0.22) return word;
  return `${word[0]}-${word}`;
}
function uwuifyText(input) {
  let text = String(input || '');
  if (!text.trim()) return text;
  for (const [from, to] of UWU_REPLACEMENTS) text = text.replace(from, to);
  text = text.split(/(\s+)/).map((p) => (p.trim() ? maybeStutterWord(p) : p)).join('');
  text = text.replace(/[.!?]+/g, (m) => `${m}${Math.random() > 0.5 ? '!' : '~'}`);
  const f1 = UWU_FACES[Math.floor(Math.random() * UWU_FACES.length)];
  const f2 = UWU_FACES[Math.floor(Math.random() * UWU_FACES.length)];
  return `${text} ${f1} ${Math.random() > 0.6 ? f2 : ''}`.trim();
}
async function getOrCreateWebhook(channel) {
  if (!channel || typeof channel.fetchWebhooks !== 'function') return null;
  const me    = channel.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.ManageWebhooks)) return null;
  const hooks    = await channel.fetchWebhooks();
  const existing = hooks.find((h) => h.owner?.id === client.user.id && h.name === 'UwUify');
  if (existing) return existing;
  return channel.createWebhook({ name: 'UwUify' });
}
async function handleUwUMessage(message) {
  if (!message.guild || message.author.bot || !message.content) return;
  const data = getGuildData(message.guild.id);
  if (!data.uwuTargets.includes(message.author.id)) return;
  const perms = message.channel.permissionsFor(message.guild.members.me);
  if (!perms?.has(PermissionsBitField.Flags.ManageMessages)) return;
  let webhook;
  try { webhook = await getOrCreateWebhook(message.channel); } catch (err) { console.error('Webhook error:', err); return; }
  if (!webhook) return;
  const uwuContent    = uwuifyText(message.content);
  const attachmentUrls = [...message.attachments.values()].map((a) => a.url);
  const finalContent  = [uwuContent, ...attachmentUrls].filter(Boolean).join('\n');
  try {
    await message.delete().catch(() => null);
    await webhook.send({
      content: finalContent.slice(0, 2000),
      username:  message.member?.displayName || message.author.username,
      avatarURL: message.author.displayAvatarURL({ extension: 'png', size: 128 }),
      allowedMentions: { parse: [] },
    });
  } catch (err) { console.error('UwU send/delete error:', err); }
}

// =========================
// VOICEMASTER
// =========================
function botOverwrite(guild) {
  return {
    id: guild.members.me.id,
    allow: [
      PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.MoveMembers,
      PermissionsBitField.Flags.ReadMessageHistory,
    ],
  };
}
function publicVcOverwrites(guild) {
  return [
    { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect], deny: [PermissionsBitField.Flags.SendMessages] },
    botOverwrite(guild),
  ];
}
function privateVcOverwrites(guild, ownerId) {
  return [
    { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.SendMessages] },
    { id: ownerId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect], deny: [PermissionsBitField.Flags.SendMessages] },
    botOverwrite(guild),
  ];
}
async function setupVoiceMaster(message) {
  if (!hasManagerPerm(message.member)) return message.reply('You need Manage Server or Manage Channels to run this.');
  const { guild } = message;
  const data = getGuildData(guild.id);
  const pubCat  = await guild.channels.create({ name: 'Public Voice Channels',  type: ChannelType.GuildCategory, reason: 'VoiceMaster setup' });
  const privCat = await guild.channels.create({ name: 'Private Voice Channels', type: ChannelType.GuildCategory, reason: 'VoiceMaster setup' });
  const joinPub  = await guild.channels.create({ name: 'Join Public VC',  type: ChannelType.GuildVoice, parent: pubCat.id,  permissionOverwrites: publicVcOverwrites(guild),  reason: 'VoiceMaster setup' });
  const randPub  = await guild.channels.create({ name: 'Random Public VC',type: ChannelType.GuildVoice, parent: pubCat.id,  permissionOverwrites: publicVcOverwrites(guild),  reason: 'VoiceMaster setup' });
  const joinPriv = await guild.channels.create({ name: 'Join Private VC', type: ChannelType.GuildVoice, parent: privCat.id, permissionOverwrites: publicVcOverwrites(guild),  reason: 'VoiceMaster setup' });
  data.vm = { publicCategoryId: pubCat.id, privateCategoryId: privCat.id, joinPublicId: joinPub.id, randomPublicId: randPub.id, joinPrivateId: joinPriv.id };
  saveDb();
  return message.reply('VoiceMaster setup complete. Join the created VC channels to test it.');
}
async function sendControlEmbed(channel, member) {
  try { await channel.send({ content: `<@${member.id}>`, embeds: [vcHelpEmbed()], allowedMentions: { users: [member.id] } }); }
  catch (err) { console.error('Could not send VC control embed:', err); }
}
async function createTempVc(member, type = 'public') {
  const { guild } = member;
  const data = getGuildData(guild.id);
  const { vm } = data;
  if (!vm) return null;
  const base      = getVcUsername(member);
  const isPrivate = type === 'private';
  const channel   = await guild.channels.create({
    name: isPrivate ? `${base}'s Private VC` : `${base}'s Public VC`,
    type: ChannelType.GuildVoice,
    parent: isPrivate ? vm.privateCategoryId : vm.publicCategoryId,
    permissionOverwrites: isPrivate ? privateVcOverwrites(guild, member.id) : publicVcOverwrites(guild),
    reason: `Temporary ${type} VC by VoiceMaster`,
  });
  data.tempVcs[channel.id] = { ownerId: member.id, ownerUsername: member.user.username, type, createdAt: Date.now() };
  saveDb();
  try { await member.voice.setChannel(channel, 'VoiceMaster temp VC'); } catch (err) { console.error('Could not move user to temp VC:', err); }
  await sendControlEmbed(channel, member);
  return channel;
}
async function cleanupTempVc(guild, channelId) {
  const data = getGuildData(guild.id);
  if (!data.tempVcs[channelId]) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) { delete data.tempVcs[channelId]; saveDb(); return; }
  if (channel.members.filter((m) => !m.user.bot).size > 0) return;
  delete data.tempVcs[channelId];
  saveDb();
  try { await channel.delete('Temporary VC empty'); } catch (err) { console.error('Could not delete temp VC:', err); }
}

// =========================
// VOICE STATE UPDATE  (VoiceMaster + VC Time tracking)
// =========================
async function handleVoiceStateUpdate(oldState, newState) {
  const guild  = newState.guild  || oldState.guild;
  const member = newState.member || oldState.member;
  if (!member) return;

  const wasInVc    = Boolean(oldState.channelId);
  const isInVc     = Boolean(newState.channelId);
  const sessionKey = `${guild.id}:${member.id}`;

  // ── VC Time Tracking ──────────────────────────────────────────────────────
  if (!member.user.bot) {
    if (!wasInVc && isInVc) {
      // Joined VC — start session clock
      vcSessions.set(sessionKey, Date.now());
    } else if (wasInVc && !isInVc) {
      // Left VC — flush elapsed time to DB immediately (precise to the second)
      const start = vcSessions.get(sessionKey);
      if (start) {
        addVcMs(guild.id, member.id, Date.now() - start);
        saveDb();
        vcSessions.delete(sessionKey);
        await checkAndGrantVcMilestones(guild, member.id);
      }
    }
    // Channel switch: session continues uninterrupted — no change needed
  }

  // ── VoiceMaster ───────────────────────────────────────────────────────────
  const data = getGuildData(guild.id);
  const { vm } = data;

  if (newState.channelId && vm && !member.user.bot) {
    if (newState.channelId === vm.joinPublicId) {
      await createTempVc(member, 'public');
    } else if (newState.channelId === vm.joinPrivateId) {
      await createTempVc(member, 'private');
    } else if (newState.channelId === vm.randomPublicId) {
      const publicTemps = Object.entries(data.tempVcs)
        .filter(([, r]) => r.type === 'public')
        .map(([id]) => guild.channels.cache.get(id))
        .filter((ch) => ch && ch.members.filter((m) => !m.user.bot).size > 0);
      if (publicTemps.length > 0) {
        try { await member.voice.setChannel(publicTemps[Math.floor(Math.random() * publicTemps.length)], 'VoiceMaster random'); }
        catch (err) { console.error('Random VC move error:', err); }
      } else {
        await createTempVc(member, 'public');
      }
    }
  }
  if (oldState.channelId && data.tempVcs[oldState.channelId])
    setTimeout(() => cleanupTempVc(guild, oldState.channelId), TEMP_VC_DELETE_DELAY);
}

// =========================
// VC COMMANDS
// =========================
function getCurrentTempVc(message) {
  const voice = message.member.voice.channel;
  if (!voice) return { error: 'You need to be inside one of your temporary voice channels.' };
  const data   = getGuildData(message.guild.id);
  const record = data.tempVcs[voice.id];
  if (!record)  return { error: 'You are not inside a VoiceMaster temporary VC.' };
  return { channel: voice, record, data };
}
function isVcOwnerOrAdmin(message, record) {
  return record.ownerId === message.author.id || hasManagerPerm(message.member);
}
async function handleVcCommand(message, args) {
  const sub = (args.shift() || 'help').toLowerCase();
  if (sub === 'help') return message.reply({ embeds: [vcHelpEmbed()] });
  const current = getCurrentTempVc(message);
  if (current.error) return message.reply(current.error);
  const { channel, record, data } = current;

  if (sub === 'claim') {
    if (channel.members.has(record.ownerId) && !hasManagerPerm(message.member))
      return message.reply('The current owner is still in the VC.');
    record.ownerId = message.author.id; saveDb();
    return message.reply(`You are now the owner of ${channel}.`);
  }
  if (!isVcOwnerOrAdmin(message, record))
    return message.reply('Only the VC owner can use this command. Use `*vc claim` if the owner left.');

  if (sub === 'lock') {
    await channel.permissionOverwrites.edit(message.guild.roles.everyone.id, { Connect: false, SendMessages: false });
    if (data.vm?.privateCategoryId && channel.parentId !== data.vm.privateCategoryId)
      await channel.setParent(data.vm.privateCategoryId, { lockPermissions: false, reason: 'VC locked' }).catch(() => null);
    record.type = 'private'; data.tempVcs[channel.id] = record; saveDb();
    return message.reply('Locked your VC and moved it to the private category.');
  }
  if (sub === 'unlock') {
    await channel.permissionOverwrites.edit(message.guild.roles.everyone.id, { ViewChannel: true, Connect: true, SendMessages: false });
    if (data.vm?.publicCategoryId && channel.parentId !== data.vm.publicCategoryId)
      await channel.setParent(data.vm.publicCategoryId, { lockPermissions: false, reason: 'VC unlocked' }).catch(() => null);
    record.type = 'public'; data.tempVcs[channel.id] = record; saveDb();
    return message.reply('Unlocked your VC and moved it to the public category.');
  }
  if (sub === 'hide') { await channel.permissionOverwrites.edit(message.guild.roles.everyone.id, { ViewChannel: false, SendMessages: false }); return message.reply('Hid your VC.'); }
  if (sub === 'unhide') { await channel.permissionOverwrites.edit(message.guild.roles.everyone.id, { ViewChannel: true, SendMessages: false }); return message.reply('Unhid your VC.'); }
  if (sub === 'permit') {
    const target = await getTargetMember(message, args[0]);
    if (!target) return replySyntax(message, `${PREFIX}vc permit @user`);
    await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true, SendMessages: false });
    return message.reply(`Permitted ${target} to join your VC.`);
  }
  if (sub === 'reject') {
    const target = await getTargetMember(message, args[0]);
    if (!target) return replySyntax(message, `${PREFIX}vc reject @user`);
    await channel.permissionOverwrites.edit(target.id, { ViewChannel: false, Connect: false, SendMessages: false });
    if (target.voice?.channelId === channel.id) await target.voice.setChannel(null).catch(() => null);
    return message.reply(`Rejected ${target} from your VC.`);
  }
  if (sub === 'transfer') {
    const target = await getTargetMember(message, args[0]);
    if (!target) return replySyntax(message, `${PREFIX}vc transfer @user`);
    if (target.user.bot) return message.reply('You cannot transfer ownership to a bot.');
    record.ownerId = target.id; data.tempVcs[channel.id] = record; saveDb();
    await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true, SendMessages: false });
    return message.reply(`Transferred VC ownership to ${target}.`);
  }
  if (sub === 'limit') {
    const limit = Number.parseInt(args[0], 10);
    if (Number.isNaN(limit) || limit < 0 || limit > 99) return replySyntax(message, `${PREFIX}vc limit 5`, 'Use 0-99. 0 = no limit.');
    await channel.setUserLimit(limit);
    return message.reply(limit === 0 ? 'Removed the user limit.' : `Set the user limit to ${limit}.`);
  }
  if (sub === 'rename') {
    const newName = args.join(' ').trim();
    if (!newName) return replySyntax(message, `${PREFIX}vc rename new name`);
    if (newName.length > 80) return message.reply('Name too long — keep it under 80 characters.');
    await channel.setName(newName);
    return message.reply(`Renamed your VC to **${newName}**.`);
  }
  if (sub === 'bitrate') {
    const kbps = Number.parseInt(args[0], 10);
    if (Number.isNaN(kbps) || kbps < 8) return replySyntax(message, `${PREFIX}vc bitrate 96`);
    const final = Math.min(kbps * 1000, message.guild.maximumBitrate || 96000);
    await channel.setBitrate(final);
    return message.reply(`Set bitrate to ${Math.round(final / 1000)} kbps.`);
  }
  if (sub === 'info') {
    const owner = await message.guild.members.fetch(record.ownerId).catch(() => null);
    return message.reply({ embeds: [new EmbedBuilder().setTitle('VC Info').addFields(
      { name: 'Channel', value: `${channel}`, inline: true },
      { name: 'Owner',   value: owner ? `${owner}` : `<@${record.ownerId}>`, inline: true },
      { name: 'Type',    value: record.type || 'public', inline: true },
      { name: 'Members', value: `${channel.members.filter((m) => !m.user.bot).size}`, inline: true },
      { name: 'Limit',   value: channel.userLimit ? `${channel.userLimit}` : 'None', inline: true },
    )] });
  }
  return replySyntax(message, `${PREFIX}vc help`, 'Unknown subcommand.');
}

// =========================
// ECONOMY CONSTANTS
// =========================
const STARTING_BALANCE   = Number(process.env.STARTING_BALANCE  || 500);
const DAILY_REWARD       = Number(process.env.DAILY_REWARD      || 2500);
const WORK_MIN           = Number(process.env.WORK_MIN          || 250);
const WORK_MAX           = Number(process.env.WORK_MAX          || 1200);
const BEG_MIN            = Number(process.env.BEG_MIN           || 25);
const BEG_MAX            = Number(process.env.BEG_MAX           || 350);
const DAILY_COOLDOWN_MS  = 24 * 60 * 60 * 1000;
const WORK_COOLDOWN_MS   = Number(process.env.WORK_COOLDOWN_MS  || 15 * 60 * 1000);
const BEG_COOLDOWN_MS    = Number(process.env.BEG_COOLDOWN_MS   || 5  * 60 * 1000);
const DONATE_DAILY_LIMIT = Number(process.env.DONATE_DAILY_LIMIT || 250_000);
const MAX_BET            = Number(process.env.MAX_BET           || 150_000);

function getEcoUser(guildId, userId) {
  const data = getGuildData(guildId);
  if (!data.economy.users[userId]) {
    data.economy.users[userId] = { balance: STARTING_BALANCE, totalEarned: STARTING_BALANCE, totalLost: 0, dailyStreak: 0, lastDaily: 0, lastWork: 0, lastBeg: 0, donatedToday: 0, donateWindowStart: 0, wins: 0, losses: 0 };
    saveDb();
  }
  return data.economy.users[userId];
}
function addBalance(guildId, userId, amount) {
  const user = getEcoUser(guildId, userId);
  user.balance = Math.max(0, Math.floor((user.balance || 0) + amount));
  if (amount > 0) user.totalEarned = Math.floor((user.totalEarned || 0) + amount);
  if (amount < 0) user.totalLost   = Math.floor((user.totalLost   || 0) + Math.abs(amount));
  saveDb(); return user;
}
function timeLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function economyHelpEmbed() {
  return new EmbedBuilder().setColor(0xff8a00).setTitle('💸 Smoke Bucks Economy Help').setDescription([
    'Welcome to the **Smoke Bucks** economy.', '',
    '✨ **Main Commands**',
    `> \`${PREFIX}balance\` / \`${PREFIX}bal\` — Check your balance`,
    `> \`${PREFIX}balance @user\` — Check another user`,
    `> \`${PREFIX}daily\` — Claim your daily reward`,
    `> \`${PREFIX}work\` — Work for Smoke Bucks`,
    `> \`${PREFIX}beg\` — Beg for a small amount`,
    `> \`${PREFIX}donate @user amount\` / \`${PREFIX}pay @user amount\``,
    `> \`${PREFIX}leaderboard\` / \`${PREFIX}lb\` — Top balances`,
    `> \`${PREFIX}quests\` / \`${PREFIX}missions\` — Daily missions`,
    '', '🎰 **Games**',
    `> \`${PREFIX}coinflip amount heads/tails\``,
    `> \`${PREFIX}slots amount\``,
    `> \`${PREFIX}dice amount over/under\``,
    `> \`${PREFIX}roulette amount red/black/green\``,
    `> \`${PREFIX}blackjack amount\``,
    `> \`${PREFIX}ttt @user [amount]\``,
    '', `Max bet: **${formatBucks(MAX_BET)}** • Daily donate limit: **${formatBucks(DONATE_DAILY_LIMIT)}**`,
  ].join('\n')).setFooter({ text: 'amount can be a number, half, or all' }).setTimestamp();
}
function parseAmountArg(arg, balance) {
  if (!arg) return null;
  const lower = String(arg).toLowerCase();
  if (lower === 'all')  return Math.min(balance, MAX_BET);
  if (lower === 'half') return Math.min(Math.floor(balance / 2), MAX_BET);
  const n = Math.floor(Number(lower.replace(/,/g, '')));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_BET);
}

// =========================
// DAILY QUESTS / MISSIONS
// =========================
const QUEST_RESET_TZ        = process.env.QUEST_RESET_TZ        || 'America/Los_Angeles';
const REGULAR_QUESTS_PER_DAY = Number(process.env.REGULAR_QUESTS_PER_DAY || 3);
const BOOSTER_QUESTS_PER_DAY = Number(process.env.BOOSTER_QUESTS_PER_DAY || 5);
const activeVcQuestSessions  = new Map();

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: QUEST_RESET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const QUEST_POOL = [
  { id:'chat_25',       type:'chat',          goal:25,    reward:600,  name:'Chat 25 messages',          desc:'Send 25 messages in the server.' },
  { id:'chat_50',       type:'chat',          goal:50,    reward:1200, name:'Chat 50 messages',          desc:'Send 50 messages in the server.' },
  { id:'chat_100',      type:'chat',          goal:100,   reward:2800, name:'Chat 100 messages',         desc:'Send 100 messages in the server.' },
  { id:'vc_10',         type:'vc_minutes',    goal:10,    reward:900,  name:'VC for 10 minutes',         desc:'Stay active in a voice channel for 10 minutes.' },
  { id:'vc_20',         type:'vc_minutes',    goal:20,    reward:1800, name:'VC for 20 minutes',         desc:'Stay active in a voice channel for 20 minutes.' },
  { id:'vc_45',         type:'vc_minutes',    goal:45,    reward:3500, name:'VC for 45 minutes',         desc:'Stay active in a voice channel for 45 minutes.' },
  { id:'ttt_play_1',    type:'play_ttt',      goal:1,     reward:700,  name:'Play Tic-Tac-Toe',          desc:'Play 1 Tic-Tac-Toe game.' },
  { id:'ttt_play_3',    type:'play_ttt',      goal:3,     reward:2200, name:'Play Tic-Tac-Toe 3 times',  desc:'Play 3 Tic-Tac-Toe games.' },
  { id:'ttt_win_1',     type:'win_ttt',       goal:1,     reward:2000, name:'Win Tic-Tac-Toe',           desc:'Win 1 Tic-Tac-Toe game.' },
  { id:'bj_play_2',     type:'play_blackjack',goal:2,     reward:1000, name:'Play Blackjack 2 times',    desc:'Play 2 blackjack games.' },
  { id:'bj_play_5',     type:'play_blackjack',goal:5,     reward:2600, name:'Play Blackjack 5 times',    desc:'Play 5 blackjack games.' },
  { id:'slots_play_3',  type:'play_slots',    goal:3,     reward:1200, name:'Spin Slots 3 times',        desc:'Play slots 3 times.' },
  { id:'slots_play_5',  type:'play_slots',    goal:5,     reward:2200, name:'Spin Slots 5 times',        desc:'Play slots 5 times.' },
  { id:'coinflip_win_1',type:'win_coinflip',  goal:1,     reward:1800, name:'Win a Coinflip',            desc:'Win 1 coinflip.' },
  { id:'roulette_win_1',type:'win_roulette',  goal:1,     reward:2500, name:'Win Roulette',              desc:'Win 1 roulette game.' },
  { id:'dice_play_3',   type:'play_dice',     goal:3,     reward:1100, name:'Roll Dice 3 times',         desc:'Play dice 3 times.' },
  { id:'gamble_win_2',  type:'win_gamble',    goal:2,     reward:2600, name:'Win 2 Gambling Games',      desc:'Win any 2 gambling games.' },
  { id:'daily_use',     type:'use_daily',     goal:1,     reward:750,  name:'Claim Daily',               desc:'Use your daily reward command.' },
  { id:'work_2',        type:'use_work',      goal:2,     reward:1200, name:'Work 2 times',              desc:'Use the work command 2 times.' },
  { id:'work_3',        type:'use_work',      goal:3,     reward:2200, name:'Work 3 times',              desc:'Use the work command 3 times.' },
  { id:'donate_1',      type:'donate',        goal:1,     reward:1500, name:'Donate Smoke Bucks',        desc:'Donate Smoke Bucks to another member once.' },
  { id:'wager_2500',    type:'wager',         goal:2500,  reward:2000, name:'Wager 2,500 Smoke Bucks',   desc:'Wager 2,500 total Smoke Bucks in games.' },
  { id:'wager_10000',   type:'wager',         goal:10000, reward:5500, name:'Wager 10,000 Smoke Bucks',  desc:'Wager 10,000 total Smoke Bucks in games.' },
];
function shuffleSeeded(items, seedText) {
  const arr = [...items]; let seed = 0;
  for (const ch of String(seedText)) seed = ((seed << 5) - seed + ch.charCodeAt(0)) >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function ensureQuestStore(data) {
  if (!data.economy.quests) data.economy.quests = { users: {} };
  if (!data.economy.quests.users) data.economy.quests.users = {};
  return data.economy.quests;
}
function getQuestUser(guildId, userId) {
  const data  = getGuildData(guildId);
  const store = ensureQuestStore(data);
  if (!store.users[userId]) store.users[userId] = { date: '', quests: [], lastTextChannelId: null };
  return store.users[userId];
}
function isBooster(member)   { return Boolean(member?.premiumSince); }
function questCountFor(member) { return isBooster(member) ? BOOSTER_QUESTS_PER_DAY : REGULAR_QUESTS_PER_DAY; }
function assignDailyQuests(member) {
  const guildId = member.guild.id;
  const qUser   = getQuestUser(guildId, member.id);
  const key     = todayKey();
  const count   = questCountFor(member);
  if (qUser.date === key && Array.isArray(qUser.quests) && qUser.quests.length >= count) return qUser.quests.slice(0, count);
  const selected = []; const usedTypes = new Set();
  const shuffled = shuffleSeeded(QUEST_POOL, `${guildId}:${member.id}:${key}:${(qUser.quests||[]).map((q) => q.id).join(',')}`);
  for (const quest of shuffled) {
    if (selected.length >= count) break;
    if (usedTypes.has(quest.type)) continue;
    selected.push({ ...quest, progress: 0, completed: false, paid: false, completedAt: 0 }); usedTypes.add(quest.type);
  }
  for (const quest of shuffled) {
    if (selected.length >= count) break;
    if (!selected.some((q) => q.id === quest.id)) selected.push({ ...quest, progress: 0, completed: false, paid: false, completedAt: 0 });
  }
  qUser.date = key; qUser.quests = selected; saveDb();
  return qUser.quests;
}
function questProgressBar(done, goal) {
  const filled = Math.min(10, Math.floor((Number(done||0) / Math.max(1, Number(goal||1))) * 10));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}
function questsEmbed(member) {
  const quests = assignDailyQuests(member);
  const lines  = quests.map((q, i) => {
    const prog   = Math.min(q.progress||0, q.goal||1);
    const status = q.completed ? '✅' : '✨';
    return [`${status} **${i+1}. ${q.name}**`, `> ${q.desc}`, `> ${questProgressBar(prog, q.goal)} **${formatBucks(prog)}/${formatBucks(q.goal)}** • Reward: **${formatBucks(q.reward)}**`].join('\n');
  });
  return new EmbedBuilder().setColor(0xff8a00).setTitle('📜 Daily Smoke Quests')
    .setDescription([`${member} here are your missions for **${todayKey()}**.`, isBooster(member) ? '🚀 Booster bonus: **5 quests today**.' : 'Members get **3 quests daily**. Boosters get **5**.', '', ...lines].join('\n'))
    .setFooter({ text: 'Rewards are paid automatically on completion.' }).setTimestamp();
}
async function notifyQuestComplete(guild, userId, quest) {
  const qUser   = getQuestUser(guild.id, userId);
  const channel = qUser.lastTextChannelId ? guild.channels.cache.get(qUser.lastTextChannelId) : null;
  if (!channel?.isTextBased?.()) return;
  await channel.send({ content: `<@${userId}>`, embeds: [premiumEmbed('✅ Mission Complete', `You completed **${quest.name}** and earned **${formatBucks(quest.reward)} Smoke Bucks**.`)], allowedMentions: { users: [userId] } }).catch(() => null);
}
async function progressQuest(guild, memberOrUserId, type, amount = 1, channelId = null) {
  if (!guild || !type || !amount) return;
  const member = typeof memberOrUserId === 'string' ? await guild.members.fetch(memberOrUserId).catch(() => null) : memberOrUserId;
  const userId = typeof memberOrUserId === 'string' ? memberOrUserId : memberOrUserId?.id;
  if (!userId || !member || member.user?.bot) return;
  const qUser  = getQuestUser(guild.id, userId);
  if (channelId) qUser.lastTextChannelId = channelId;
  const quests = assignDailyQuests(member);
  let changed  = false;
  for (const quest of quests) {
    if (quest.completed || quest.type !== type) continue;
    quest.progress = Math.min(quest.goal, (quest.progress||0) + amount); changed = true;
    if (quest.progress >= quest.goal) {
      quest.completed = true; quest.paid = true; quest.completedAt = Date.now();
      addBalance(guild.id, userId, quest.reward);
      await notifyQuestComplete(guild, userId, quest);
    }
  }
  if (changed) saveDb();
}
function rememberLastTextChannel(message) {
  const qUser = getQuestUser(message.guild.id, message.author.id);
  qUser.lastTextChannelId = message.channel.id; saveDb();
}

// Combined 60s tick: quest VC minutes + VC milestone time accumulation
async function tickVcTracking() {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;
      for (const member of channel.members.values()) {
        if (member.user.bot) continue;
        const key = `${guild.id}:${member.id}`;

        // Quest VC progress
        const qSess = activeVcQuestSessions.get(key) || { lastTick: now };
        const diff  = Math.max(0, now - (qSess.lastTick || now));
        qSess.lastTick = now;
        activeVcQuestSessions.set(key, qSess);
        if (diff > 0) await progressQuest(guild, member, 'vc_minutes', diff / 60000);

        // VC Milestone time accumulation
        const sessionStart = vcSessions.get(key);
        if (!sessionStart) {
          // Bot restarted while user was already in VC
          vcSessions.set(key, now);
        } else {
          const elapsed = now - sessionStart;
          if (elapsed > 0) {
            addVcMs(guild.id, member.id, elapsed);
            vcSessions.set(key, now); // reset so next tick doesn't double-count
            await checkAndGrantVcMilestones(guild, member.id);
          }
        }
      }
    }
  }
  // Flush message count buffer to DB
  for (const [bufKey, count] of messageCountBuffer) {
    const [gId, uId] = bufKey.split(':');
    const d = getGuildData(gId);
    if (!d.messageCounts) d.messageCounts = {};
    d.messageCounts[uId] = (d.messageCounts[uId] || 0) + count;
  }
  messageCountBuffer.clear();

  // Check for giveaways that have expired (catches long-running ones & post-restart)
  for (const guild of client.guilds.cache.values()) {
    const d = getGuildData(guild.id);
    for (const [id, g] of Object.entries(d.giveaways || {})) {
      if (!g.ended && !g.cancelled && Date.now() >= g.endsAt) {
        await endGiveaway(guild.id, id).catch(console.error);
      }
    }
  }

  // Clean up expired rate limit entries so Maps don't grow unbounded
  const _cleanNow = Date.now();
  for (const [k, ts] of _cmdCooldowns) {
    if (_cleanNow - ts > 10_000) _cmdCooldowns.delete(k);
  }
  for (const [k, t] of _spamTrackers) {
    if (_cleanNow > (t.blockedUntil || 0) && _cleanNow - t.windowStart > SPAM_WINDOW_MS * 3)
      _spamTrackers.delete(k);
  }

  saveDb(); // single batch write after all updates
}

function betOrSyntax(message, amountArg, syntax) {
  const user = getEcoUser(message.guild.id, message.author.id);
  const bet  = parseAmountArg(amountArg, user.balance);
  if (!bet) return { error: () => replySyntax(message, syntax, 'Amount can be a number, `half`, or `all`.') };
  if (bet > user.balance) return { error: () => message.reply({ embeds: [economyErrorEmbed('Not Enough Smoke Bucks', `You only have **${formatBucks(user.balance)}** Smoke Bucks.`)] }) };
  return { user, bet };
}
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// =========================
// BLACKJACK
// =========================
function drawCard() {
  const v = randInt(1, 13);
  if (v === 1)   return { label: 'A', value: 11 };
  if (v >= 11)   return { label: ['J','Q','K'][v-11], value: 10 };
  return { label: String(v), value: v };
}
function handValue(hand) {
  let total = hand.reduce((s, c) => s + c.value, 0);
  let aces  = hand.filter((c) => c.label === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function handText(hand) { return hand.map((c) => c.label).join(', '); }
function blackjackRows(gameId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${gameId}:hit`).setLabel('🃏 Hit').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${gameId}:stand`).setLabel('🛑 Stand').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  )];
}
function blackjackEmbed(game, finished = false) {
  const pv = handValue(game.player);
  const dv = finished ? handValue(game.dealer) : handValue([game.dealer[0]]);
  const status = finished ? game.resultText : 'Choose **🃏 Hit** or **🛑 Stand** to play your hand.';
  return new EmbedBuilder().setColor(finished ? 0xff8a00 : 0x5865f2).setTitle(finished ? '♠️ Blackjack Results' : '♠️ Premium Blackjack')
    .setDescription([`👤 **Player:** <@${game.userId}>`, `💸 **Bet:** ${formatBucks(game.bet)} Smoke Bucks`, '', '🃏 **Your Hand**', `> ${handText(game.player)}  •  **${pv}**`, '', '🏦 **Dealer Hand**', finished ? `> ${handText(game.dealer)}  •  **${dv}**` : `> ${game.dealer[0].label}, ❔ Hidden`, '', `✨ ${status}`].join('\n'))
    .setFooter({ text: 'Smoke Bucks Casino' }).setTimestamp();
}
function finishBlackjackGame(guildId, game, outcome) {
  if (outcome === 'win')  { addBalance(guildId, game.userId, game.bet * 2); getEcoUser(guildId, game.userId).wins = (getEcoUser(guildId, game.userId).wins||0)+1; game.resultText = `You won **${formatBucks(game.bet)}** Smoke Bucks.`; }
  else if (outcome === 'push') { addBalance(guildId, game.userId, game.bet); game.resultText = 'Push. Your bet was returned.'; }
  else { getEcoUser(guildId, game.userId).losses = (getEcoUser(guildId, game.userId).losses||0)+1; game.resultText = `You lost **${formatBucks(game.bet)}** Smoke Bucks.`; }
  saveDb(); activeBlackjackGames.delete(`${guildId}:${game.userId}`);
}
async function startInteractiveBlackjack(message, command, args) {
  const parsed = betOrSyntax(message, args[0], `${PREFIX}${command} amount`);
  if (parsed.error) return parsed.error();
  const key = `${message.guild.id}:${message.author.id}`;
  if (activeBlackjackGames.has(key)) return message.reply({ embeds: [economyErrorEmbed('Game Already Running','Finish your current blackjack game first.')] });
  addBalance(message.guild.id, message.author.id, -parsed.bet);
  await progressQuest(message.guild, message.member, 'play_blackjack', 1, message.channel.id);
  await progressQuest(message.guild, message.member, 'wager', parsed.bet, message.channel.id);
  const gameId = makeGameId('bj');
  const game   = { gameId, userId: message.author.id, bet: parsed.bet, player: [drawCard(),drawCard()], dealer: [drawCard(),drawCard()], resultText: '' };
  activeBlackjackGames.set(key, game);
  const dealFrames = [
    premiumEmbed('♠️ Premium Blackjack',['Opening the table...','','```','Dealer is shuffling...','```'].join('\n'), 0x5865f2),
    premiumEmbed('♠️ Premium Blackjack',['Cards are being dealt...','','```','Player: 🂠 🂠','Dealer: 🂠 🂠','```'].join('\n'), 0x5865f2),
    premiumEmbed('♠️ Premium Blackjack',['Revealing your hand...','',`Player: **${handText(game.player)}**`,'Dealer: one card hidden...'], 0x5865f2),
  ];
  const gm = await message.reply({ embeds: [dealFrames[0]], components: [], allowedMentions: { parse: [] } });
  for (const frame of dealFrames.slice(1)) { await sleep(900); await gm.edit({ embeds: [frame], components: [] }).catch(() => null); }
  await sleep(900);
  await gm.edit({ embeds: [blackjackEmbed(game)], components: blackjackRows(gameId) }).catch(() => null);
  const finishAndEdit = async (outcome) => { finishBlackjackGame(message.guild.id, game, outcome); await gm.edit({ embeds: [blackjackEmbed(game,true)], components: blackjackRows(gameId,true) }).catch(() => null); };
  if (handValue(game.player) === 21) { while (handValue(game.dealer) < 17) game.dealer.push(drawCard()); return finishAndEdit(handValue(game.dealer) === 21 ? 'push' : 'win'); }
  const collector = gm.createMessageComponentCollector({ time: 90_000 });
  collector.on('collect', async (interaction) => {
    if (!interaction.customId.startsWith(`${gameId}:`)) return;
    if (interaction.user.id !== game.userId) return interaction.reply({ content: 'This is not your game.', ephemeral: true });
    const action = interaction.customId.split(':')[1];
    if (action === 'hit') {
      game.player.push(drawCard());
      if (handValue(game.player) > 21) { await interaction.update({ embeds: [blackjackEmbed(game,true)], components: blackjackRows(gameId,true) }); finishBlackjackGame(message.guild.id, game, 'lose'); collector.stop('finished'); return; }
      return interaction.update({ embeds: [blackjackEmbed(game)], components: blackjackRows(gameId) });
    }
    if (action === 'stand') {
      while (handValue(game.dealer) < 17) game.dealer.push(drawCard());
      const pv = handValue(game.player), dv = handValue(game.dealer);
      let outcome = 'lose';
      if (dv > 21 || pv > dv) outcome = 'win';
      else if (pv === dv)     outcome = 'push';
      finishBlackjackGame(message.guild.id, game, outcome);
      await interaction.update({ embeds: [blackjackEmbed(game,true)], components: blackjackRows(gameId,true) });
      collector.stop('finished');
    }
  });
  collector.on('end', async (_c, reason) => {
    if (reason === 'finished' || !activeBlackjackGames.has(key)) return;
    finishBlackjackGame(message.guild.id, game, 'lose');
    game.resultText = `You took too long and lost **${formatBucks(game.bet)}** Smoke Bucks.`;
    await gm.edit({ embeds: [blackjackEmbed(game,true)], components: blackjackRows(gameId,true) }).catch(() => null);
  });
}

// =========================
// TIC-TAC-TOE
// =========================
function tttRows(gameId, board, disabled = false) {
  const rows = [];
  for (let row = 0; row < 3; row++) {
    const ar = new ActionRowBuilder();
    for (let col = 0; col < 3; col++) {
      const i = row*3+col, mark = board[i];
      ar.addComponents(new ButtonBuilder().setCustomId(`${gameId}:move:${i}`).setLabel(mark==='X'?'✕':mark==='O'?'○':'·').setStyle(mark==='X'?ButtonStyle.Danger:mark==='O'?ButtonStyle.Primary:ButtonStyle.Secondary).setDisabled(disabled||Boolean(mark)));
    }
    rows.push(ar);
  }
  return rows;
}
function tttWinner(board) {
  const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of wins) if (board[a] && board[a]===board[b] && board[a]===board[c]) return board[a];
  return board.every(Boolean) ? 'tie' : null;
}
function tttBoardText(board) {
  const e = (c) => c==='X'?'❌':c==='O'?'⭕':'⬛';
  return `${e(board[0])} ${e(board[1])} ${e(board[2])}\n${e(board[3])} ${e(board[4])} ${e(board[5])}\n${e(board[6])} ${e(board[7])} ${e(board[8])}`;
}
function tttEmbed(game, finishedText = '') {
  const currentId = game.turn === 'X' ? game.xId : game.oId;
  const isFinished = Boolean(finishedText);
  return new EmbedBuilder().setColor(isFinished ? 0xffb000 : 0x2f3136)
    .setAuthor({ name: 'Tic Tac Toe', iconURL: 'https://cdn.discordapp.com/embed/avatars/0.png' })
    .setDescription([`❌ <@${game.xId}> **vs** ⭕ <@${game.oId}>`, `💸 **${formatBucks(game.bet)} Smoke Bucks** each`, '', tttBoardText(game.board), '', `◜ ${isFinished ? finishedText : `**Turn:** <@${currentId}>`}`].join('\n'))
    .setFooter({ text: isFinished ? 'Game ended' : 'Click a tile below to play your move' }).setTimestamp();
}
async function startTicTacToe(message, command, args) {
  const target = await getTargetMember(message, args[0]);
  if (!target) return replySyntax(message, `${PREFIX}${command} @user [amount]`, 'Example: `*ttt @user 500`');
  if (target.id === message.author.id) return message.reply({ embeds: [economyErrorEmbed('Invalid Game','You cannot play against yourself.')] });
  if (target.user.bot)                 return message.reply({ embeds: [economyErrorEmbed('Invalid Game','You cannot play against a bot.')] });
  const ce  = getEcoUser(message.guild.id, message.author.id);
  const bet = (args[1] ? parseAmountArg(args[1], ce.balance) : null) || 250;
  if (bet > MAX_BET) return replySyntax(message, `${PREFIX}${command} @user [amount]`, `Max bet is **${formatBucks(MAX_BET)}** Smoke Bucks.`);
  const te = getEcoUser(message.guild.id, target.id);
  if (ce.balance < bet) return message.reply({ embeds: [economyErrorEmbed('Not Enough Smoke Bucks',`You only have **${formatBucks(ce.balance)}** Smoke Bucks.`)] });
  if (te.balance < bet) return message.reply({ embeds: [economyErrorEmbed('Opponent Cannot Afford Bet',`${target} only has **${formatBucks(te.balance)}** Smoke Bucks.`)] });
  const ids       = [message.author.id, target.id].sort().join(':');
  const activeKey = `${message.guild.id}:${ids}`;
  if (activeTttGames.has(activeKey)) return message.reply({ embeds: [economyErrorEmbed('Game Already Running','One of you already has a game running.')] });
  const confirmId = makeGameId('ttt_confirm');
  const confirmRows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${confirmId}:accept`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${confirmId}:deny`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
  )];
  const challengeMsg = await message.reply({ content: `${target}`, embeds: [new EmbedBuilder().setTitle('Tic-Tac-Toe Challenge').setDescription([`${message.author} challenged ${target} to Tic-Tac-Toe.`,`Bet: **${formatBucks(bet)}** Smoke Bucks each`,'',`${target}, do you accept?`].join('\n'))], components: confirmRows, allowedMentions: { users: [target.id] } });
  const confirmCollector = challengeMsg.createMessageComponentCollector({ time: 60_000 });
  confirmCollector.on('collect', async (interaction) => {
    if (!interaction.customId.startsWith(`${confirmId}:`)) return;
    if (interaction.user.id !== target.id) return interaction.reply({ content: 'Only the challenged user can respond.', ephemeral: true });
    const action = interaction.customId.split(':')[1];
    if (action === 'deny') { confirmCollector.stop('denied'); await interaction.update({ content: `<@${message.author.id}> your game got denied by <@${target.id}>.`, embeds: [], components: [], allowedMentions: { users: [message.author.id, target.id] } }); return; }
    const fc = getEcoUser(message.guild.id, message.author.id), ft = getEcoUser(message.guild.id, target.id);
    if (fc.balance < bet || ft.balance < bet) { confirmCollector.stop('no_funds'); await interaction.update({ content: 'Game canceled — one player no longer has enough Smoke Bucks.', embeds: [], components: [] }); return; }
    addBalance(message.guild.id, message.author.id, -bet); addBalance(message.guild.id, target.id, -bet);
    const gameId = makeGameId('ttt');
    const game   = { gameId, xId: message.author.id, oId: target.id, bet, board: Array(9).fill(null), turn: 'X', activeKey };
    activeTttGames.set(activeKey, game);
    await progressQuest(message.guild, message.member, 'play_ttt', 1, message.channel.id);
    await progressQuest(message.guild, target, 'play_ttt', 1, message.channel.id);
    await progressQuest(message.guild, message.member, 'wager', bet, message.channel.id);
    await progressQuest(message.guild, target, 'wager', bet, message.channel.id);
    confirmCollector.stop('accepted');
    await interaction.update({ content: '', embeds: [tttEmbed(game)], components: tttRows(gameId, game.board), allowedMentions: { parse: [] } });
    const gameCollector = challengeMsg.createMessageComponentCollector({ time: 180_000 });
    gameCollector.on('collect', async (mi) => {
      if (!mi.customId.startsWith(`${gameId}:move:`)) return;
      const currentId = game.turn === 'X' ? game.xId : game.oId;
      if (mi.user.id !== currentId) return mi.reply({ content: 'It is not your turn.', ephemeral: true });
      const index = Number(mi.customId.split(':')[2]);
      if (!Number.isInteger(index) || index < 0 || index > 8 || game.board[index]) return mi.reply({ content: 'That spot is not available.', ephemeral: true });
      game.board[index] = game.turn;
      const winner = tttWinner(game.board);
      if (winner) {
        activeTttGames.delete(activeKey);
        let finishedText;
        if (winner === 'tie') { addBalance(message.guild.id, game.xId, bet); addBalance(message.guild.id, game.oId, bet); finishedText = 'Tie game. Both bets were returned.'; }
        else {
          const winnerId = winner === 'X' ? game.xId : game.oId;
          const loserId  = winner === 'X' ? game.oId : game.xId;
          addBalance(message.guild.id, winnerId, bet*2);
          getEcoUser(message.guild.id, winnerId).wins    = (getEcoUser(message.guild.id, winnerId).wins   ||0)+1;
          getEcoUser(message.guild.id, loserId).losses   = (getEcoUser(message.guild.id, loserId).losses  ||0)+1; saveDb();
          await progressQuest(message.guild, winnerId, 'win_ttt',    1, message.channel.id);
          await progressQuest(message.guild, winnerId, 'win_gamble',  1, message.channel.id);
          finishedText = `<@${winnerId}> won **${formatBucks(bet)}** Smoke Bucks from <@${loserId}>.`;
        }
        await mi.update({ embeds: [tttEmbed(game, finishedText)], components: tttRows(gameId, game.board, true), allowedMentions: { parse: [] } });
        gameCollector.stop('finished'); return;
      }
      game.turn = game.turn === 'X' ? 'O' : 'X';
      await mi.update({ embeds: [tttEmbed(game)], components: tttRows(gameId, game.board), allowedMentions: { parse: [] } });
    });
    gameCollector.on('end', async (_c, reason) => {
      if (reason === 'finished' || !activeTttGames.has(activeKey)) return;
      activeTttGames.delete(activeKey);
      addBalance(message.guild.id, game.xId, bet); addBalance(message.guild.id, game.oId, bet);
      await challengeMsg.edit({ embeds: [tttEmbed(game,'Game expired. Both bets were returned.')], components: tttRows(gameId, game.board, true) }).catch(() => null);
    });
  });
  confirmCollector.on('end', async (_c, reason) => {
    if (['accepted','denied','no_funds'].includes(reason)) return;
    await challengeMsg.edit({ content: `<@${message.author.id}> your Tic-Tac-Toe challenge expired.`, embeds: [], components: [], allowedMentions: { users: [message.author.id] } }).catch(() => null);
  });
}

// =========================
// ECONOMY COMMANDS
// =========================
async function handleEconomyCommand(message, command, args) {
  if (command === 'economy' || command === 'eco') {
    if ((args[0]||'help').toLowerCase() !== 'help') return replySyntax(message, `${PREFIX}${command} help`);
    return message.reply({ embeds: [economyHelpEmbed()] });
  }
  if (command === 'quests' || command === 'missions' || command === 'dailyquests')
    return message.reply({ embeds: [questsEmbed(message.member)], allowedMentions: { parse: [] } });
  if (command === 'balance' || command === 'bal') {
    let target = message.member;
    if (args[0]) { const found = await getTargetMember(message, args[0]); if (!found) return replySyntax(message, `${PREFIX}${command} [@user]`); target = found; }
    const user = getEcoUser(message.guild.id, target.id);
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle(`💰 ${target.displayName}'s Balance`).setDescription(`**${formatBucks(user.balance)}** Smoke Bucks`).addFields({ name:'Total Earned',value:formatBucks(user.totalEarned),inline:true },{ name:'Gambling Wins',value:formatBucks(user.wins),inline:true },{ name:'Gambling Losses',value:formatBucks(user.losses),inline:true })], allowedMentions: { parse: [] } });
  }
  if (command === 'daily') {
    const user = getEcoUser(message.guild.id, message.author.id);
    const now  = Date.now();
    if (user.lastDaily && now - user.lastDaily < DAILY_COOLDOWN_MS) return message.reply({ embeds: [economyErrorEmbed('Daily Already Claimed',`Try again in **${timeLeft(DAILY_COOLDOWN_MS-(now-user.lastDaily))}**.`)] });
    if (!user.lastDaily || now - user.lastDaily > DAILY_COOLDOWN_MS * 2) user.dailyStreak = 0;
    user.dailyStreak = (user.dailyStreak||0)+1; user.lastDaily = now;
    const reward = DAILY_REWARD + Math.min(user.dailyStreak*100, 2500);
    user.balance += reward; user.totalEarned += reward; saveDb();
    await progressQuest(message.guild, message.member, 'use_daily', 1, message.channel.id);
    return message.reply({ embeds: [premiumEmbed('🎁 Daily Claimed',`You received **${formatBucks(reward)}** Smoke Bucks.\n🔥 Streak: **${user.dailyStreak}**`)] });
  }
  if (command === 'work') {
    const user = getEcoUser(message.guild.id, message.author.id);
    const now  = Date.now();
    if (user.lastWork && now - user.lastWork < WORK_COOLDOWN_MS) return message.reply({ embeds: [economyErrorEmbed('Work Cooldown',`Try again in **${timeLeft(WORK_COOLDOWN_MS-(now-user.lastWork))}**.`)] });
    user.lastWork = now;
    const reward = randInt(WORK_MIN, WORK_MAX);
    const jobs   = ['checked vanities','managed tickets','boosted activity','sold a rare vanity','helped the community'];
    user.balance += reward; user.totalEarned += reward; saveDb();
    await progressQuest(message.guild, message.member, 'use_work', 1, message.channel.id);
    return message.reply({ embeds: [premiumEmbed('💼 Work Complete',`You ${jobs[randInt(0,jobs.length-1)]} and earned **${formatBucks(reward)}** Smoke Bucks.`)] });
  }
  if (command === 'beg') {
    const user = getEcoUser(message.guild.id, message.author.id);
    const now  = Date.now();
    if (user.lastBeg && now - user.lastBeg < BEG_COOLDOWN_MS) return message.reply({ embeds: [economyErrorEmbed('Beg Cooldown',`Try again in **${timeLeft(BEG_COOLDOWN_MS-(now-user.lastBeg))}**.`)] });
    user.lastBeg = now;
    if (Math.random() < 0.18) { saveDb(); return message.reply({ embeds: [premiumEmbed('🥀 No Luck','Nobody gave you any Smoke Bucks this time.')] }); }
    const reward = randInt(BEG_MIN, BEG_MAX);
    user.balance += reward; user.totalEarned += reward; saveDb();
    return message.reply({ embeds: [premiumEmbed('🤝 Someone Helped You',`You got **${formatBucks(reward)}** Smoke Bucks.`)] });
  }
  if (command === 'donate' || command === 'pay') {
    const target = await getTargetMember(message, args[0]);
    const giver  = getEcoUser(message.guild.id, message.author.id);
    const amount = Math.floor(Number(String(args[1]||'').replace(/,/g,'')));
    if (!target || !Number.isFinite(amount) || amount <= 0) return replySyntax(message, `${PREFIX}${command} @user amount`);
    if (target.id === message.author.id) return message.reply({ embeds: [economyErrorEmbed('Invalid Donation','You cannot donate to yourself.')] });
    if (target.user.bot) return message.reply({ embeds: [economyErrorEmbed('Invalid Donation','You cannot donate to bots.')] });
    const now = Date.now();
    if (!giver.donateWindowStart || now - giver.donateWindowStart > DAILY_COOLDOWN_MS) { giver.donateWindowStart = now; giver.donatedToday = 0; }
    if ((giver.donatedToday||0) + amount > DONATE_DAILY_LIMIT) return message.reply({ embeds: [economyErrorEmbed('Donate Limit',`You can donate up to **${formatBucks(DONATE_DAILY_LIMIT)}** per day.`)] });
    if (giver.balance < amount) return message.reply({ embeds: [economyErrorEmbed('Not Enough Smoke Bucks',`You only have **${formatBucks(giver.balance)}** Smoke Bucks.`)] });
    const receiver = getEcoUser(message.guild.id, target.id);
    giver.balance -= amount; giver.donatedToday = (giver.donatedToday||0)+amount;
    receiver.balance += amount; receiver.totalEarned += amount; saveDb();
    await progressQuest(message.guild, message.member, 'donate', 1, message.channel.id);
    return message.reply({ embeds: [premiumEmbed('💸 Donation Sent',`${message.author} donated **${formatBucks(amount)}** Smoke Bucks to ${target}.`)] });
  }
  if (command === 'leaderboard' || command === 'lb' || command === 'baltop') {
    const data = getGuildData(message.guild.id);
    const rows = Object.entries(data.economy.users||{}).sort((a,b)=>(b[1].balance||0)-(a[1].balance||0)).slice(0,10);
    if (!rows.length) return message.reply({ embeds: [premiumEmbed('🏆 Smoke Bucks Leaderboard','No economy data yet.')] });
    return message.reply({ embeds: [premiumEmbed('🏆 Smoke Bucks Leaderboard', rows.map(([id,u],i)=>`**${i+1}.** <@${id}> — **${formatBucks(u.balance)}**`).join('\n'))], allowedMentions: { parse: [] } });
  }
  if (command === 'coinflip' || command === 'cf') {
    const choice = (args[1]||'').toLowerCase();
    if (!['heads','tails','h','t'].includes(choice)) return replySyntax(message, `${PREFIX}${command} amount heads/tails`);
    const parsed = betOrSyntax(message, args[0], `${PREFIX}${command} amount heads/tails`);
    if (parsed.error) return parsed.error();
    const pick   = choice.startsWith('h') ? 'heads' : 'tails';
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const win    = pick === result;
    addBalance(message.guild.id, message.author.id, win ? parsed.bet : -parsed.bet);
    const eco = getEcoUser(message.guild.id, message.author.id);
    win ? eco.wins++ : eco.losses++; saveDb();
    await progressQuest(message.guild, message.member, 'wager', parsed.bet, message.channel.id);
    if (win) { await progressQuest(message.guild, message.member, 'win_coinflip', 1, message.channel.id); await progressQuest(message.guild, message.member, 'win_gamble', 1, message.channel.id); }
    const frames = [
      { embeds:[premiumEmbed('🪙 Coinflip',[`**${message.author.username}** called **${pick.toUpperCase()}**.`,'','```','Preparing the coin...','```'].join('\n'))] },
      { embeds:[premiumEmbed('🪙 Coinflip',['The coin launches into the air... ✨','','```','     🪙','```'].join('\n'))] },
      { embeds:[premiumEmbed('🪙 Coinflip',['The coin is spinning fast...','','```','  🪙  ↻  🪙','```'].join('\n'))] },
      { embeds:[premiumEmbed('🪙 Coinflip',['Landing...','','```','   ? ? ?','```'].join('\n'))] },
    ];
    const final = premiumEmbed(win?'🪙 Coinflip — You Won':'🪙 Coinflip — You Lost',[`You picked **${pick}**.`,`It landed on **${result}**.`,'',win?`✅ You won **${formatBucks(parsed.bet)}** Smoke Bucks.`:`❌ You lost **${formatBucks(parsed.bet)}** Smoke Bucks.`].join('\n'));
    return animatedReply(message, frames, { embeds:[final], allowedMentions:{ parse:[] } }, 950);
  }
  if (command === 'slots' || command === 'slot') {
    const parsed = betOrSyntax(message, args[0], `${PREFIX}${command} amount`);
    if (parsed.error) return parsed.error();
    const icons = ['🍒','🍋','🍇','🔔','💎','7️⃣'];
    const roll  = [icons[randInt(0,icons.length-1)],icons[randInt(0,icons.length-1)],icons[randInt(0,icons.length-1)]];
    let multiplier = 0;
    if (roll[0]===roll[1]&&roll[1]===roll[2]) multiplier = roll[0]==='7️⃣' ? 10 : 5;
    else if (roll[0]===roll[1]||roll[1]===roll[2]||roll[0]===roll[2]) multiplier = 1.5;
    const change = multiplier > 0 ? Math.floor(parsed.bet*multiplier) : -parsed.bet;
    addBalance(message.guild.id, message.author.id, change);
    const eco = getEcoUser(message.guild.id, message.author.id);
    change > 0 ? eco.wins++ : eco.losses++; saveDb();
    await progressQuest(message.guild, message.member, 'play_slots', 1, message.channel.id);
    await progressQuest(message.guild, message.member, 'wager', parsed.bet, message.channel.id);
    if (change > 0) await progressQuest(message.guild, message.member, 'win_gamble', 1, message.channel.id);
    const frames = [
      { embeds:[premiumEmbed('🎰 Slots','```[ ❔ | ❔ | ❔ ]```\nPulling the lever...')] },
      { embeds:[premiumEmbed('🎰 Slots','```[ 🔄 | 🔄 | 🔄 ]```\nReels are spinning... ✨')] },
      { embeds:[premiumEmbed('🎰 Slots',`\`\`\`[ ${roll[0]} | 🔄 | 🔄 ]\`\`\`\nFirst reel locked...`)] },
      { embeds:[premiumEmbed('🎰 Slots',`\`\`\`[ ${roll[0]} | ${roll[1]} | 🔄 ]\`\`\`\nSecond reel locked...`)] },
    ];
    const final = premiumEmbed(change>0?'🎰 Slots — Jackpot Hit':'🎰 Slots — No Win',[`\`\`\`[ ${roll[0]} | ${roll[1]} | ${roll[2]} ]\`\`\``,change>0?`✅ You won **${formatBucks(change)}** Smoke Bucks.\nMultiplier: **${multiplier}x**`:`❌ You lost **${formatBucks(parsed.bet)}** Smoke Bucks.`].join('\n'));
    return animatedReply(message, frames, { embeds:[final] }, 900);
  }
  if (command === 'dice') {
    const choice = (args[1]||'').toLowerCase();
    if (!['over','under'].includes(choice)) return replySyntax(message, `${PREFIX}dice amount over/under`);
    const parsed = betOrSyntax(message, args[0], `${PREFIX}dice amount over/under`);
    if (parsed.error) return parsed.error();
    const roll = randInt(1,100);
    const win  = choice==='over' ? roll>50 : roll<50;
    addBalance(message.guild.id, message.author.id, win ? parsed.bet : -parsed.bet);
    const eco = getEcoUser(message.guild.id, message.author.id);
    win ? eco.wins++ : eco.losses++; saveDb();
    await progressQuest(message.guild, message.member, 'play_dice', 1, message.channel.id);
    await progressQuest(message.guild, message.member, 'wager', parsed.bet, message.channel.id);
    if (win) await progressQuest(message.guild, message.member, 'win_gamble', 1, message.channel.id);
    const frames = [
      { embeds:[premiumEmbed('🎲 Dice',[`Choice: **${choice} 50**`,'','```','Shaking the dice...','```'].join('\n'))] },
      { embeds:[premiumEmbed('🎲 Dice',['The dice is bouncing... ✨','','```','🎲  →  🎲','```'].join('\n'))] },
      { embeds:[premiumEmbed('🎲 Dice',['Final bounce...','','```','Result loading...','```'].join('\n'))] },
    ];
    const final = premiumEmbed(win?'🎲 Dice — You Won':'🎲 Dice — You Lost',[`Rolled **${roll}**.`,`You chose **${choice} 50**.`,'',win?`✅ You won **${formatBucks(parsed.bet)}** Smoke Bucks.`:`❌ You lost **${formatBucks(parsed.bet)}** Smoke Bucks.`].join('\n'));
    return animatedReply(message, frames, { embeds:[final] }, 900);
  }
  if (command === 'roulette' || command === 'rl') {
    const choice = (args[1]||'').toLowerCase();
    if (!['red','black','green'].includes(choice)) return replySyntax(message, `${PREFIX}${command} amount red/black/green`);
    const parsed = betOrSyntax(message, args[0], `${PREFIX}${command} amount red/black/green`);
    if (parsed.error) return parsed.error();
    const n      = randInt(0,36);
    const color  = n===0 ? 'green' : n%2===0 ? 'black' : 'red';
    const emoji  = color==='red' ? '🔴' : color==='black' ? '⚫' : '🟢';
    const win    = choice===color;
    const payout = choice==='green' ? parsed.bet*14 : parsed.bet;
    addBalance(message.guild.id, message.author.id, win ? payout : -parsed.bet);
    const eco = getEcoUser(message.guild.id, message.author.id);
    win ? eco.wins++ : eco.losses++; saveDb();
    await progressQuest(message.guild, message.member, 'wager', parsed.bet, message.channel.id);
    if (win) { await progressQuest(message.guild, message.member, 'win_roulette', 1, message.channel.id); await progressQuest(message.guild, message.member, 'win_gamble', 1, message.channel.id); }
    const frames = [
      { embeds:[premiumEmbed('🎡 Roulette',[`Bet: **${choice}**`,'','```','Wheel spinning...','```'].join('\n'))] },
      { embeds:[premiumEmbed('🎡 Roulette',['Ball dropping... ✨','','```','◉  3  17  22  9  0  31','```'].join('\n'))] },
      { embeds:[premiumEmbed('🎡 Roulette',['Slowing down...','','```','8  23  ◉  10  30  1  14','```'].join('\n'))] },
      { embeds:[premiumEmbed('🎡 Roulette',['Almost...','','```','?  ?  ◉  ?  ?','```'].join('\n'))] },
    ];
    const final = premiumEmbed(win?'🎡 Roulette — You Won':'🎡 Roulette — You Lost',[`Landed on **${n} ${emoji} ${color}**.`,'',win?`✅ You won **${formatBucks(payout)}** Smoke Bucks.`:`❌ You lost **${formatBucks(parsed.bet)}** Smoke Bucks.`].join('\n'));
    return animatedReply(message, frames, { embeds:[final] }, 1000);
  }
  if (command === 'blackjack' || command === 'bj') return startInteractiveBlackjack(message, command, args);
  if (command === 'tictactoe'  || command === 'ttt') return startTicTacToe(message, command, args);
  return false;
}

// =========================
// GHOST PING ON JOIN
// Pings the new member in one or more channels, then instantly
// deletes the message — giving them a notification with no trace.
// =========================
async function executeGhostPings(member) {
  if (member.user.bot) return;
  const data = getGuildData(member.guild.id);
  const cfg  = data.ghostPing;
  if (!cfg || !cfg.enabled || !cfg.channelIds.length) return;

  for (const channelId of cfg.channelIds) {
    // Try cache first, fall back to a live fetch so stale caches do not silently skip
    let channel = member.guild.channels.cache.get(channelId);
    if (!channel) {
      channel = await member.guild.channels.fetch(channelId).catch(() => null);
    }
    if (!channel?.isTextBased?.()) {
      console.warn(`[GhostPing] Channel ${channelId} not found or not text-based — skipping.`);
      continue;
    }

    const me    = member.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
      console.warn(`[GhostPing] Missing Send Messages in #${channel.name} — skipping.`);
      continue;
    }

    try {
      const msg = await channel.send({
        content: `<@${member.id}>`,
        allowedMentions: { users: [member.id] },
      });
      // Give Discord 400ms to dispatch the notification before deleting.
      // Deleting instantly can outrace Discord's push notification pipeline.
      await sleep(400);
      await msg.delete().catch(() => null);
    } catch (err) {
      console.error(`[GhostPing] Failed in #${channel.name}:`, err.message);
    }
  }
}

async function handleGhostPingCommand(message, args) {
  if (!hasManagerPerm(message.member))
    return message.reply('You need Manage Server to configure ghost pings.');

  const sub  = (args.shift() || '').toLowerCase();
  const data = getGuildData(message.guild.id);
  const cfg  = data.ghostPing;

  // ── show config ─────────────────────────────────────────────────────────
  if (!sub || sub === 'help' || sub === 'list') {
    const chLines = cfg.channelIds.length
      ? cfg.channelIds.map((id, i) => {
          const ch = message.guild.channels.cache.get(id);
          return `**${i + 1}.** ${ch ? `<#${id}>` : `\`${id}\` *(deleted)*`}`;
        }).join('\n')
      : '*(none — use `*ghostping add #channel`)*';
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(cfg.enabled ? 0x57f287 : 0xed4245)
        .setTitle('👻 Ghost Ping on Join')
        .addFields(
          { name: 'Status',   value: cfg.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
          { name: 'Channels', value: String(cfg.channelIds.length),              inline: true },
        )
        .setDescription(`**Ping channels:**\n${chLines}`)
        .setFooter({ text: `${PREFIX}ghostping add #channel  •  ${PREFIX}ghostping enable` })
        .setTimestamp()],
    });
  }

  if (sub === 'enable') {
    if (!cfg.channelIds.length)
      return message.reply({ embeds: [simpleEmbed(0xffa500, `Add at least one channel first: \`${PREFIX}ghostping add #channel\``)] });
    cfg.enabled = true; saveDb();
    return message.reply({ embeds: [simpleEmbed(0x57f287, '🟢 Ghost ping on join is now **enabled**.')] });
  }

  if (sub === 'disable') {
    cfg.enabled = false; saveDb();
    return message.reply({ embeds: [simpleEmbed(0xed4245, '🔴 Ghost ping on join is now **disabled**.')] });
  }

  if (sub === 'add') {
    const mentioned = [...message.mentions.channels.values()]
      .filter((ch) => ch.isTextBased());
    if (!mentioned.length) return replySyntax(message, `${PREFIX}ghostping add #channel [#channel2 ...]`);
    const added = [];
    for (const ch of mentioned) {
      if (!cfg.channelIds.includes(ch.id)) { cfg.channelIds.push(ch.id); added.push(`<#${ch.id}>`); }
    }
    saveDb();
    if (!added.length) return message.reply({ embeds: [simpleEmbed(0xffa500, 'All mentioned channels are already in the list.')] });
    return message.reply({
      embeds: [simpleEmbed(0x57f287, `✅ Added ${added.join(', ')} to ghost ping channels.\n\nTotal channels: **${cfg.channelIds.length}**`)],
    });
  }

  if (sub === 'remove') {
    // Accept a channel mention, a plain ID, or a list position number
    const mentionedCh = message.mentions.channels.first();
    let channelId     = mentionedCh?.id;

    if (!channelId && args[0]) {
      const n = Number.parseInt(args[0], 10);
      if (Number.isFinite(n) && n >= 1 && n <= cfg.channelIds.length) {
        channelId = cfg.channelIds[n - 1];
      } else if (/^\d{16,25}$/.test(args[0])) {
        channelId = args[0];
      }
    }

    if (!channelId || !cfg.channelIds.includes(channelId))
      return replySyntax(message, `${PREFIX}ghostping remove #channel`, `Use \`${PREFIX}ghostping list\` to see the numbered list.`);

    cfg.channelIds = cfg.channelIds.filter((id) => id !== channelId);
    if (!cfg.channelIds.length) cfg.enabled = false; // auto-disable if no channels left
    saveDb();
    const ch = message.guild.channels.cache.get(channelId);
    return message.reply({
      embeds: [simpleEmbed(0xed4245,
        `Removed ${ch ? `<#${channelId}>` : `\`${channelId}\``} from ghost ping channels.${!cfg.channelIds.length ? '\nGhost ping has been **disabled** (no channels remaining).' : ''}`)],
    });
  }

  if (sub === 'clear') {
    cfg.channelIds = []; cfg.enabled = false; saveDb();
    return message.reply({ embeds: [simpleEmbed(0xed4245, 'All ghost ping channels cleared. Ghost ping disabled.')] });
  }

  // Default help
  return message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xff8a00)
      .setTitle('👻 Ghost Ping Commands')
      .setDescription([
        `\`${PREFIX}ghostping\` — Show config and channel list`,
        `\`${PREFIX}ghostping enable\` — Enable ghost pings on join`,
        `\`${PREFIX}ghostping disable\` — Disable ghost pings`,
        `\`${PREFIX}ghostping add #ch1 [#ch2 ...]\` — Add channel(s)`,
        `\`${PREFIX}ghostping remove #channel\` — Remove a channel`,
        `\`${PREFIX}ghostping clear\` — Remove all channels`,
        '',
        'All subcommands require **Manage Server**.',
        '',
        'When a user joins, the bot sends a ping to every configured',
        'channel and deletes it immediately — triggering a notification',
        'for the member with no message left behind.',
      ].join('\n'))
      .setTimestamp()],
  });
}

// =========================
// WELCOME DM COMMANDS
// =========================
function buildWelcomeDmInfoEmbed(cfg) {
  const e = cfg.embed || {};
  return new EmbedBuilder().setColor(cfg.enabled ? 0x57f287 : 0xed4245).setTitle('📬 Welcome DM Configuration')
    .addFields(
      { name: 'Status',              value: cfg.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
      { name: 'DM Queue',            value: String(dmQueue.size), inline: true },
      { name: 'Plain Text Message',  value: cfg.content ? `\`\`\`${cfg.content.slice(0,300)}\`\`\`` : '*(not set)*' },
      { name: 'Embed', value: [`**Title:** ${e.title?`\`${e.title.slice(0,60)}\``:'*(not set)*'}`,`**Description:** ${e.description?`\`${e.description.slice(0,80)}\``:'*(not set)*'}`,`**Color:** ${e.color?`\`#${e.color}\``:'*(default)*'}`,`**Footer:** ${e.footerText?`\`${e.footerText.slice(0,60)}\``:'*(not set)*'}`,`**Thumbnail:** ${e.thumbnailUrl?'✅ set':'*(not set)*'}`,`**Image:** ${e.imageUrl?'✅ set':'*(not set)*'}`,`**Fields:** ${(e.fields||[]).length}/25`].join('\n') },
      { name: 'Variables', value: '`{user.mention}` `{user.username}` `{user.globalName}`\n`{user.displayName}` `{user.tag}` `{user.id}` `{user.createdAt}`\n`{server.name}` `{server.memberCount}` `{server.id}` `{server.icon}`' },
      { name: 'Commands', value: [`\`${PREFIX}wdm enable\` / \`${PREFIX}wdm disable\``,`\`${PREFIX}wdm message <text>\``,`\`${PREFIX}wdm embed\` — Embed subcommands`,`\`${PREFIX}wdm test\` — Test DM yourself`,`\`${PREFIX}wdm preview\` — Preview in channel`,`\`${PREFIX}wdm reset\``].join('\n') },
    )
    .setFooter({ text: `${PREFIX}wdm embed help for embed subcommands` }).setTimestamp();
}
async function handleWelcomeDmEmbedCommand(message, args, cfg) {
  const sub2 = (args.shift()||'').toLowerCase();
  const e    = cfg.embed;
  if (!sub2 || sub2 === 'help') {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('Welcome DM Embed Subcommands').setDescription([
      `\`${PREFIX}wdm embed title <text or "clear">\``, `\`${PREFIX}wdm embed desc <text or "clear">\``,
      `\`${PREFIX}wdm embed color <hex>\` — e.g. \`ff8a00\``, `\`${PREFIX}wdm embed thumbnail <url or "clear">\``,
      `\`${PREFIX}wdm embed image <url or "clear">\``,       `\`${PREFIX}wdm embed footer <text or "clear">\``,
      `\`${PREFIX}wdm embed addfield <name> | <value>\``,    `\`${PREFIX}wdm embed addfield <name> | <value> | inline\``,
      `\`${PREFIX}wdm embed removefield <number>\``,         `\`${PREFIX}wdm embed clearfields\``,
      `\`${PREFIX}wdm embed clear\``,
    ].join('\n')).setFooter({ text: 'All fields support {variables}.' })] });
  }
  if (sub2 === 'title') {
    const text = args.join(' ').trim(); if (!text) return replySyntax(message, `${PREFIX}wdm embed title <text>`);
    if (text.toLowerCase() === 'clear') { e.title = null; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'Embed title cleared.')] }); }
    e.title = text.slice(0,256); saveDb(); return message.reply({ embeds: [simpleEmbed(0x57f287,`✅ Title set to: **${e.title}**`)] });
  }
  if (sub2 === 'desc' || sub2 === 'description') {
    const text = args.join(' ').trim(); if (!text) return replySyntax(message, `${PREFIX}wdm embed desc <text>`);
    if (text.toLowerCase() === 'clear') { e.description = null; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'Description cleared.')] }); }
    e.description = text.slice(0,4096); saveDb(); return message.reply({ embeds: [simpleEmbed(0x57f287,'✅ Description set.')] });
  }
  if (sub2 === 'color' || sub2 === 'colour') {
    const hex = (args[0]||'').replace('#','').trim();
    if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return message.reply({ embeds: [simpleEmbed(0xed4245,'Invalid color. Use a 6-character hex like `ff8a00`.')] });
    e.color = hex; saveDb(); return message.reply({ embeds: [new EmbedBuilder().setColor(Number.parseInt(hex,16)).setDescription(`✅ Color set to **#${hex}**.`).setTimestamp()] });
  }
  if (sub2 === 'thumbnail') {
    const url = (args[0]||'').trim();
    if (!url || url.toLowerCase() === 'clear') { e.thumbnailUrl = null; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'Thumbnail cleared.')] }); }
    if (!url.startsWith('http') && !url.includes('{')) return message.reply({ embeds: [simpleEmbed(0xed4245,'Provide a URL starting with `http` or a variable like `{server.icon}`.')] });
    e.thumbnailUrl = url; saveDb(); return message.reply({ embeds: [simpleEmbed(0x57f287,'✅ Thumbnail set.')] });
  }
  if (sub2 === 'image') {
    const url = (args[0]||'').trim();
    if (!url || url.toLowerCase() === 'clear') { e.imageUrl = null; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'Image cleared.')] }); }
    if (!url.startsWith('http') && !url.includes('{')) return message.reply({ embeds: [simpleEmbed(0xed4245,'Provide a URL starting with `http`.')] });
    e.imageUrl = url; saveDb(); return message.reply({ embeds: [simpleEmbed(0x57f287,'✅ Image set.')] });
  }
  if (sub2 === 'footer') {
    const text = args.join(' ').trim(); if (!text) return replySyntax(message, `${PREFIX}wdm embed footer <text>`);
    if (text.toLowerCase() === 'clear') { e.footerText = null; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'Footer cleared.')] }); }
    e.footerText = text.slice(0,2048); saveDb(); return message.reply({ embeds: [simpleEmbed(0x57f287,`✅ Footer set to: **${e.footerText}**`)] });
  }
  if (sub2 === 'addfield') {
    const parts = args.join(' ').split('|').map((s)=>s.trim());
    const name = parts[0], value = parts[1], inline = (parts[2]||'').toLowerCase() === 'inline';
    if (!name || !value) return replySyntax(message, `${PREFIX}wdm embed addfield <name> | <value>`, 'Use `|` to separate name and value.');
    if (e.fields.length >= 25) return message.reply({ embeds: [simpleEmbed(0xed4245,'You already have 25 fields (Discord maximum).')] });
    e.fields.push({ name: name.slice(0,256), value: value.slice(0,1024), inline }); saveDb();
    return message.reply({ embeds: [simpleEmbed(0x57f287,`✅ Added field **${name}** (${e.fields.length}/25)`)] });
  }
  if (sub2 === 'removefield') {
    const num = Number.parseInt(args[0],10);
    if (Number.isNaN(num) || num < 1 || num > e.fields.length) return message.reply({ embeds: [simpleEmbed(0xed4245,`Give a field number between 1 and ${e.fields.length||0}.`)] });
    const removed = e.fields.splice(num-1,1)[0]; saveDb();
    return message.reply({ embeds: [simpleEmbed(0x57f287,`✅ Removed field **${removed.name}**.`)] });
  }
  if (sub2 === 'clearfields') { e.fields = []; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'All embed fields cleared.')] }); }
  if (sub2 === 'clear') { cfg.embed = defaultWelcomeDmConfig().embed; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'Embed config cleared.')] }); }
  return message.reply(`Unknown embed subcommand. Use \`${PREFIX}wdm embed help\` to see options.`);
}
async function handleWelcomeDmCommand(message, args) {
  if (!hasManagerPerm(message.member)) return message.reply('You need Manage Server or Manage Channels to configure Welcome DMs.');
  const sub = (args.shift()||'').toLowerCase();
  const cfg = getWelcomeDm(message.guild.id);
  if (!sub || sub === 'help') return message.reply({ embeds: [buildWelcomeDmInfoEmbed(cfg)], allowedMentions: { parse: [] } });
  if (sub === 'enable')  { cfg.enabled = true;  saveDb(); return message.reply({ embeds: [simpleEmbed(0x57f287,'🟢 Welcome DMs are now **enabled**.')] }); }
  if (sub === 'disable') { cfg.enabled = false; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'🔴 Welcome DMs are now **disabled**.')] }); }
  if (sub === 'test') {
    if (!hasWelcomeDmContent(cfg)) return message.reply({ embeds: [simpleEmbed(0xffa500,'No content set yet. Use `*wdm message` or `*wdm embed` first.')] });
    const payload = buildWelcomeDmPayload(message.member, cfg);
    const ok = await sendDmWithRetry(message.author, payload, 1);
    return message.reply({ embeds: [ok ? simpleEmbed(0x57f287,'✅ Test DM sent!') : simpleEmbed(0xed4245,'❌ Could not send DM. Make sure your DMs are open.')] });
  }
  if (sub === 'preview') {
    if (!hasWelcomeDmContent(cfg)) return message.reply({ embeds: [simpleEmbed(0xffa500,'No content set yet.')] });
    const payload = buildWelcomeDmPayload(message.member, cfg);
    return message.reply({ content: payload.content ? `**Preview:**\n${payload.content}` : undefined, embeds: payload.embeds||[], allowedMentions: { parse: [] } });
  }
  if (sub === 'message') {
    const text = args.join(' ').trim(); if (!text) return replySyntax(message, `${PREFIX}wdm message <text>`, 'Use `clear` to remove the message.');
    if (text.toLowerCase() === 'clear') { cfg.content = null; saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'Message cleared.')] }); }
    cfg.content = text.slice(0,2000); saveDb();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ Message Set').setDescription(`\`\`\`${cfg.content.slice(0,500)}\`\`\``).setFooter({ text: 'Variables resolved at send time.' }).setTimestamp()] });
  }
  if (sub === 'embed') return handleWelcomeDmEmbedCommand(message, args, cfg);
  if (sub === 'reset') { const data = getGuildData(message.guild.id); data.welcomeDm = defaultWelcomeDmConfig(); saveDb(); return message.reply({ embeds: [simpleEmbed(0xed4245,'Welcome DM config fully reset.')] }); }
  return replySyntax(message, `${PREFIX}wdm [enable|disable|test|preview|message|embed|reset]`);
}

// =========================
// MAIN COMMAND HANDLER
// =========================
const ECONOMY_COMMANDS = new Set([
  'economy','eco','balance','bal','daily','work','beg','donate','pay',
  'leaderboard','lb','baltop','coinflip','cf','slots','slot','dice',
  'roulette','rl','blackjack','bj','tictactoe','ttt','quests','missions','dailyquests',
]);

async function handleCommand(message) {
  const raw = message.content.slice(PREFIX.length).trim();
  if (!raw) return;
  const args    = raw.split(/\s+/);
  const command = (args.shift()||'').toLowerCase();

  if (command === 'help') {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xff8a00).setTitle('📋 Bot Commands').setDescription([
      `Prefix: \`${PREFIX}\``, '',
      '**🐱 UwUify**',
      `> \`${PREFIX}uwuify @user\` · \`${PREFIX}unuwuify @user\` · \`${PREFIX}uwulist\``,
      '',
      '**🎙️ VoiceMaster**',
      `> \`${PREFIX}vm setup\` — Create VC channels · \`${PREFIX}vc help\` — VC controls`,
      '',
      '**🏆 VC Milestone Roles**',
      `> \`${PREFIX}vcm\` — View milestones · \`${PREFIX}vcm add @Role 24h\` — Add milestone`,
      `> \`${PREFIX}vcm check [@user]\` — VC time · \`${PREFIX}vcm lb\` — Leaderboard`,
      '',
      '**👥 Friend Groups** *(slash command)*',
      `> \`/friendgroup create name:Crew @user1 @user2\` — Create a group`,
      `> \`/friendgroup stats name:Crew\` — Live message + VC stats`,
      `> \`/friendgroup list\` — View all groups`,
      '',
      '**🎉 Giveaways** *(slash command)*',
      `> \`/giveaway create\` — Start a giveaway with optional requirements`,
      `> \`/giveaway list\` — View active giveaways`,
      '',
      '**🎭 Status Roles** *(slash command)*',
      `> \`/statusrole add\` — Add a rule · \`/statusrole list\` — View all rules`,
      `> \`/statusrole check [@user]\` — Preview matches`,
      '',
      '**💎 Mod Wallet**',
      `> \`${PREFIX}mw\` — Check your wallet · \`${PREFIX}mw lb\` — Leaderboard`,
      `> \`${PREFIX}mw add @user 50 reason\` — Add credits *(editor only)*`,
      '',
      '**👻 Ghost Ping on Join**',
      `> \`${PREFIX}ghostping\` — Config · \`${PREFIX}ghostping add #channel\` — Add channel`,
      '',
      '**🔨 Moderation**',
      `> \`${PREFIX}purge 50\` — Bulk delete up to 100 messages`,
      '',
      '**💰 Economy**',
      `> \`${PREFIX}economy help\` — All Smoke Bucks commands`,
      `> \`${PREFIX}quests\` — Daily missions`,
      '',
      '**🌐 Owner Commands**',
      `> \`${PREFIX}servers [page]\` — List all servers the bot is in`,
      `> \`${PREFIX}leave <serverId>\` — Make the bot leave a server`,
      '',
      '**📬 Welcome DM**',
      `> \`${PREFIX}wdm\` — Configure join DMs`,
    ].join('\n')).setTimestamp()] });
  }

  if (command === 'uwuify') {
    if (!hasUwUPerm(message.member)) return message.reply('You need Manage Messages, Manage Server, or Administrator.');
    const target = await getTargetMember(message, args[0]);
    if (!target) return replySyntax(message, `${PREFIX}uwuify @user`);
    if (target.user.bot) return message.reply('Bots cannot be uwuified.');
    const data = getGuildData(message.guild.id);
    if (!data.uwuTargets.includes(target.id)) data.uwuTargets.push(target.id);
    saveDb(); return message.reply(`${target} is now uwuified.`);
  }
  if (command === 'unuwuify' || command === 'removeuwu') {
    if (!hasUwUPerm(message.member)) return message.reply('You need Manage Messages, Manage Server, or Administrator.');
    const target = await getTargetMember(message, args[0]);
    if (!target) return replySyntax(message, `${PREFIX}unuwuify @user`);
    const data = getGuildData(message.guild.id);
    data.uwuTargets = data.uwuTargets.filter((id) => id !== target.id); saveDb();
    return message.reply(`${target} is no longer uwuified.`);
  }
  if (command === 'uwulist') {
    if (!hasUwUPerm(message.member)) return message.reply('You need Manage Messages, Manage Server, or Administrator.');
    const data = getGuildData(message.guild.id);
    if (!data.uwuTargets.length) return message.reply('No users are currently uwuified.');
    return message.reply({ embeds: [new EmbedBuilder().setTitle('UwUified Users').setDescription(data.uwuTargets.map((id,i)=>`${i+1}. <@${id}>`).join('\n'))], allowedMentions: { parse: [] } });
  }
  if (command === 'purge' || command === 'clear') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return message.reply('You need Manage Messages or Administrator.');
    const amount = Number.parseInt(args[0], 10);
    if (Number.isNaN(amount) || amount < 1 || amount > 100) return replySyntax(message, `${PREFIX}${command} amount`, 'Amount must be between 1 and 100.');
    try {
      await message.delete().catch(() => null);
      const msgs = await message.channel.messages.fetch({ limit: amount });
      await message.channel.bulkDelete(msgs, true);
    } catch (err) {
      console.error('Purge error:', err);
      return message.reply({ embeds: [economyErrorEmbed('Purge Failed','Could not delete messages. Make sure they are under 14 days old and I have Manage Messages.')] });
    }
    return;
  }
  if (command === 'servers' || command === 'guilds') return handleServersCommand(message, args);
  if (command === 'leave')                              return handleLeaveCommand(message, args);
  if (command === 'modwallet' || command === 'mw') return handleModWalletCommand(message, args);
  if (command === 'vcmilestones' || command === 'vcm') return handleVcMilestoneCommand(message, args);
  if (command === 'ghostping'    || command === 'gp')  return handleGhostPingCommand(message, args);
  if (command === 'welcomedm'    || command === 'wdm') return handleWelcomeDmCommand(message, args);
  if (command === 'voicemaster'  || command === 'vm') {
    const sub = (args.shift()||'').toLowerCase();
    if (sub === 'setup') return setupVoiceMaster(message);
    return replySyntax(message, `${PREFIX}${command} setup`);
  }
  if (command === 'vc') return handleVcCommand(message, args);
  if (ECONOMY_COMMANDS.has(command)) return handleEconomyCommand(message, command, args);
}

// =========================
// EVENTS
// =========================
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Package: premium-disco-v11 — friend groups + mod wallet + giveaways + status roles + vc milestones');
  console.log(`Prefix: ${PREFIX} | Data: ${DATA_FILE}`);

  // Register slash commands in every current guild (instant; no ~1hr global propagation)
  for (const guild of client.guilds.cache.values()) {
    await registerSlashCommands(guild.id);
  }

  // Seed vcSessions for anyone already in a VC when the bot starts
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice) continue;
      for (const member of channel.members.values()) {
        if (!member.user.bot) vcSessions.set(`${guild.id}:${member.id}`, now);
      }
    }
  }

  // Apply status roles to all currently-online members on startup
  for (const guild of client.guilds.cache.values()) {
    for (const [userId, presence] of guild.presences.cache) {
      const status = getCustomStatus(presence);
      await applyStatusRoles(guild, userId, status).catch(() => null);
    }
  }

  // Schedule timers for giveaways that were running when the bot was last stopped
  for (const guild of client.guilds.cache.values()) {
    const d = getGuildData(guild.id);
    for (const g of Object.values(d.giveaways || {})) {
      if (!g.ended && !g.cancelled) scheduleGiveaway(g);
    }
  }

  // Single 60s tick: quest VC + milestone time + message buffer flush + giveaway expiry check
  setInterval(() => tickVcTracking().catch((err) => console.error('Tick error:', err)), 60_000);
});

client.on('guildMemberAdd', async (member) => {
  try { queueWelcomeDm(member); } catch (err) { console.error('guildMemberAdd welcomeDm error:', err); }
  try { await executeGhostPings(member); } catch (err) { console.error('guildMemberAdd ghostPing error:', err); }
});

client.on('messageCreate', async (message) => {
  try {
    if (!message.guild || message.author.bot) return;
    rememberLastTextChannel(message);
    if (isTempVcChat(message.channel)) { await message.delete().catch(() => null); return; }
    if (message.content.startsWith(PREFIX)) {
      const _cmd = (message.content.slice(PREFIX.length).trim().split(/\s+/)[0] || '').toLowerCase();
      const _rl  = checkRateLimit(message.guild.id, message.author.id, _cmd);
      if (_rl) { await handleRateLimitReply(message, _rl); return; }
      await handleCommand(message);
      return;
    }
    await progressQuest(message.guild, message.member, 'chat', 1, message.channel.id);
    // Buffer message count for giveaway tracking (flushed to DB every 60s)
    const _bufKey = `${message.guild.id}:${message.author.id}`;
    messageCountBuffer.set(_bufKey, (messageCountBuffer.get(_bufKey) || 0) + 1);
    await handleUwUMessage(message);
  } catch (err) { console.error('messageCreate error:', err); }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try { await handleVoiceStateUpdate(oldState, newState); }
  catch (err) { console.error('voiceStateUpdate error:', err); }
});

// Register slash commands when the bot is added to a new guild
client.on('guildCreate', async (guild) => {
  await registerSlashCommands(guild.id);
});

// Recheck status roles whenever a user's presence/status changes
client.on('presenceUpdate', async (oldPresence, newPresence) => {
  try {
    if (!newPresence?.guild || !newPresence?.userId) return;
    if (newPresence.member?.user?.bot) return;

    const newStatus = getCustomStatus(newPresence);
    const oldStatus = getCustomStatus(oldPresence);
    if (newStatus === oldStatus) return; // nothing relevant changed

    await applyStatusRoles(newPresence.guild, newPresence.userId, newStatus);
  } catch (err) { console.error('presenceUpdate error:', err); }
});

// Handle all interactions: autocomplete, buttons, slash commands
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.guild) {
      if (interaction.isRepliable()) await interaction.reply({ content: 'This can only be used in a server.', ephemeral: true }).catch(() => null);
      return;
    }

    // ── Autocomplete ─────────────────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'friendgroup') {
        const focused  = interaction.options.getFocused(true);
        if (focused.name === 'name') {
          const data    = getGuildData(interaction.guild.id);
          const groups  = Object.keys(data.friendGroups || {});
          const val     = focused.value.toLowerCase();
          const choices = groups
            .filter(k => k.toLowerCase().includes(val))
            .slice(0, 25)
            .map(k => ({ name: k, value: k }));
          await interaction.respond(choices).catch(() => null);
        }
      }
      return;
    }

    // ── Buttons ─────────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('giveaway_enter:')) {
        await handleGiveawayEntry(interaction);
      }
      if (interaction.customId.startsWith('fg_refresh:')) {
        const groupKey = interaction.customId.replace('fg_refresh:', '');
        const found    = findFriendGroup(interaction.guild.id, groupKey);
        if (!found) {
          return interaction.update({ content: 'This friend group no longer exists.', embeds: [], components: [] });
        }
        await interaction.update({
          embeds:     [buildFriendGroupStatsEmbed(interaction.guild.id, interaction.guild, found.group)],
          components: buildFriendGroupRefreshRow(found.key),
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── Slash commands ───────────────────────────────────────────────────────
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'statusrole') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
        return interaction.reply({ content: 'You need **Manage Server** to use this command.', ephemeral: true });
      await handleStatusRoleInteraction(interaction);
    }
    if (interaction.commandName === 'giveaway') {
      await handleGiveawaySlashCommand(interaction);
    }
    if (interaction.commandName === 'friendgroup') {
      await handleFriendGroupInteraction(interaction);
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
    const reply = { content: 'Something went wrong — please try again.', ephemeral: true };
    if (interaction.deferred) await interaction.editReply(reply).catch(() => null);
    else if (!interaction.replied) await interaction.reply(reply).catch(() => null);
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException',  (err) => console.error('Uncaught exception:', err));

client.login(TOKEN);
