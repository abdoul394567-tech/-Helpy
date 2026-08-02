require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, REST, Routes,
  SlashCommandBuilder
} = require('discord.js');
const config = require('./config');

if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN est absent. Ajoutez-le aux variables Railway ou dans .env local.');
if (!/^\d+$/.test(config.creatorId)) console.warn('config.creatorId doit être remplacé par un ID Discord numérique.');
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const databaseEnabled = Boolean(supabaseUrl && supabaseKey);
if (!databaseEnabled) console.warn('Supabase non configuré : Helpy fonctionne en mode temporaire.');

/** Stockage Supabase minimal : une table JSON, sans dépendance supplémentaire. */
async function databaseRequest(path, options = {}) {
  if (!databaseEnabled) return null;
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Supabase : ${response.status} ${await response.text()}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}
async function loadRecord(recordKey) {
  try { const rows = await databaseRequest(`helpy_data?key=eq.${encodeURIComponent(recordKey)}&select=value`); return rows?.[0]?.value || null; }
  catch (error) { console.error(`Lecture Supabase (${recordKey}) :`, error.message); return null; }
}
async function saveRecord(recordKey, value) {
  try { await databaseRequest('helpy_data?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: recordKey, value }) }); }
  catch (error) { console.error(`Sauvegarde Supabase (${recordKey}) :`, error.message); }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User]
});
const command = new SlashCommandBuilder().setName('dashboard').setDescription('Ouvrir le dashboard Corex').toJSON();
const stats = new Map(); // guildId:userId -> données de session ; une base de données est nécessaire pour les conserver après redémarrage.
const locks = new Map(); // guildId:channelId -> anciennes permissions
const settings = new Map(); // Configuration de session par serveur (remplacez par une base de données pour une persistance Railway).
const recentMessages = new Map();
const recentJoins = new Map();
const giveaways = new Map();
const voiceStarts = new Map();
const color = config.color;
const key = (g, u) => `${g}:${u}`;
const data = (g, u) => { const k = key(g, u); if (!stats.has(k)) stats.set(k, { messages: 0, warns: [], reputation: 0, voiceSeconds: 0, joins: [] }); return stats.get(k); };
const server = guild => {
  if (!settings.has(guild.id)) settings.set(guild.id, {
    welcome: { enabled: false, channelId: '', message: 'Bienvenue {user} sur **{server}** ! Tu es le membre #{memberCount}.', goodbye: 'Au revoir {user}.' },
    logsChannelId: '', logEvents: ['messages', 'moderation', 'server', 'members'], antiRaid: false, antiSpam: false, antiLinks: false, antiMentions: false, antiCaps: false, antiEmoji: false, antiBots: false, blockedWords: [], autoRoleId: '',
    ticketCategoryId: '', tempVoiceHubId: '', tempVoiceCategoryId: '', selfRoleIds: []
  });
  return settings.get(guild.id);
};
async function loadServerState(guild) {
  const saved = await loadRecord(`settings:${guild.id}`);
  if (saved && typeof saved === 'object') settings.set(guild.id, { ...server(guild), ...saved, welcome: { ...server(guild).welcome, ...(saved.welcome || {}) } });
}
const saveServerState = guild => saveRecord(`settings:${guild.id}`, server(guild));
async function loadMemberState(guildId, userId) {
  const saved = await loadRecord(`member:${guildId}:${userId}`);
  if (saved && typeof saved === 'object') stats.set(key(guildId, userId), { messages: 0, warns: [], reputation: 0, voiceSeconds: 0, joins: [], ...saved });
}
const saveMemberState = (guildId, userId) => saveRecord(`member:${guildId}:${userId}`, data(guildId, userId));
const memberSaveTimers = new Map();
function queueMemberSave(guildId, userId) {
  const recordKey = key(guildId, userId); clearTimeout(memberSaveTimers.get(recordKey));
  memberSaveTimers.set(recordKey, setTimeout(() => { memberSaveTimers.delete(recordKey); saveMemberState(guildId, userId); }, 15_000));
}
const isCreator = i => i.user.id === config.creatorId;
const isAdmin = i => i.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
const canModerate = i => isAdmin(i) || isCreator(i);
const stamp = d => `<t:${Math.floor(d.getTime() / 1000)}:F>`;
const truncate = (s, n = 1000) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
const formatTemplate = (text, guild, member) => text.replaceAll('{user}', `<@${member.id}>`).replaceAll('{server}', guild.name).replaceAll('{memberCount}', String(guild.memberCount));
async function sendLog(guild, embed) { const id = server(guild).logsChannelId, channel = id && guild.channels.cache.get(id); if (channel?.isTextBased()) await channel.send({ embeds: [embed.setColor(color).setTimestamp()] }).catch(() => {}); }

function homeEmbed(guild, interaction) {
  const online = guild.members.cache.filter(m => !m.user.bot && m.presence?.status && m.presence.status !== 'offline').size;
  return new EmbedBuilder().setColor(color).setAuthor({ name: `${config.botName} • Dashboard`, iconURL: guild.iconURL() || undefined })
    .setDescription(`Bienvenue ${interaction.user}. Utilisez les contrôles ci-dessous pour naviguer.`)
    .addFields(
      { name: 'Membres', value: `${guild.memberCount} total · ${online} en ligne`, inline: true },
      { name: 'Salons', value: String(guild.channels.cache.size), inline: true },
      { name: 'Rôles', value: String(guild.roles.cache.size), inline: true },
      { name: 'Bots', value: String(guild.members.cache.filter(m => m.user.bot).size), inline: true },
      { name: 'Serveur créé', value: stamp(guild.createdAt), inline: true },
      { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0} · niveau ${guild.premiumTier}`, inline: true },
      { name: 'Propriétaire', value: `<@${guild.ownerId}>`, inline: true }
    ).setFooter({ text: `Dashboard privé • ${config.botName}` }).setTimestamp();
}
function nav(interaction, page = 'home') {
  const admin = canModerate(interaction), creator = isCreator(interaction);
  const options = [
    { label: 'Accueil', value: 'home', emoji: config.emojis.home, default: page === 'home' },
    { label: 'Mon profil', value: 'profile', emoji: config.emojis.profile, default: page === 'profile' },
    { label: 'Membres', value: 'members', emoji: config.emojis.members, default: page === 'members' },
  ];
  if (admin) options.push(
    { label: 'Modération', value: 'mod', emoji: config.emojis.moderation, default: page === 'mod' },
    { label: 'Gestion serveur', value: 'manage', emoji: '🧰', default: page === 'manage' }
  );
  if (creator) options.push({ label: 'Creator', value: 'creator', emoji: config.emojis.creator, default: page === 'creator' });
  if (admin) options.push({ label: 'Paramètres', value: 'settings', emoji: config.emojis.settings, default: page === 'settings' });
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash:${interaction.user.id}:nav`).setPlaceholder('Navigation').addOptions(options))];
}
function back(interaction, page) { return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dash:${interaction.user.id}:page:${page}`).setLabel('Retour').setStyle(ButtonStyle.Secondary)); }
function memberEmbed(guild, member) {
  const s = data(guild.id, member.id), user = member.user;
  const important = ['Administrator', 'ManageGuild', 'BanMembers', 'KickMembers', 'ModerateMembers'].filter(p => member.permissions.has(PermissionsBitField.Flags[p] || 0));
  const activity = member.presence?.activities?.find(a => a.name)?.name || 'Aucune';
  return new EmbedBuilder().setColor(color).setAuthor({ name: `Profil de ${user.tag}`, iconURL: user.displayAvatarURL() }).setThumbnail(user.displayAvatarURL({ size: 512 }))
    .addFields(
      { name: 'Identité', value: `Pseudo : ${user.username}\nAffichage : ${member.displayName}\nID : \`${user.id}\``, inline: true },
      { name: 'Dates', value: `Compte : ${stamp(user.createdAt)}\nArrivée : ${member.joinedAt ? stamp(member.joinedAt) : 'Inconnue'}`, inline: true },
      { name: 'Activité', value: `Messages : ${s.messages}\nVocal : ${Math.floor(s.voiceSeconds / 60)} min\nNiveau XP : ${Math.floor(s.messages / 100) + 1}\nStatut : ${member.presence?.status || 'hors ligne'}`, inline: true },
      { name: 'Sanctions / réputation', value: `Warns : ${s.warns.length}\nRéputation : ${s.reputation >= 0 ? '+' : ''}${s.reputation}\n${member.communicationDisabledUntilTimestamp > Date.now() ? 'Timeout actif' : 'Aucun timeout actif'}`, inline: true },
      { name: `Rôles (${Math.max(0, member.roles.cache.size - 1)})`, value: truncate(member.roles.cache.filter(r => r.id !== guild.id).map(r => r.toString()).join(' ') || 'Aucun', 1024) },
      { name: 'Permissions importantes', value: important.join(', ') || 'Aucune' }
    ).addFields({ name: 'Historique récent', value: s.joins.slice(-4).map(x => `${x.type === 'join' ? '📥 Arrivée' : '📤 Départ'} ${stamp(new Date(x.at))}`).join('\n') || 'Aucun événement enregistré.' })
    .setFooter({ text: databaseEnabled ? 'Données enregistrées dans Supabase.' : 'Mode temporaire : configurez Supabase pour conserver les données.' }).setTimestamp();
}
function targetMenu(interaction, action = 'profile') {
  const members = interaction.guild.members.cache.filter(m => !m.user.bot).first(25);
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash:${interaction.user.id}:target:${action}`).setPlaceholder('Choisir un membre').addOptions(members.map(m => ({ label: truncate(m.user.tag, 100), value: m.id, description: truncate(m.displayName, 100) }))));
}
function modEmbed() { return new EmbedBuilder().setColor(color).setTitle('🛡️ Modération').setDescription('Choisissez d’abord un membre, puis sélectionnez une action. Les actions sont vérifiées à chaque clic.').addFields({ name: 'Outils', value: 'Ban · Kick · Timeout · Unmute · Warn · Unwarn · Sanctions · Rôles\nClear · Lock/Unlock · Slowmode' }); }
function creatorEmbed() { return new EmbedBuilder().setColor(color).setTitle('👑 Creator').setDescription('Outils réservés au propriétaire du bot. Les actions destructrices exigent une confirmation.').addFields({ name: 'Fonctions', value: 'Say · Update · Ban All (confirmation) · Reconnecter le bot' }); }
function settingsEmbed() { return new EmbedBuilder().setColor(color).setTitle('⚙️ Paramètres du serveur').setDescription(`Paramètres globaux configurés dans \`config.js\`.\nTimeout par défaut : **${config.defaults.timeoutMinutes} min**\nSlowmode par défaut : **${config.defaults.slowmodeSeconds} s**\nClear par défaut : **${config.defaults.clearLimit} messages**`); }
function managementEmbed(guild) {
  const s = server(guild);
  return new EmbedBuilder().setColor(color).setTitle('🧰 Gestion du serveur — Helpy')
    .setDescription('Configurez Helpy sans utiliser d’autres commandes Slash.')
    .addFields(
      { name: '👋 Accueil', value: `Bienvenue : ${s.welcome.enabled ? 'activé' : 'désactivé'}\nSalon logs : ${s.logsChannelId ? `<#${s.logsChannelId}>` : 'non défini'}`, inline: true },
      { name: '🛡️ Sécurité', value: `Anti-raid : ${s.antiRaid ? 'activé' : 'désactivé'}\nAnti-spam : ${s.antiSpam ? 'activé' : 'désactivé'}\nMots filtrés : ${s.blockedWords.length}`, inline: true },
      { name: '✨ Automatisations', value: `Autorôle : ${s.autoRoleId ? `<@&${s.autoRoleId}>` : 'non défini'}\nTickets : ${s.ticketCategoryId ? 'configurés' : 'non configurés'}\nVocal temporaire : ${s.tempVoiceHubId ? 'configuré' : 'non configuré'}`, inline: true }
    ).setFooter({ text: 'Les réglages sont en mémoire durant cette session Railway.' });
}
function managementRows(i) { return [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:welcome`).setLabel('Bienvenue').setEmoji('👋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:logs`).setLabel('Logs').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:automod`).setLabel('AutoMod').setEmoji('🤖').setStyle(ButtonStyle.Danger)),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:tickets`).setLabel('Tickets').setEmoji('🎫').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:giveaways`).setLabel('Giveaways').setEmoji('🎉').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:roles`).setLabel('Rôles').setEmoji('🎭').setStyle(ButtonStyle.Secondary)),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:statistics`).setLabel('Statistiques').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:voice`).setLabel('Vocaux temporaires').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:settings`).setLabel('Paramètres').setEmoji('⚙️').setStyle(ButtonStyle.Secondary))
]; }
function securityEmbed(guild) { const s = server(guild); return new EmbedBuilder().setColor(color).setTitle('🛡️ Sécurité').setDescription(`Anti-raid : **${s.antiRaid ? 'activé' : 'désactivé'}**\nAnti-spam : **${s.antiSpam ? 'activé' : 'désactivé'}**\nMots bloqués : ${s.blockedWords.length ? s.blockedWords.map(x => `\`${x}\``).join(', ') : 'aucun'}`); }
function securityRows(i) { return [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:toggleRaid`).setLabel('Anti-raid').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:toggleSpam`).setLabel('Anti-spam').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:words`).setLabel('Mots interdits').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:manage`).setLabel('Retour').setStyle(ButtonStyle.Secondary)
)]; }
function engagementEmbed() { return new EmbedBuilder().setColor(color).setTitle('✨ Communauté').setDescription('Publiez dans le salon actuel : panneaux de tickets, giveaways, sondages et annonces. Le classement utilise les messages de cette session.'); }
function engagementRows(i) { return [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:tickets`).setLabel('Panneau tickets').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:giveaway`).setLabel('Giveaway').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:poll`).setLabel('Sondage').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:announcement`).setLabel('Annonce').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:leaderboard`).setLabel('Classement').setStyle(ButtonStyle.Success)
)]; }
function moduleEmbed(title, description, fields = []) { return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).addFields(fields); }
function oneRow(...buttons) { return new ActionRowBuilder().addComponents(buttons); }
function modal(id, title, fields) { const m = new ModalBuilder().setCustomId(id).setTitle(title); fields.forEach(f => m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(f.style || TextInputStyle.Short).setRequired(f.required !== false).setPlaceholder(f.placeholder || '').setValue(f.value || '')))); return m; }
function owned(interaction) { const p = interaction.customId.split(':'); return p[0] === 'dash' && p[1] === interaction.user.id; }
async function safeReply(interaction, payload) { return interaction.replied || interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload); }

client.once('ready', async () => {
  console.log(`${config.botName} connecté en tant que ${client.user.tag}`);
  await Promise.all(client.guilds.cache.map(guild => loadServerState(guild)));
  try { await client.application.commands.set([command]); console.log('Commande /dashboard enregistrée.'); } catch (e) { console.error('Impossible d’enregistrer la commande :', e.message); }
});
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const s = server(message.guild), memberData = data(message.guild.id, message.author.id);
  memberData.messages++;
  queueMemberSave(message.guild.id, message.author.id);
  const now = Date.now(), messageKey = key(message.guild.id, message.author.id);
  const history = (recentMessages.get(messageKey) || []).filter(t => now - t < config.defaults.antiSpamWindowSeconds * 1000);
  history.push(now); recentMessages.set(messageKey, history);
  const blocked = s.blockedWords.find(word => message.content.toLowerCase().includes(word.toLowerCase()));
  const hasLink = /https?:\/\/|discord\.gg\/|www\./i.test(message.content);
  const letters = message.content.replace(/[^a-zà-ÿ]/gi, '');
  const tooManyCaps = letters.length >= 12 && (letters.match(/[A-ZÀ-Ý]/g)?.length || 0) / letters.length > 0.75;
  const emojiCount = (message.content.match(/[\p{Extended_Pictographic}]/gu) || []).length;
  const violation = blocked ? `mot filtré : ${blocked}` : s.antiSpam && history.length > config.defaults.antiSpamMessages ? 'spam détecté' : s.antiLinks && hasLink ? 'lien ou publicité non autorisé' : s.antiMentions && message.mentions.users.size >= 5 ? 'mass mention détectée' : s.antiCaps && tooManyCaps ? 'excès de majuscules' : s.antiEmoji && emojiCount >= 8 ? 'emoji spam détecté' : '';
  if (violation) {
    await message.delete().catch(() => {});
    if (message.member?.moderatable) await message.member.timeout(60_000, `AutoMod Helpy : ${violation}`).catch(() => {});
    await sendLog(message.guild, new EmbedBuilder().setTitle('🛡️ Auto-modération').setDescription(`${message.author} : ${violation}.`));
  }
});
client.on('messageDelete', async message => {
  if (!message.guild || message.author?.bot) return;
  await sendLog(message.guild, new EmbedBuilder().setTitle('🗑️ Message supprimé').setDescription(`Salon : ${message.channel}\nAuteur : ${message.author || 'Inconnu'}\nContenu : ${truncate(message.content || 'Non disponible', 900)}`));
});
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot || oldMessage.content === newMessage.content) return;
  await sendLog(newMessage.guild, new EmbedBuilder().setTitle('✏️ Message modifié').setDescription(`Salon : ${newMessage.channel}\nAuteur : ${newMessage.author}\nAvant : ${truncate(oldMessage.content || 'Non disponible', 400)}\nAprès : ${truncate(newMessage.content || 'Non disponible', 400)}`));
});
client.on('channelCreate', channel => sendLog(channel.guild, new EmbedBuilder().setTitle('➕ Salon créé').setDescription(`${channel} (${channel.type})`)));
client.on('channelDelete', channel => sendLog(channel.guild, new EmbedBuilder().setTitle('➖ Salon supprimé').setDescription(`${channel.name} (${channel.type})`)));
client.on('roleCreate', role => sendLog(role.guild, new EmbedBuilder().setTitle('➕ Rôle créé').setDescription(`${role} (${role.id})`)));
client.on('roleUpdate', (oldRole, role) => { if (oldRole.name !== role.name || oldRole.color !== role.color) return sendLog(role.guild, new EmbedBuilder().setTitle('✏️ Rôle modifié').setDescription(`${oldRole.name} → ${role.name}`)); });
client.on('guildMemberUpdate', (oldMember, member) => { if (oldMember.nickname !== member.nickname) return sendLog(member.guild, new EmbedBuilder().setTitle('✏️ Pseudo modifié').setDescription(`${member.user} : \`${oldMember.nickname || oldMember.user.username}\` → \`${member.nickname || member.user.username}\``)); });
client.on('guildMemberAdd', async member => {
  const s = server(member.guild), now = Date.now(), joins = (recentJoins.get(member.guild.id) || []).filter(t => now - t < config.defaults.antiRaidWindowSeconds * 1000);
  joins.push(now); recentJoins.set(member.guild.id, joins);
  const memberData = data(member.guild.id, member.id); memberData.joins.push({ type: 'join', at: now }); queueMemberSave(member.guild.id, member.id);
  if (s.antiRaid && joins.length >= config.defaults.antiRaidJoins) {
    const everyone = member.guild.roles.everyone;
    for (const channel of member.guild.channels.cache.values()) if (channel.isTextBased()) await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, 'Anti-raid Helpy').catch(() => {});
    await sendLog(member.guild, new EmbedBuilder().setColor(0xED4245).setTitle('🚨 Anti-raid déclenché').setDescription(`${joins.length} arrivées rapides : salons texte verrouillés.`));
  }
  if (s.autoRoleId) await member.roles.add(s.autoRoleId, 'Autorôle Helpy').catch(() => {});
  const channel = member.guild.channels.cache.get(s.welcome.channelId);
  if (s.welcome.enabled && channel?.isTextBased()) await channel.send({ content: formatTemplate(s.welcome.message, member.guild, member), allowedMentions: { users: [member.id] } }).catch(() => {});
  await sendLog(member.guild, new EmbedBuilder().setTitle('📥 Arrivée').setDescription(`${member} a rejoint le serveur.`));
});
client.on('guildMemberRemove', async member => {
  const s = server(member.guild), channel = member.guild.channels.cache.get(s.welcome.channelId);
  const memberData = data(member.guild.id, member.id); memberData.joins.push({ type: 'leave', at: Date.now() }); queueMemberSave(member.guild.id, member.id);
  if (s.welcome.enabled && channel?.isTextBased()) await channel.send({ content: formatTemplate(s.welcome.goodbye, member.guild, member), allowedMentions: { users: [member.id] } }).catch(() => {});
  await sendLog(member.guild, new EmbedBuilder().setTitle('📤 Départ').setDescription(`${member.user.tag} a quitté le serveur.`));
});
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.member.user.bot) {
    const voiceKey = key(newState.guild.id, newState.member.id), now = Date.now();
    if (!oldState.channelId && newState.channelId) voiceStarts.set(voiceKey, now);
    if (oldState.channelId && (!newState.channelId || oldState.channelId !== newState.channelId)) {
      const started = voiceStarts.get(voiceKey) || now;
      const profile = data(newState.guild.id, newState.member.id); profile.voiceSeconds += Math.floor((now - started) / 1000); queueMemberSave(newState.guild.id, newState.member.id);
      if (newState.channelId) voiceStarts.set(voiceKey, now); else voiceStarts.delete(voiceKey);
    }
  }
  const s = server(newState.guild);
  if (newState.channelId !== s.tempVoiceHubId) return;
  const category = s.tempVoiceCategoryId || newState.channel?.parentId;
  const channel = await newState.guild.channels.create({ name: `🔊 ${newState.member.displayName}`, type: ChannelType.GuildVoice, parent: category || undefined, permissionOverwrites: [{ id: newState.member.id, allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.MoveMembers] }] }).catch(() => null);
  if (channel) await newState.setChannel(channel, 'Vocal temporaire Helpy').catch(() => {});
});
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'dashboard') {
      if (!interaction.inGuild()) return interaction.reply({ content: 'Cette commande est disponible uniquement sur un serveur.', ephemeral: true });
      await loadServerState(interaction.guild);
      await loadMemberState(interaction.guild.id, interaction.user.id);
      return interaction.reply({ embeds: [homeEmbed(interaction.guild, interaction)], components: nav(interaction), ephemeral: true });
    }
    if (interaction.customId?.startsWith('helpy:')) return handleHelpyInteraction(interaction);
    if (!interaction.customId?.startsWith('dash:') || !owned(interaction)) return;
    if (!interaction.inGuild()) return interaction.reply({ content: 'Action disponible uniquement sur un serveur.', ephemeral: true });
    const [, , type, ...args] = interaction.customId.split(':');
    if (type === 'nav' && interaction.isStringSelectMenu()) return renderPage(interaction, interaction.values[0]);
    if (type === 'page') return renderPage(interaction, args[0]);
    if (type === 'target' && interaction.isStringSelectMenu()) {
      if (args[0] === 'role') return toggleRole(interaction, args[1], interaction.values[0]);
      return showTarget(interaction, args[0], interaction.values[0]);
    }
    if (type === 'advanced' && interaction.isStringSelectMenu()) return runAction(interaction, interaction.values[0], args[0]);
    if (type === 'advancedmove' && interaction.isStringSelectMenu()) return moveMemberToVoice(interaction, args[0], interaction.values[0]);
    if (type === 'channelconfig' && interaction.isStringSelectMenu()) return channelConfig(interaction, args[0], interaction.values[0]);
    if (type === 'action') return runAction(interaction, args[0], args[1]);
    if (type === 'setting') return settingAction(interaction, args[0]);
    if (type === 'modal') return handleModal(interaction, args[0], args[1]);
    if (type === 'creator') return creatorAction(interaction, args[0]);
  } catch (error) {
    console.error(error);
    const content = `Erreur : ${error.message || 'action impossible'}`;
    if (interaction.isRepliable()) await safeReply(interaction, { content, ephemeral: true }).catch(() => {});
  }
});

async function renderPage(i, page) {
  if (page === 'home') return i.update({ embeds: [homeEmbed(i.guild, i)], components: nav(i, page) });
  if (page === 'profile') { await loadMemberState(i.guild.id, i.user.id); return i.update({ embeds: [memberEmbed(i.guild, i.member)], components: [...nav(i, page), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:members`).setLabel('Voir un autre profil').setStyle(ButtonStyle.Primary))] }); }
  if (page === 'members') return i.update({ embeds: [new EmbedBuilder().setColor(color).setTitle('👥 Membres').setDescription('Sélectionnez un membre pour consulter son profil.')], components: [...nav(i, page), targetMenu(i, 'profile')] });
  if (page === 'mod') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [modEmbed()], components: [...nav(i, page), targetMenu(i, 'mod')] }); }
  if (page === 'logs') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); const s = server(i.guild); return i.update({ embeds: [moduleEmbed('📜 Logs', 'Helpy envoie les actions importantes dans le salon configuré.', [{ name: 'Salon actuel', value: s.logsChannelId ? `<#${s.logsChannelId}>` : 'Non défini' }, { name: 'Événements', value: 'Messages, modération, salons, rôles, arrivées/départs et pseudos.' }])], components: [...nav(i, page), oneRow(new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:logs`).setLabel('Choisir le salon').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:logevents`).setLabel('Catégories').setStyle(ButtonStyle.Secondary))] }); }
  if (page === 'tickets') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [moduleEmbed('🎫 Tickets', 'Publie un panneau dans le salon actuel. Les utilisateurs peuvent ouvrir un ticket privé.', [{ name: 'Fonctions', value: 'Ouverture, fermeture, catégories et journalisation.' }])], components: [...nav(i, page), oneRow(new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:tickets`).setLabel('Créer un panneau').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:tickettools`).setLabel('Gérer ce ticket').setStyle(ButtonStyle.Secondary))] }); }
  if (page === 'automod') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); const s = server(i.guild); return i.update({ embeds: [moduleEmbed('🤖 AutoMod', 'Protection automatique configurable.', [{ name: 'État', value: `Anti-raid : **${s.antiRaid ? 'ON' : 'OFF'}**\nAnti-spam : **${s.antiSpam ? 'ON' : 'OFF'}**\nMots filtrés : **${s.blockedWords.length}**` }, { name: 'Protections', value: 'Spam, liens, pubs, insultes, mass-mentions, caps, emojis et ghost pings.' }])], components: [...nav(i, page), oneRow(new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:automod`).setLabel('Configurer').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:words`).setLabel('Mots interdits').setStyle(ButtonStyle.Secondary))] }); }
  if (page === 'giveaways') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [moduleEmbed('🎉 Giveaways', 'Crée un giveaway interactif dans le salon actuel.', [{ name: 'Actions', value: 'Créer, terminer et tirer un nouveau gagnant.' }])], components: [...nav(i, page), oneRow(new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:giveaway`).setLabel('Créer un giveaway').setStyle(ButtonStyle.Primary))] }); }
  if (page === 'roles') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); const s = server(i.guild); return i.update({ embeds: [moduleEmbed('🎭 Rôles', 'Autorôles et panneau de rôles libre-service.', [{ name: 'Autorôle', value: s.autoRoleId ? `<@&${s.autoRoleId}>` : 'Non configuré' }, { name: 'Rôles libre-service', value: String(s.selfRoleIds.length) }])], components: [...nav(i, page), oneRow(new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:roles`).setLabel('Configurer les rôles').setStyle(ButtonStyle.Primary))] }); }
  if (page === 'welcome') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); const s = server(i.guild); return i.update({ embeds: [moduleEmbed('👋 Bienvenue', 'Messages d’arrivée et de départ personnalisés.', [{ name: 'État', value: s.welcome.enabled ? 'Activé' : 'Désactivé' }, { name: 'Variables', value: '`{user}`, `{server}`, `{memberCount}`' }])], components: [...nav(i, page), oneRow(new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:welcome`).setLabel('Configurer').setStyle(ButtonStyle.Primary))] }); }
  if (page === 'statistics') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); const totalMessages = [...stats.entries()].filter(([k]) => k.startsWith(`${i.guild.id}:`)).reduce((n, [, x]) => n + x.messages, 0); return i.update({ embeds: [moduleEmbed('📊 Statistiques du serveur', 'Vue globale de l’activité Helpy.', [{ name: 'Membres / Bots', value: `${i.guild.memberCount} / ${i.guild.members.cache.filter(m => m.user.bot).size}`, inline: true }, { name: 'Salons / Rôles', value: `${i.guild.channels.cache.size} / ${i.guild.roles.cache.size}`, inline: true }, { name: 'Messages enregistrés', value: String(totalMessages), inline: true }, { name: 'Boosts', value: `${i.guild.premiumSubscriptionCount || 0} · niveau ${i.guild.premiumTier}`, inline: true }])], components: [...nav(i, page), oneRow(new ButtonBuilder().setCustomId(`dash:${i.user.id}:setting:leaderboard`).setLabel('Classement XP').setStyle(ButtonStyle.Success))] }); }
  if (page === 'manage') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [managementEmbed(i.guild)], components: [...nav(i, page), ...managementRows(i)] }); }
  if (page === 'security') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [securityEmbed(i.guild)], components: [...nav(i, 'manage'), ...securityRows(i)] }); }
  if (page === 'engagement') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [engagementEmbed()], components: [...nav(i, 'manage'), ...engagementRows(i), back(i, 'manage')] }); }
  if (page === 'creator') { if (!isCreator(i)) throw new Error('Permission Creator requise.'); return i.update({ embeds: [creatorEmbed()], components: [...nav(i, page), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dash:${i.user.id}:creator:say`).setLabel('Say').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`dash:${i.user.id}:creator:update`).setLabel('Update').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`dash:${i.user.id}:creator:banall`).setLabel('Ban All').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`dash:${i.user.id}:creator:reconnect`).setLabel('Reconnecter').setStyle(ButtonStyle.Secondary))] }); }
  if (page === 'settings') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [settingsEmbed()], components: nav(i, page) }); }
}
function chooseChannel(i, action, title, kind, allowNone = false) {
  let channels = i.guild.channels.cache.filter(channel => kind === 'text' ? channel.isTextBased() : kind === 'voice' ? channel.type === ChannelType.GuildVoice : channel.type === ChannelType.GuildCategory).first(25);
  const options = channels.map(channel => ({ label: truncate(channel.name, 100), value: channel.id, emoji: kind === 'text' ? '💬' : kind === 'voice' ? '🔊' : '📁' }));
  if (allowNone) options.unshift({ label: 'Aucune catégorie', value: 'none', emoji: '📂' });
  if (!options.length) throw new Error('Aucun salon compatible trouvé.');
  return i.update({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription('Sélectionne simplement un élément dans la liste.')], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash:${i.user.id}:channelconfig:${action}`).setPlaceholder(title).addOptions(options)), back(i, 'manage')] });
}
async function channelConfig(i, action, channelId) {
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const s = server(i.guild), channel = channelId === 'none' ? null : i.guild.channels.cache.get(channelId);
  if (action === 'welcome') return i.showModal(modal(`dash:${i.user.id}:modal:welcome:0`, 'Bienvenue et au revoir', [
    { id: 'channel', label: 'Salon sélectionné', value: channel.id }, { id: 'welcome', label: 'Message de bienvenue', style: TextInputStyle.Paragraph, value: s.welcome.message }, { id: 'goodbye', label: 'Message d’au revoir', style: TextInputStyle.Paragraph, value: s.welcome.goodbye }, { id: 'enabled', label: 'Activer ? (oui / non)', value: s.welcome.enabled ? 'oui' : 'non' }
  ]));
  if (action === 'logs') { s.logsChannelId = channel.id; await saveServerState(i.guild); return i.update({ embeds: [moduleEmbed('📜 Logs', `Les logs seront envoyés dans ${channel}.`)], components: [back(i, 'manage')] }); }
  if (action === 'voice') { s.tempVoiceHubId = channel.id; s.tempVoiceCategoryId = channel.parentId || ''; await saveServerState(i.guild); return i.update({ embeds: [moduleEmbed('🔊 Vocaux temporaires', `Le salon ${channel} créera un vocal temporaire.`)], components: [back(i, 'manage')] }); }
  if (action === 'tickets') return i.showModal(modal(`dash:${i.user.id}:modal:tickets:0`, 'Panneau de tickets', [{ id: 'category', label: 'Catégorie sélectionnée', value: channel?.id || '', required: false }, { id: 'text', label: 'Texte du panneau', style: TextInputStyle.Paragraph, value: 'Besoin d’aide ? Ouvre un ticket privé avec l’équipe.' }]));
}
async function settingAction(i, action) {
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const s = server(i.guild);
  if (action === 'welcome') return chooseChannel(i, 'welcome', 'Choisis le salon de bienvenue', 'text');
  if (action === 'logs') return chooseChannel(i, 'logs', 'Choisis le salon qui recevra les logs', 'text');
  if (action === 'voice') return chooseChannel(i, 'voice', 'Choisis le vocal « Créer un salon »', 'voice');
  if (action === 'tickets') return chooseChannel(i, 'tickets', 'Choisis la catégorie des tickets', 'category', true);
  if (action === 'welcome-old') return i.showModal(modal(`dash:${i.user.id}:modal:welcome:0`, 'Bienvenue et au revoir', [
    { id: 'channel', label: 'ID du salon', value: s.welcome.channelId, placeholder: 'Clic droit salon → Copier l’identifiant' },
    { id: 'welcome', label: 'Message de bienvenue', style: TextInputStyle.Paragraph, value: s.welcome.message },
    { id: 'goodbye', label: 'Message d’au revoir', style: TextInputStyle.Paragraph, value: s.welcome.goodbye },
    { id: 'enabled', label: 'Activer ? (oui / non)', value: s.welcome.enabled ? 'oui' : 'non' }
  ]));
  if (action === 'logs-old') return i.showModal(modal(`dash:${i.user.id}:modal:logs:0`, 'Salon de logs', [{ id: 'channel', label: 'ID du salon (vide pour désactiver)', value: s.logsChannelId, required: false }]));
  if (action === 'logevents') return i.showModal(modal(`dash:${i.user.id}:modal:logevents:0`, 'Catégories de logs', [{ id: 'events', label: 'Catégories séparées par ,', style: TextInputStyle.Paragraph, value: s.logEvents.join(', '), placeholder: 'messages, moderation, server, members' }]));
  if (action === 'security') return renderPage(i, 'security');
  if (action === 'toggleRaid') { s.antiRaid = !s.antiRaid; await saveServerState(i.guild); return i.update({ embeds: [securityEmbed(i.guild)], components: [...nav(i, 'manage'), ...securityRows(i)] }); }
  if (action === 'toggleSpam') { s.antiSpam = !s.antiSpam; await saveServerState(i.guild); return i.update({ embeds: [securityEmbed(i.guild)], components: [...nav(i, 'manage'), ...securityRows(i)] }); }
  if (action === 'words') return i.showModal(modal(`dash:${i.user.id}:modal:words:0`, 'Mots interdits', [{ id: 'words', label: 'Mots séparés par des virgules', style: TextInputStyle.Paragraph, value: s.blockedWords.join(', '), required: false }]));
  if (action === 'automod') return i.showModal(modal(`dash:${i.user.id}:modal:automod:0`, 'Réglages AutoMod', [{ id: 'spam', label: 'Anti-spam (oui/non)', value: s.antiSpam ? 'oui' : 'non' }, { id: 'links', label: 'Anti-liens et pub (oui/non)', value: s.antiLinks ? 'oui' : 'non' }, { id: 'mentions', label: 'Anti mass-mentions (oui/non)', value: s.antiMentions ? 'oui' : 'non' }, { id: 'caps', label: 'Anti-caps (oui/non)', value: s.antiCaps ? 'oui' : 'non' }, { id: 'emoji', label: 'Anti emoji-spam (oui/non)', value: s.antiEmoji ? 'oui' : 'non' }]));
  if (action === 'roles') return i.showModal(modal(`dash:${i.user.id}:modal:roles:0`, 'Autorôles et rôles libre-service', [{ id: 'autorole', label: 'ID de l’autorôle (vide pour désactiver)', value: s.autoRoleId, required: false }, { id: 'selfroles', label: 'IDs des rôles libre-service (séparés par ,)', style: TextInputStyle.Paragraph, value: s.selfRoleIds.join(', '), required: false }]));
  if (action === 'engagement') return renderPage(i, 'engagement');
  if (action === 'tickettools') { if (!i.channel?.topic?.startsWith('helpy-ticket:')) throw new Error('Ouvre cette page depuis un salon ticket Helpy.'); return i.reply({ content: 'Gestion du ticket :', components: [oneRow(new ButtonBuilder().setCustomId('helpy:ticketRename').setLabel('Renommer').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('helpy:ticketTranscript').setLabel('Transcription').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('helpy:closeTicket').setLabel('Fermer').setStyle(ButtonStyle.Danger))], ephemeral: true }); }
  if (action === 'giveaway') return i.showModal(modal(`dash:${i.user.id}:modal:giveaway:0`, 'Créer un giveaway', [{ id: 'prize', label: 'Prix' }, { id: 'seconds', label: 'Durée en secondes (10 à 604800)', value: '3600' }]));
  if (action === 'poll') return i.showModal(modal(`dash:${i.user.id}:modal:poll:0`, 'Créer un sondage', [{ id: 'question', label: 'Question', style: TextInputStyle.Paragraph }, { id: 'options', label: 'Options, séparées par | (2 à 5)', placeholder: 'Option 1 | Option 2' }]));
  if (action === 'announcement') return i.showModal(modal(`dash:${i.user.id}:modal:announcement:0`, 'Publier une annonce', [{ id: 'title', label: 'Titre' }, { id: 'text', label: 'Contenu', style: TextInputStyle.Paragraph }]));
  if (action === 'leaderboard') { const top = [...stats.entries()].filter(([k]) => k.startsWith(`${i.guild.id}:`)).sort((a,b) => b[1].messages - a[1].messages).slice(0, 10); return i.reply({ embeds: [new EmbedBuilder().setColor(color).setTitle('🏆 Classement — session').setDescription(top.length ? top.map(([k, x], n) => `**${n + 1}.** <@${k.split(':')[1]}> — ${x.messages} messages`).join('\n') : 'Aucune activité pour le moment.')], ephemeral: true }); }
}
async function showTarget(i, mode, id) {
  const m = await i.guild.members.fetch(id);
  await loadMemberState(i.guild.id, m.id);
  if (mode === 'profile') return i.update({ embeds: [memberEmbed(i.guild, m)], components: [...nav(i, 'members'), back(i, 'members')] });
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const actions = [['ban','Ban',ButtonStyle.Danger],['kick','Kick',ButtonStyle.Danger],['timeout','Timeout',ButtonStyle.Secondary],['unmute','Unmute',ButtonStyle.Secondary],['warn','Warn',ButtonStyle.Secondary],['unwarn','Unwarn',ButtonStyle.Secondary],['sanctions','Sanctions',ButtonStyle.Primary],['roles','Rôles',ButtonStyle.Primary]];
  const row1 = new ActionRowBuilder().addComponents(actions.slice(0, 4).map(([a,l,s]) => new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:${a}:${id}`).setLabel(l).setStyle(s)));
  const row2 = new ActionRowBuilder().addComponents(actions.slice(4).map(([a,l,s]) => new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:${a}:${id}`).setLabel(l).setStyle(s)));
  return i.update({ embeds: [memberEmbed(i.guild, m), new EmbedBuilder().setColor(color).setDescription(`Actions de modération pour ${m}.`)], components: [...nav(i, 'mod'), row1, row2, new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash:${i.user.id}:advanced:${id}`).setPlaceholder('Outils avancés').addOptions(
    { label: 'Changer le pseudo', value: 'nickname', emoji: '✏️' }, { label: 'Softban', value: 'softban', emoji: '🔨' }, { label: 'Mute vocal', value: 'voicemute', emoji: '🔇' }, { label: 'Deafen vocal', value: 'voicedeafen', emoji: '🎧' }, { label: 'Déplacer en vocal', value: 'voicemove', emoji: '↪️' }, { label: 'Expulser du vocal', value: 'voicekick', emoji: '🚪' }
  )), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:clear:0`).setLabel('Clear salon').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:lock:0`).setLabel('Lock salon').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:unlock:0`).setLabel('Unlock salon').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:slowmode:0`).setLabel('Slowmode').setStyle(ButtonStyle.Primary))] });
}
async function runAction(i, action, targetId) {
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const target = targetId !== '0' ? await i.guild.members.fetch(targetId) : null;
  if (['ban','kick','timeout','warn','unwarn','softban'].includes(action)) return i.showModal(modal(`dash:${i.user.id}:modal:${action}:${targetId}`, `${action.toUpperCase()} — ${target.user.tag}`, [{ id: 'reason', label: 'Raison', style: TextInputStyle.Paragraph, placeholder: 'Raison de la sanction' }, ...(action === 'timeout' ? [{ id: 'minutes', label: 'Durée (minutes, max 40320)', placeholder: String(config.defaults.timeoutMinutes) }] : [])]));
  if (action === 'nickname') return i.showModal(modal(`dash:${i.user.id}:modal:nickname:${targetId}`, `Pseudo — ${target.user.tag}`, [{ id: 'nickname', label: 'Nouveau pseudo (vide pour retirer)', required: false, value: target.nickname || '' }, { id: 'reason', label: 'Raison', style: TextInputStyle.Paragraph, required: false }]));
  if (action === 'voicemove') { const choices = i.guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).first(25).map(c => ({ label: truncate(c.name, 100), value: c.id, emoji: '🔊' })); if (!choices.length) throw new Error('Aucun salon vocal trouvé.'); return i.update({ embeds: [new EmbedBuilder().setColor(color).setTitle('Déplacer un membre').setDescription(`Choisis le salon vocal pour ${target}.`)], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash:${i.user.id}:advancedmove:${target.id}`).setPlaceholder('Salon vocal cible').addOptions(choices)), back(i, 'mod')] }); }
  if (action === 'clear') return i.showModal(modal(`dash:${i.user.id}:modal:clear:0`, 'Supprimer des messages', [{ id: 'amount', label: 'Nombre (1 à 100)', placeholder: String(config.defaults.clearLimit) }]));
  if (action === 'slowmode') return i.showModal(modal(`dash:${i.user.id}:modal:slowmode:0`, 'Configurer le slowmode', [{ id: 'seconds', label: 'Secondes (0 à 21600)', placeholder: String(config.defaults.slowmodeSeconds) }]));
  if (action === 'unmute') { await target.timeout(null, `Unmute par ${i.user.tag}`); await sendLog(i.guild, new EmbedBuilder().setTitle('🛡️ Unmute').setDescription(`${target} par ${i.user}.`)); return i.reply({ content: `${config.emojis.success} Timeout retiré pour ${target}.`, ephemeral: true }); }
  if (['voicemute', 'voicedeafen', 'voicekick'].includes(action)) {
    if (!target.voice.channel) throw new Error('Ce membre n’est pas en vocal.');
    if (target.roles.highest.position >= i.member.roles.highest.position) throw new Error('Hiérarchie Discord insuffisante.');
    if (action === 'voicemute') await target.voice.setMute(!target.voice.serverMute, `Action par ${i.user.tag}`);
    if (action === 'voicedeafen') await target.voice.setDeaf(!target.voice.serverDeaf, `Action par ${i.user.tag}`);
    if (action === 'voicekick') await target.voice.disconnect(`Expulsion vocale par ${i.user.tag}`);
    await sendLog(i.guild, new EmbedBuilder().setTitle(`🔊 ${action}`).setDescription(`${target} par ${i.user}.`));
    return i.reply({ content: `${config.emojis.success} Action vocale appliquée à ${target}.`, ephemeral: true });
  }
  if (action === 'sanctions') { const w = data(i.guild.id, target.id).warns; return i.reply({ embeds: [new EmbedBuilder().setColor(color).setTitle(`Sanctions — ${target.user.tag}`).setDescription(w.length ? w.map((x,n) => `**${n + 1}.** ${x.reason}\nPar ${x.by} · ${stamp(new Date(x.at))}`).join('\n') : 'Aucune sanction en mémoire.')], ephemeral: true }); }
  if (action === 'roles') { const roles = i.guild.roles.cache.filter(r => r.editable && r.id !== i.guild.id).sort((a,b) => b.position - a.position).first(25); return i.reply({ content: 'Sélectionnez un rôle :', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash:${i.user.id}:target:role:${targetId}`).setPlaceholder('Ajouter ou retirer un rôle').addOptions(roles.map(r => ({ label: r.name, value: r.id }))))], ephemeral: true }); }
  if (action === 'lock' || action === 'unlock') { if (!i.channel?.isTextBased()) throw new Error('Salon texte requis.'); const everyone = i.guild.roles.everyone; if (action === 'lock') { locks.set(`${i.guild.id}:${i.channel.id}`, i.channel.permissionOverwrites.cache.get(everyone.id)?.allow?.bitfield?.toString() || ''); await i.channel.permissionOverwrites.edit(everyone, { SendMessages: false }, `Lock par ${i.user.tag}`); } else await i.channel.permissionOverwrites.edit(everyone, { SendMessages: null }, `Unlock par ${i.user.tag}`); return i.reply({ content: `${config.emojis.success} Salon ${action === 'lock' ? 'verrouillé' : 'déverrouillé'}.`, ephemeral: true }); }
}
async function handleModal(i, action, targetId) {
  if (['say', 'update', 'banall'].includes(action)) return handleCreatorModal(i, action);
  if (['welcome', 'logs', 'logevents', 'words', 'automod', 'roles', 'voice', 'tickets', 'giveaway', 'poll', 'announcement'].includes(action)) return handleSettingModal(i, action);
  if (['nickname', 'voicemove'].includes(action)) return handleAdvancedModal(i, action, targetId);
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const reason = i.fields.fields.has('reason') ? i.fields.getTextInputValue('reason').trim() : '';
  if (action === 'clear') { const n = Number(i.fields.getTextInputValue('amount')); if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('Entrez un nombre entre 1 et 100.'); const deleted = await i.channel.bulkDelete(n, true); await sendLog(i.guild, new EmbedBuilder().setTitle('🧹 Clear').setDescription(`${deleted.size} message(s) supprimé(s) dans ${i.channel} par ${i.user}.`)); return i.reply({ content: `${config.emojis.success} ${deleted.size} message(s) supprimé(s).`, ephemeral: true }); }
  if (action === 'slowmode') { const n = Number(i.fields.getTextInputValue('seconds')); if (!Number.isInteger(n) || n < 0 || n > 21600) throw new Error('Entrez un nombre entre 0 et 21600.'); await i.channel.setRateLimitPerUser(n, `Slowmode par ${i.user.tag}`); return i.reply({ content: `${config.emojis.success} Slowmode réglé sur ${n}s.`, ephemeral: true }); }
  const t = await i.guild.members.fetch(targetId);
  if (t.id === i.user.id || t.id === i.guild.ownerId || t.roles.highest.position >= i.member.roles.highest.position) throw new Error('Vous ne pouvez pas modérer ce membre (hiérarchie Discord).');
  if (action === 'ban') await t.ban({ reason: `${reason} | Par ${i.user.tag}` });
  if (action === 'softban') { await t.ban({ deleteMessageSeconds: 604800, reason: `${reason} | Softban par ${i.user.tag}` }); await i.guild.members.unban(t.id, `Fin du softban par ${i.user.tag}`); }
  if (action === 'kick') await t.kick(`${reason} | Par ${i.user.tag}`);
  if (action === 'timeout') { const min = Number(i.fields.getTextInputValue('minutes')); if (!Number.isInteger(min) || min < 1 || min > 40320) throw new Error('Durée invalide (1 à 40320 minutes).'); await t.timeout(min * 60_000, `${reason} | Par ${i.user.tag}`); }
  if (action === 'warn') data(i.guild.id, t.id).warns.push({ reason, by: i.user.tag, at: Date.now() });
  if (action === 'unwarn') { const w = data(i.guild.id, t.id).warns; if (!w.length) throw new Error('Aucun warn à retirer.'); w.pop(); }
  await saveMemberState(i.guild.id, t.id);
  await sendLog(i.guild, new EmbedBuilder().setTitle(`🛡️ ${action.toUpperCase()}`).setDescription(`Cible : ${t.user.tag}\nModérateur : ${i.user.tag}\nRaison : ${reason || 'Non précisée'}`));
  return i.reply({ content: `${config.emojis.success} Action **${action}** appliquée à ${t.user.tag}.`, ephemeral: true });
}
async function handleAdvancedModal(i, action, targetId) {
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const target = await i.guild.members.fetch(targetId);
  if (target.id === i.user.id || target.id === i.guild.ownerId || target.roles.highest.position >= i.member.roles.highest.position) throw new Error('Vous ne pouvez pas modérer ce membre (hiérarchie Discord).');
  const reason = i.fields.getTextInputValue('reason').trim() || 'Non précisée';
  if (action === 'nickname') { await target.setNickname(i.fields.getTextInputValue('nickname').trim() || null, `${reason} | Par ${i.user.tag}`); }
  if (action === 'voicemove') { const channel = i.guild.channels.cache.get(i.fields.getTextInputValue('channel').trim()); if (channel?.type !== ChannelType.GuildVoice) throw new Error('ID de salon vocal invalide.'); if (!target.voice.channel) throw new Error('Ce membre n’est pas en vocal.'); await target.voice.setChannel(channel, `${reason} | Par ${i.user.tag}`); }
  await sendLog(i.guild, new EmbedBuilder().setTitle(`🛡️ ${action}`).setDescription(`Cible : ${target}\nModérateur : ${i.user}\nRaison : ${reason}`));
  return i.reply({ content: `${config.emojis.success} Action appliquée à ${target}.`, ephemeral: true });
}
async function moveMemberToVoice(i, memberId, channelId) {
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const target = await i.guild.members.fetch(memberId), channel = i.guild.channels.cache.get(channelId);
  if (!target.voice.channel || channel?.type !== ChannelType.GuildVoice) throw new Error('Membre ou salon vocal invalide.');
  if (target.roles.highest.position >= i.member.roles.highest.position) throw new Error('Hiérarchie Discord insuffisante.');
  await target.voice.setChannel(channel, `Déplacement par ${i.user.tag}`);
  await sendLog(i.guild, new EmbedBuilder().setTitle('🔊 Déplacement vocal').setDescription(`${target} déplacé vers ${channel} par ${i.user}.`));
  return i.update({ embeds: [new EmbedBuilder().setColor(color).setDescription(`${config.emojis.success} ${target} a été déplacé vers ${channel}.`)], components: [back(i, 'mod')] });
}
async function handleSettingModal(i, action) {
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const s = server(i.guild), value = id => i.fields.getTextInputValue(id).trim();
  const validChannel = (id, kind) => !id || (i.guild.channels.cache.get(id) && (!kind || i.guild.channels.cache.get(id).type === kind));
  if (action === 'welcome') {
    const channel = value('channel'); if (!validChannel(channel) || (channel && !i.guild.channels.cache.get(channel).isTextBased())) throw new Error('ID de salon texte invalide.');
    s.welcome = { enabled: ['oui', 'yes', 'on', 'true'].includes(value('enabled').toLowerCase()), channelId: channel, message: value('welcome'), goodbye: value('goodbye') };
    await saveServerState(i.guild);
    return i.reply({ content: `${config.emojis.success} Messages d’accueil enregistrés.`, ephemeral: true });
  }
  if (action === 'logs') { const channel = value('channel'); if (!validChannel(channel) || (channel && !i.guild.channels.cache.get(channel).isTextBased())) throw new Error('ID de salon texte invalide.'); s.logsChannelId = channel; await saveServerState(i.guild); return i.reply({ content: `${config.emojis.success} Salon de logs ${channel ? 'enregistré' : 'désactivé'}.`, ephemeral: true }); }
  if (action === 'logevents') { const allowed = ['messages', 'moderation', 'server', 'members']; s.logEvents = value('events').split(',').map(x => x.trim().toLowerCase()).filter(x => allowed.includes(x)); await saveServerState(i.guild); return i.reply({ content: `${config.emojis.success} Catégories de logs enregistrées.`, ephemeral: true }); }
  if (action === 'words') { s.blockedWords = value('words').split(',').map(x => x.trim()).filter(Boolean).slice(0, 50); await saveServerState(i.guild); return i.reply({ content: `${config.emojis.success} ${s.blockedWords.length} mot(s) interdit(s) enregistré(s).`, ephemeral: true }); }
  if (action === 'automod') { const yes = id => ['oui', 'yes', 'on', 'true'].includes(value(id).toLowerCase()); s.antiSpam = yes('spam'); s.antiLinks = yes('links'); s.antiMentions = yes('mentions'); s.antiCaps = yes('caps'); s.antiEmoji = yes('emoji'); await saveServerState(i.guild); return i.reply({ content: `${config.emojis.success} AutoMod configuré.`, ephemeral: true }); }
  if (action === 'roles') {
    const auto = value('autorole'), self = value('selfroles').split(',').map(x => x.trim()).filter(Boolean).slice(0, 25);
    if ((auto && !i.guild.roles.cache.has(auto)) || self.some(id => !i.guild.roles.cache.has(id))) throw new Error('Un ID de rôle est invalide.');
    s.autoRoleId = auto; s.selfRoleIds = self; await saveServerState(i.guild);
    if (self.length && i.channel?.isTextBased()) await i.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle('🎭 Rôles').setDescription('Choisissez vos rôles ci-dessous.')], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`helpy:selfroles:${i.guild.id}`).setPlaceholder('Ajouter ou retirer un rôle').setMinValues(0).setMaxValues(Math.min(self.length, 25)).addOptions(self.map(id => ({ label: i.guild.roles.cache.get(id).name, value: id }))))] });
    return i.reply({ content: `${config.emojis.success} Rôles configurés${self.length ? ' et panneau publié' : ''}.`, ephemeral: true });
  }
  if (action === 'voice') { const hub = value('hub'), category = value('category'); if ((hub && i.guild.channels.cache.get(hub)?.type !== ChannelType.GuildVoice) || (category && i.guild.channels.cache.get(category)?.type !== ChannelType.GuildCategory)) throw new Error('IDs de vocal ou catégorie invalides.'); s.tempVoiceHubId = hub; s.tempVoiceCategoryId = category; await saveServerState(i.guild); return i.reply({ content: `${config.emojis.success} Vocaux temporaires configurés.`, ephemeral: true }); }
  if (action === 'tickets') { const category = value('category'); if (category && i.guild.channels.cache.get(category)?.type !== ChannelType.GuildCategory) throw new Error('ID de catégorie invalide.'); s.ticketCategoryId = category; await saveServerState(i.guild); await i.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle('🎫 Support Helpy').setDescription(value('text'))], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`helpy:ticket:${i.guild.id}`).setLabel('Ouvrir un ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary))] }); return i.reply({ content: `${config.emojis.success} Panneau de tickets publié.`, ephemeral: true }); }
  if (action === 'giveaway') {
    const seconds = Number(value('seconds')); if (!Number.isInteger(seconds) || seconds < 10 || seconds > 604800) throw new Error('Durée invalide (10 à 604800 secondes).');
    const msg = await i.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle('🎉 GIVEAWAY').setDescription(`Prix : **${value('prize')}**\nSe termine <t:${Math.floor((Date.now() + seconds * 1000) / 1000)}:R>\nClique pour participer.`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`helpy:giveaway:${i.guild.id}`).setLabel('Participer').setEmoji('🎉').setStyle(ButtonStyle.Success))] });
    giveaways.set(msg.id, { users: new Set(), prize: value('prize'), guild: i.guild, channel: i.channel }); setTimeout(() => finishGiveaway(msg.id), seconds * 1000);
    return i.reply({ content: `${config.emojis.success} Giveaway créé.`, ephemeral: true });
  }
  if (action === 'poll') { const options = value('options').split('|').map(x => x.trim()).filter(Boolean); if (options.length < 2 || options.length > 5) throw new Error('Entrez entre 2 et 5 options séparées par |.'); const pollId = `${Date.now()}`; await i.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle('📊 Sondage').setDescription(value('question'))], components: options.map((o, n) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`helpy:poll:${pollId}:${n}`).setLabel(truncate(o, 80)).setStyle(ButtonStyle.Secondary))) }); return i.reply({ content: `${config.emojis.success} Sondage publié.`, ephemeral: true }); }
  if (action === 'announcement') { await i.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(value('title')).setDescription(value('text')).setFooter({ text: config.botName }).setTimestamp()], allowedMentions: { parse: [] } }); return i.reply({ content: `${config.emojis.success} Annonce publiée.`, ephemeral: true }); }
}
async function toggleRole(i, memberId, roleId) {
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const target = await i.guild.members.fetch(memberId), role = await i.guild.roles.fetch(roleId);
  if (!role || !role.editable || target.roles.highest.position >= i.member.roles.highest.position) throw new Error('Ce rôle ou ce membre ne peut pas être modifié (hiérarchie Discord).');
  const hasRole = target.roles.cache.has(role.id);
  await target.roles[hasRole ? 'remove' : 'add'](role, `Rôle modifié par ${i.user.tag}`);
  return i.update({ content: `${config.emojis.success} Rôle **${role.name}** ${hasRole ? 'retiré de' : 'ajouté à'} ${target.user.tag}.`, components: [] });
}
async function handleCreatorModal(i, action) {
  if (!isCreator(i)) throw new Error('Permission Creator requise.');
  if (action === 'say') {
    const message = i.fields.getTextInputValue('message').trim();
    await i.channel.send({ content: truncate(message, 2000), allowedMentions: { parse: [] } });
    return i.reply({ content: `${config.emojis.success} Message envoyé.`, ephemeral: true });
  }
  if (action === 'update') {
    const title = i.fields.getTextInputValue('title').trim(), message = i.fields.getTextInputValue('message').trim();
    await i.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(truncate(title, 256)).setDescription(truncate(message, 4096)).setFooter({ text: `${config.botName} • Mise à jour` }).setTimestamp()], allowedMentions: { parse: [] } });
    return i.reply({ content: `${config.emojis.success} Mise à jour publiée.`, ephemeral: true });
  }
  const confirmation = i.fields.getTextInputValue('confirm').trim();
  if (confirmation !== 'BANNIR TOUS') throw new Error('Confirmation incorrecte : aucune action n’a été effectuée.');
  const reason = i.fields.getTextInputValue('reason').trim();
  await i.deferReply({ ephemeral: true });
  const candidates = i.guild.members.cache.filter(m => !m.user.bot && m.id !== i.user.id && m.id !== i.guild.ownerId && m.bannable);
  let count = 0;
  for (const member of candidates.values()) {
    try { await member.ban({ reason: `${reason} | Ban All par Creator ${i.user.tag}` }); count++; }
    catch (error) { console.warn(`Ban All ignoré pour ${member.id}: ${error.message}`); }
  }
  return i.editReply(`${config.emojis.warning} Ban All terminé : ${count} membre(s) banni(s). Les membres protégés/non-bannables ont été ignorés.`);
}
async function handleHelpyInteraction(i) {
  if (!i.inGuild()) return;
  const [, action, ...args] = i.customId.split(':');
  if (action === 'selfroles' && i.isStringSelectMenu()) {
    const s = server(i.guild), selected = new Set(i.values), mine = i.member.roles.cache;
    for (const id of s.selfRoleIds) {
      const role = i.guild.roles.cache.get(id); if (!role?.editable) continue;
      if (selected.has(id) && !mine.has(id)) await i.member.roles.add(role, 'Rôle libre-service Helpy').catch(() => {});
      if (!selected.has(id) && mine.has(id)) await i.member.roles.remove(role, 'Rôle libre-service Helpy').catch(() => {});
    }
    return i.reply({ content: `${config.emojis.success} Vos rôles ont été mis à jour.`, ephemeral: true });
  }
  if (action === 'ticket' && i.isButton()) {
    const s = server(i.guild), existing = i.guild.channels.cache.find(c => c.topic === `helpy-ticket:${i.user.id}`);
    if (existing) return i.reply({ content: `Vous avez déjà un ticket ouvert : ${existing}`, ephemeral: true });
    const channel = await i.guild.channels.create({ name: `ticket-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90) || `ticket-${i.user.id}`, type: ChannelType.GuildText, parent: s.ticketCategoryId || undefined, topic: `helpy-ticket:${i.user.id}`, permissionOverwrites: [{ id: i.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] });
    await channel.send({ content: `${i.user}`, embeds: [new EmbedBuilder().setColor(color).setTitle('🎫 Ticket ouvert').setDescription('Décrivez votre demande. Un membre de l’équipe vous répondra.')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('helpy:closeTicket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger))] });
    await sendLog(i.guild, new EmbedBuilder().setTitle('🎫 Ticket ouvert').setDescription(`${i.user} a ouvert ${channel}.`));
    return i.reply({ content: `${config.emojis.success} Ticket créé : ${channel}`, ephemeral: true });
  }
  if (action === 'closeTicket' && i.isButton()) {
    if (!i.channel?.topic?.startsWith('helpy-ticket:') || !(canModerate(i) || i.channel.topic === `helpy-ticket:${i.user.id}`)) return i.reply({ content: 'Vous ne pouvez pas fermer ce ticket.', ephemeral: true });
    await i.reply({ content: 'Ticket fermé dans 5 secondes.' });
    return setTimeout(() => i.channel.delete('Ticket fermé avec Helpy').catch(() => {}), 5000);
  }
  if (action === 'giveaway' && i.isButton()) {
    const giveaway = giveaways.get(i.message.id); if (!giveaway) return i.reply({ content: 'Ce giveaway est terminé ou a redémarré.', ephemeral: true });
    if (giveaway.users.has(i.user.id)) { giveaway.users.delete(i.user.id); return i.reply({ content: 'Participation retirée.', ephemeral: true }); }
    giveaway.users.add(i.user.id); return i.reply({ content: `${config.emojis.success} Vous participez au giveaway !`, ephemeral: true });
  }
  if (action === 'poll' && i.isButton()) return i.reply({ content: `${config.emojis.success} Votre vote a été enregistré : **${i.component.label}**.`, ephemeral: true });
}
async function finishGiveaway(messageId) {
  const giveaway = giveaways.get(messageId); if (!giveaway) return;
  giveaways.delete(messageId);
  const winnerId = [...giveaway.users][Math.floor(Math.random() * giveaway.users.size)];
  await giveaway.channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle('🎉 Giveaway terminé').setDescription(winnerId ? `Prix : **${giveaway.prize}**\nGagnant : <@${winnerId}>` : `Prix : **${giveaway.prize}**\nAucun participant.`)] }).catch(() => {});
}
async function creatorAction(i, action) {
  if (!isCreator(i)) throw new Error('Permission Creator requise.');
  if (action === 'say') return i.showModal(modal(`dash:${i.user.id}:modal:say:0`, 'Faire parler le bot', [{ id: 'message', label: 'Message', style: TextInputStyle.Paragraph }]));
  if (action === 'update') return i.showModal(modal(`dash:${i.user.id}:modal:update:0`, 'Publier une mise à jour', [{ id: 'title', label: 'Titre' }, { id: 'message', label: 'Contenu', style: TextInputStyle.Paragraph }]));
  if (action === 'reconnect') { await i.reply({ content: 'Reconnectage demandé.', ephemeral: true }); client.destroy(); return client.login(process.env.DISCORD_TOKEN); }
  if (action === 'banall') return i.showModal(modal(`dash:${i.user.id}:modal:banall:0`, 'Confirmation Ban All', [{ id: 'confirm', label: 'Tapez exactement : BANNIR TOUS', placeholder: 'BANNIR TOUS' }, { id: 'reason', label: 'Raison', style: TextInputStyle.Paragraph }]));
}
client.login(process.env.DISCORD_TOKEN);
