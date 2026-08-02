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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildPresences],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User]
});
const command = new SlashCommandBuilder().setName('dashboard').setDescription('Ouvrir le dashboard Corex').toJSON();
const stats = new Map(); // guildId:userId -> données de session ; une base de données est nécessaire pour les conserver après redémarrage.
const locks = new Map(); // guildId:channelId -> anciennes permissions
const color = config.color;
const key = (g, u) => `${g}:${u}`;
const data = (g, u) => { const k = key(g, u); if (!stats.has(k)) stats.set(k, { messages: 0, warns: [] }); return stats.get(k); };
const isCreator = i => i.user.id === config.creatorId;
const isAdmin = i => i.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
const canModerate = i => isAdmin(i) || isCreator(i);
const stamp = d => `<t:${Math.floor(d.getTime() / 1000)}:F>`;
const truncate = (s, n = 1000) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

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
  if (admin) options.push({ label: 'Modération', value: 'mod', emoji: config.emojis.moderation, default: page === 'mod' });
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
      { name: 'Activité (session)', value: `Messages : ${s.messages}\nStatut : ${member.presence?.status || 'hors ligne'}\nActivité : ${truncate(activity, 90)}`, inline: true },
      { name: 'Sanctions (session)', value: `Warns : ${s.warns.length}\nTotal : ${s.warns.length}${member.communicationDisabledUntilTimestamp > Date.now() ? '\nTimeout actif' : ''}`, inline: true },
      { name: `Rôles (${Math.max(0, member.roles.cache.size - 1)})`, value: truncate(member.roles.cache.filter(r => r.id !== guild.id).map(r => r.toString()).join(' ') || 'Aucun', 1024) },
      { name: 'Permissions importantes', value: important.join(', ') || 'Aucune' }
    ).setFooter({ text: 'Les statistiques marquées « session » sont réinitialisées au redémarrage.' }).setTimestamp();
}
function targetMenu(interaction, action = 'profile') {
  const members = interaction.guild.members.cache.filter(m => !m.user.bot).first(25);
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash:${interaction.user.id}:target:${action}`).setPlaceholder('Choisir un membre').addOptions(members.map(m => ({ label: truncate(m.user.tag, 100), value: m.id, description: truncate(m.displayName, 100) }))));
}
function modEmbed() { return new EmbedBuilder().setColor(color).setTitle('🛡️ Modération').setDescription('Choisissez d’abord un membre, puis sélectionnez une action. Les actions sont vérifiées à chaque clic.').addFields({ name: 'Outils', value: 'Ban · Kick · Timeout · Unmute · Warn · Unwarn · Sanctions · Rôles\nClear · Lock/Unlock · Slowmode' }); }
function creatorEmbed() { return new EmbedBuilder().setColor(color).setTitle('👑 Creator').setDescription('Outils réservés au propriétaire du bot. Les actions destructrices exigent une confirmation.').addFields({ name: 'Fonctions', value: 'Say · Update · Ban All (confirmation) · Reconnecter le bot' }); }
function settingsEmbed() { return new EmbedBuilder().setColor(color).setTitle('⚙️ Paramètres du serveur').setDescription(`Paramètres globaux configurés dans \`config.js\`.\nTimeout par défaut : **${config.defaults.timeoutMinutes} min**\nSlowmode par défaut : **${config.defaults.slowmodeSeconds} s**\nClear par défaut : **${config.defaults.clearLimit} messages**`); }
function modal(id, title, fields) { const m = new ModalBuilder().setCustomId(id).setTitle(title); fields.forEach(f => m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(f.style || TextInputStyle.Short).setRequired(f.required !== false).setPlaceholder(f.placeholder || '').setValue(f.value || '')))); return m; }
function owned(interaction) { const p = interaction.customId.split(':'); return p[0] === 'dash' && p[1] === interaction.user.id; }
async function safeReply(interaction, payload) { return interaction.replied || interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload); }

client.once('ready', async () => {
  console.log(`${config.botName} connecté en tant que ${client.user.tag}`);
  try { await client.application.commands.set([command]); console.log('Commande /dashboard enregistrée.'); } catch (e) { console.error('Impossible d’enregistrer la commande :', e.message); }
});
client.on('messageCreate', message => { if (!message.author.bot && message.guild) data(message.guild.id, message.author.id).messages++; });
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'dashboard') {
      if (!interaction.inGuild()) return interaction.reply({ content: 'Cette commande est disponible uniquement sur un serveur.', ephemeral: true });
      return interaction.reply({ embeds: [homeEmbed(interaction.guild, interaction)], components: nav(interaction), ephemeral: true });
    }
    if (!interaction.customId?.startsWith('dash:') || !owned(interaction)) return;
    if (!interaction.inGuild()) return interaction.reply({ content: 'Action disponible uniquement sur un serveur.', ephemeral: true });
    const [, , type, ...args] = interaction.customId.split(':');
    if (type === 'nav' && interaction.isStringSelectMenu()) return renderPage(interaction, interaction.values[0]);
    if (type === 'page') return renderPage(interaction, args[0]);
    if (type === 'target' && interaction.isStringSelectMenu()) {
      if (args[0] === 'role') return toggleRole(interaction, args[1], interaction.values[0]);
      return showTarget(interaction, args[0], interaction.values[0]);
    }
    if (type === 'action') return runAction(interaction, args[0], args[1]);
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
  if (page === 'profile') return i.update({ embeds: [memberEmbed(i.guild, i.member)], components: [...nav(i, page), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dash:${i.user.id}:page:members`).setLabel('Voir un autre profil').setStyle(ButtonStyle.Primary))] });
  if (page === 'members') return i.update({ embeds: [new EmbedBuilder().setColor(color).setTitle('👥 Membres').setDescription('Sélectionnez un membre pour consulter son profil.')], components: [...nav(i, page), targetMenu(i, 'profile')] });
  if (page === 'mod') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [modEmbed()], components: [...nav(i, page), targetMenu(i, 'mod')] }); }
  if (page === 'creator') { if (!isCreator(i)) throw new Error('Permission Creator requise.'); return i.update({ embeds: [creatorEmbed()], components: [...nav(i, page), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dash:${i.user.id}:creator:say`).setLabel('Say').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`dash:${i.user.id}:creator:update`).setLabel('Update').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`dash:${i.user.id}:creator:banall`).setLabel('Ban All').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`dash:${i.user.id}:creator:reconnect`).setLabel('Reconnecter').setStyle(ButtonStyle.Secondary))] }); }
  if (page === 'settings') { if (!canModerate(i)) throw new Error('Permission Administrateur requise.'); return i.update({ embeds: [settingsEmbed()], components: nav(i, page) }); }
}
async function showTarget(i, mode, id) {
  const m = await i.guild.members.fetch(id);
  if (mode === 'profile') return i.update({ embeds: [memberEmbed(i.guild, m)], components: [...nav(i, 'members'), back(i, 'members')] });
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const actions = [['ban','Ban',ButtonStyle.Danger],['kick','Kick',ButtonStyle.Danger],['timeout','Timeout',ButtonStyle.Secondary],['unmute','Unmute',ButtonStyle.Secondary],['warn','Warn',ButtonStyle.Secondary],['unwarn','Unwarn',ButtonStyle.Secondary],['sanctions','Sanctions',ButtonStyle.Primary],['roles','Rôles',ButtonStyle.Primary]];
  const row1 = new ActionRowBuilder().addComponents(actions.slice(0, 4).map(([a,l,s]) => new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:${a}:${id}`).setLabel(l).setStyle(s)));
  const row2 = new ActionRowBuilder().addComponents(actions.slice(4).map(([a,l,s]) => new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:${a}:${id}`).setLabel(l).setStyle(s)));
  return i.update({ embeds: [memberEmbed(i.guild, m), new EmbedBuilder().setColor(color).setDescription(`Actions de modération pour ${m}.`)], components: [...nav(i, 'mod'), row1, row2, new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:clear:0`).setLabel('Clear salon').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:lock:0`).setLabel('Lock salon').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:unlock:0`).setLabel('Unlock salon').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`dash:${i.user.id}:action:slowmode:0`).setLabel('Slowmode').setStyle(ButtonStyle.Primary))] });
}
async function runAction(i, action, targetId) {
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const target = targetId !== '0' ? await i.guild.members.fetch(targetId) : null;
  if (['ban','kick','timeout','warn','unwarn'].includes(action)) return i.showModal(modal(`dash:${i.user.id}:modal:${action}:${targetId}`, `${action.toUpperCase()} — ${target.user.tag}`, [{ id: 'reason', label: 'Raison', style: TextInputStyle.Paragraph, placeholder: 'Raison de la sanction' }, ...(action === 'timeout' ? [{ id: 'minutes', label: 'Durée (minutes, max 40320)', placeholder: String(config.defaults.timeoutMinutes) }] : [])]));
  if (action === 'clear') return i.showModal(modal(`dash:${i.user.id}:modal:clear:0`, 'Supprimer des messages', [{ id: 'amount', label: 'Nombre (1 à 100)', placeholder: String(config.defaults.clearLimit) }]));
  if (action === 'slowmode') return i.showModal(modal(`dash:${i.user.id}:modal:slowmode:0`, 'Configurer le slowmode', [{ id: 'seconds', label: 'Secondes (0 à 21600)', placeholder: String(config.defaults.slowmodeSeconds) }]));
  if (action === 'unmute') { await target.timeout(null, `Unmute par ${i.user.tag}`); return i.reply({ content: `${config.emojis.success} Timeout retiré pour ${target}.`, ephemeral: true }); }
  if (action === 'sanctions') { const w = data(i.guild.id, target.id).warns; return i.reply({ embeds: [new EmbedBuilder().setColor(color).setTitle(`Sanctions — ${target.user.tag}`).setDescription(w.length ? w.map((x,n) => `**${n + 1}.** ${x.reason}\nPar ${x.by} · ${stamp(new Date(x.at))}`).join('\n') : 'Aucune sanction en mémoire.')], ephemeral: true }); }
  if (action === 'roles') { const roles = i.guild.roles.cache.filter(r => r.editable && r.id !== i.guild.id).sort((a,b) => b.position - a.position).first(25); return i.reply({ content: 'Sélectionnez un rôle :', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`dash:${i.user.id}:target:role:${targetId}`).setPlaceholder('Ajouter ou retirer un rôle').addOptions(roles.map(r => ({ label: r.name, value: r.id }))))], ephemeral: true }); }
  if (action === 'lock' || action === 'unlock') { if (!i.channel?.isTextBased()) throw new Error('Salon texte requis.'); const everyone = i.guild.roles.everyone; if (action === 'lock') { locks.set(`${i.guild.id}:${i.channel.id}`, i.channel.permissionOverwrites.cache.get(everyone.id)?.allow?.bitfield?.toString() || ''); await i.channel.permissionOverwrites.edit(everyone, { SendMessages: false }, `Lock par ${i.user.tag}`); } else await i.channel.permissionOverwrites.edit(everyone, { SendMessages: null }, `Unlock par ${i.user.tag}`); return i.reply({ content: `${config.emojis.success} Salon ${action === 'lock' ? 'verrouillé' : 'déverrouillé'}.`, ephemeral: true }); }
}
async function handleModal(i, action, targetId) {
  if (['say', 'update', 'banall'].includes(action)) return handleCreatorModal(i, action);
  if (!canModerate(i)) throw new Error('Permission Administrateur requise.');
  const reason = i.fields.fields.has('reason') ? i.fields.getTextInputValue('reason').trim() : '';
  if (action === 'clear') { const n = Number(i.fields.getTextInputValue('amount')); if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('Entrez un nombre entre 1 et 100.'); const deleted = await i.channel.bulkDelete(n, true); return i.reply({ content: `${config.emojis.success} ${deleted.size} message(s) supprimé(s).`, ephemeral: true }); }
  if (action === 'slowmode') { const n = Number(i.fields.getTextInputValue('seconds')); if (!Number.isInteger(n) || n < 0 || n > 21600) throw new Error('Entrez un nombre entre 0 et 21600.'); await i.channel.setRateLimitPerUser(n, `Slowmode par ${i.user.tag}`); return i.reply({ content: `${config.emojis.success} Slowmode réglé sur ${n}s.`, ephemeral: true }); }
  const t = await i.guild.members.fetch(targetId);
  if (t.id === i.user.id || t.id === i.guild.ownerId || t.roles.highest.position >= i.member.roles.highest.position) throw new Error('Vous ne pouvez pas modérer ce membre (hiérarchie Discord).');
  if (action === 'ban') await t.ban({ reason: `${reason} | Par ${i.user.tag}` });
  if (action === 'kick') await t.kick(`${reason} | Par ${i.user.tag}`);
  if (action === 'timeout') { const min = Number(i.fields.getTextInputValue('minutes')); if (!Number.isInteger(min) || min < 1 || min > 40320) throw new Error('Durée invalide (1 à 40320 minutes).'); await t.timeout(min * 60_000, `${reason} | Par ${i.user.tag}`); }
  if (action === 'warn') data(i.guild.id, t.id).warns.push({ reason, by: i.user.tag, at: Date.now() });
  if (action === 'unwarn') { const w = data(i.guild.id, t.id).warns; if (!w.length) throw new Error('Aucun warn à retirer.'); w.pop(); }
  return i.reply({ content: `${config.emojis.success} Action **${action}** appliquée à ${t.user.tag}.`, ephemeral: true });
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
async function creatorAction(i, action) {
  if (!isCreator(i)) throw new Error('Permission Creator requise.');
  if (action === 'say') return i.showModal(modal(`dash:${i.user.id}:modal:say:0`, 'Faire parler le bot', [{ id: 'message', label: 'Message', style: TextInputStyle.Paragraph }]));
  if (action === 'update') return i.showModal(modal(`dash:${i.user.id}:modal:update:0`, 'Publier une mise à jour', [{ id: 'title', label: 'Titre' }, { id: 'message', label: 'Contenu', style: TextInputStyle.Paragraph }]));
  if (action === 'reconnect') { await i.reply({ content: 'Reconnectage demandé.', ephemeral: true }); client.destroy(); return client.login(process.env.DISCORD_TOKEN); }
  if (action === 'banall') return i.showModal(modal(`dash:${i.user.id}:modal:banall:0`, 'Confirmation Ban All', [{ id: 'confirm', label: 'Tapez exactement : BANNIR TOUS', placeholder: 'BANNIR TOUS' }, { id: 'reason', label: 'Raison', style: TextInputStyle.Paragraph }]));
}
client.login(process.env.DISCORD_TOKEN);
