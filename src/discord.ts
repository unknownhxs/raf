// discord.ts
// Gestion du bot Discord et des commandes
import type { APIEmbed } from "discord.js";
import {
  Client,
  ChatInputCommandInteraction,
  Guild,
  Interaction,
  InteractionType,
  ButtonInteraction,
  TextChannel,
  GatewayIntentBits,
  MessageFlags,
  User,
  GuildMember,
  Partials,
  ChannelType,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { ActionRowBuilder, ButtonBuilder, SlashCommandBuilder } from "@discordjs/builders";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import dotenv from "dotenv";
import os from "os";
import { chatWithOllama, activeModel, history, setActiveModel, clearHistory, appendUserContext, AllowedAction } from "./ai";
import logger from "./logger";
import { upsertUser } from "./database";
import { isValidUrl } from "./utils";

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token) {
  throw new Error("DISCORD_TOKEN is missing; add it to your .env file.");
}

const botToken = token;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.DirectMessageReactions], partials: [Partials.Channel, Partials.Message] });

let isActive = true;
const channelStopMessage = new Map<string, { msgId: string; buttonId: string }>();
const activeChannels = new Set<string>();
const activeDMs = new Set<string>();

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Replies with pong!"),
  new SlashCommandBuilder()
    .setName("modele")
    .setDescription("Choisir le modèle Ollama ou afficher le modèle actif")
    .addStringOption((opt) =>
      opt
        .setName("nom")
        .setDescription("Nom du modèle (ex: llama3.1)")
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("reset")
        .setDescription("Réinitialiser l'historique de conversation")
    ),
  new SlashCommandBuilder()
    .setName("talk")
    .setDescription("Parler avec l'IA et laisser agir le bot (Raphaël)")
    .addChannelOption((opt) =>
      opt
        .setName("salon")
        .setDescription("Salon où Raphaël répondra")
        .addChannelTypes(ChannelType.GuildText)
    ),
  new SlashCommandBuilder()
    .setName("messbasse")
    .setDescription("Conversation privée avec Raphaël (éphémère)")
    .addStringOption((opt) =>
      opt
        .setName("prompt")
        .setDescription("Ce que tu veux dire à Raphaël")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Arrêter Raphaël pour un salon (comme le bouton Stop)")
    .addChannelOption((opt) =>
      opt
        .setName("salon")
        .setDescription("Salon où Raphaël doit s'arrêter")
        .addChannelTypes(ChannelType.GuildText)
    ),
  new SlashCommandBuilder()
    .setName("dm")
    .setDescription("Lancer une conversation DM avec Raphaël")
].map((command) => command.toJSON());



interface ExtractedLink {
  label: string;
  url: string;
}

function extractLinks(text: string): { cleanText: string; links: ExtractedLink[] } {
  const links: ExtractedLink[] = [];
  let cleanText = text;
  
  // Extrait les liens markdown [label](url)
  const mdLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = mdLinkRegex.exec(text)) !== null) {
    const label = match[1].slice(0, 80); // Discord limite à 80 caractères
    const url = match[2];
    if (isValidUrl(url)) {
      links.push({ label, url });
    }
  }
  cleanText = cleanText.replace(mdLinkRegex, "");
  
  // Extrait les URLs brutes
  const urlRegex = /(?<!\()https?:\/\/[^\s\)\]]+/g;
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0];
    if (isValidUrl(url) && !links.some(l => l.url === url)) {
      // Crée un label à partir du domaine
      try {
        const domain = new URL(url).hostname.replace("www.", "");
        links.push({ label: domain.slice(0, 80), url });
      } catch {
        links.push({ label: "Lien", url });
      }
    }
  }
  cleanText = cleanText.replace(urlRegex, "");
  
  // Nettoie les espaces multiples et les crochets vides
  cleanText = cleanText
    .replace(/\[\s*\]\s*\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*\]\s*/g, " ")
    .trim();
  
  // Limite à 5 boutons (limite Discord par row)
  return { cleanText, links: links.slice(0, 5) };
}

function buildLinkButtons(links: ExtractedLink[]): ActionRowBuilder<ButtonBuilder> | null {
  if (links.length === 0) return null;
  
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const link of links) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel(link.label)
        .setStyle(ButtonStyle.Link)
        .setURL(link.url)
    );
  }
  return row;
}

function formatDuration(seconds: number): string {
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function buildEmbed(action: AllowedAction & { type: "embed_reply" }): APIEmbed {
  // Convertit les \n littéraux en vraies nouvelles lignes
  const processText = (text: string) =>
    text
      .replace(/\\n/g, "\n")
      .replace(/<:([a-zA-Z0-9_]+):(\d+)>/g, "<:$1:$2>"); // Corrige emoji avec ] final
  
  const embed: APIEmbed = {
    description: processText(action.description).slice(0, 4000),
    color: 0x5865f2
  };
  
  // N'ajoute les champs que s'ils ne sont pas "_"
  if (action.title && action.title !== "_") {
    embed.title = action.title.slice(0, 250);
  }
  if (action.footer && action.footer !== "_") {
    embed.footer = { text: processText(action.footer).slice(0, 2048) };
  }
  if (action.image && action.image !== "_" && isValidUrl(action.image)) {
    embed.image = { url: action.image };
  }
  if (action.thumbnail && action.thumbnail !== "_" && isValidUrl(action.thumbnail)) {
    embed.thumbnail = { url: action.thumbnail };
  }
  if (action.author && action.author !== "_") {
    embed.author = { name: action.author.slice(0, 256) };
  }
  if (action.url && action.url !== "_" && isValidUrl(action.url)) {
    embed.url = action.url;
  }
  return embed;
}

// Lance l'indicateur "écriture" jusqu'à arrêt explicite
function startTyping(channel: { sendTyping?: () => Promise<void> }): () => void {
  let active = true;
  const send = () => {
    if (!active || !channel?.sendTyping) return;
    channel.sendTyping().catch(() => undefined);
  };
  send();
  const timer = setInterval(send, 7000);
  return () => {
    active = false;
    clearInterval(timer);
  };
}

async function performAction(action: AllowedAction, interaction: { guild: Guild | null }): Promise<string[]> {
  const notes: string[] = [];
  const guild = interaction.guild;

  try {
    switch (action.type) {
      case "change_nick": {
        if (!guild) {
          notes.push("Changement de pseudo impossible hors serveur.");
          break;
        }
        try {
          const member = await guild.members.fetch(action.userId);
          if (member && member.manageable) {
            await member.setNickname(action.nickname);
            notes.push(`Pseudo de ${member.user.tag} mis à jour: ${action.nickname}`);
          } else {
            notes.push("Impossible de modifier ce membre (permissions/hiérarchie).");
          }
        } catch (error) {
          notes.push("Échec du changement de pseudo (permissions ?).");
          logger.error("change_nick failed", error);
        }
        break;
      }
      case "embed_reply": {
        // Handled at reply time; nothing to do here.
        break;
      }
    }
  } catch (error) {
    logger.error("performAction error:", error);
    notes.push("Une erreur est survenue lors de l'exécution de l'action.");
  }

  return notes;
}

async function registerCommands(): Promise<void> {
  if (!clientId) {
    logger.warn("Skipping command registration: DISCORD_CLIENT_ID not set.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(botToken);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("Slash commands registered globally.");
}

client.once("clientReady", () => {
  logger.info(`Logged in as ${client.user?.tag ?? "unknown user"}`);
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (interaction.type === InteractionType.MessageComponent && interaction.isButton()) {
    const button = interaction as ButtonInteraction;
    if (!button.customId.startsWith("raphael-stop-")) return;

    const parts = button.customId.split("-");
    const channelId = parts[2];
    const message = button.message;

    activeChannels.delete(channelId);
    channelStopMessage.delete(channelId);

    try {
      await message.edit({ components: [] });
    } catch (error) {
      logger.warn("Failed to disable stop button", error);
    }

    // Avertit le salon que Raphaël se retire de ce canal
    try {
      const redEmbed: APIEmbed = {
        title: "Raphaël ignore maitenant ce salon",
        color: 0xe74c3c
      };
      await (message.channel as TextChannel).send({ embeds: [redEmbed] });
    } catch (error) {
      logger.warn("Failed to send leave embed", error);
    }

    await button.reply({ content: "Raphaël ignore désormais ce salon.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    const start = Date.now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const heartbeat = Math.round(client.ws.ping);
    const apiLatency = Date.now() - interaction.createdTimestamp;
    const uptime = formatDuration(process.uptime());
    const mem = process.memoryUsage();
    const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
    const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const totalMem = os.totalmem();
    const usedMemPercent = totalMem ? (((totalMem - os.freemem()) / totalMem) * 100).toFixed(1) : "n/a";

    const embed: APIEmbed = {
      title: "Monitoring",
      color: 0x2ecc71,
      fields: [
        { name: "Latences", value: `WS: ${heartbeat} ms\nAPI: ${apiLatency} ms`, inline: true },
        { name: "Process", value: `Uptime: ${uptime}\nRSS: ${rssMb} MB\nHeap: ${heapMb} MB`, inline: true },
        { name: "Système", value: `RAM utilisée: ${usedMemPercent}%\nNode: ${process.version}`, inline: true }
      ],
      footer: { text: `Total: ${Date.now() - start} ms` }
    };

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === "modele") {
    const requested = interaction.options.getString("nom", false);
    const reset = interaction.options.getBoolean("reset") ?? false;
    if (!requested) {
      await interaction.reply({ content: `Modèle actif: ${activeModel}`, flags: MessageFlags.Ephemeral });
      return;
    }
    setActiveModel(requested.trim());
    if (reset) {
      clearHistory();
    }
    await interaction.reply({ content: `Modèle actif: ${activeModel}${reset ? " (historique réinitialisé)" : ""}`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "stop") {
    const selectedChannel = interaction.options.getChannel("salon") ?? interaction.channel;

    if (!selectedChannel || selectedChannel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Choisis un salon texte du serveur.", flags: MessageFlags.Ephemeral });
      return;
    }

    const targetChannel = selectedChannel as TextChannel;

    const oldStopData = channelStopMessage.get(targetChannel.id);
    if (oldStopData) {
      try {
        const oldMsg = await targetChannel.messages.fetch(oldStopData.msgId);
        await oldMsg.edit({ components: [] });
      } catch (error) {
        logger.warn("Failed to clear old stop button via /stop", error);
      }
    }

    activeChannels.delete(targetChannel.id);
    channelStopMessage.delete(targetChannel.id);

    const redEmbed: APIEmbed = {
      title: "Raphaël s'éclipse",
      description: "Il n'écoutera plus ce salon jusqu'à nouvel ordre.",
      color: 0xe74c3c
    };

    try {
      await targetChannel.send({ embeds: [redEmbed] });
    } catch (error) {
      logger.warn("Failed to send leave embed via /stop", error);
    }

    await interaction.reply({ content: `Raphaël a été arrêté pour ${targetChannel}.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "talk") {
    if (!isActive) {
      await interaction.reply({ content: "Raphaël est en pause. Redémarre-le pour continuer.", flags: MessageFlags.Ephemeral });
      return;
    }

    const selectedChannel = interaction.options.getChannel("salon") ?? interaction.channel;

    const targetChannel = selectedChannel as TextChannel;
    const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const historyKey = `${interaction.guildId ?? "dm"}:${targetChannel.id}`;

    let stopTyping: (() => void) | undefined;
    try {
      stopTyping = startTyping(targetChannel);
      const starterPrompt = appendUserContext(
        `Présente-toi en UNE phrase comme Raphaël, roi du savoir, avec un ton amical; dis que tu es là pour guider, discuter et fournir des infos utiles. Utilisateur: ${member?.displayName ?? interaction.user.displayName ?? interaction.user.username}`,
        interaction.user,
        member,
        interaction.guild
      );
      const { reply, actions } = await chatWithOllama(starterPrompt, historyKey, interaction.guild);
      if (actions.length > 0) {
        await Promise.all(actions.map(a => performAction(a, { guild: interaction.guild })));
      }

      const embedAction = actions.find(a => a.type === "embed_reply") as (typeof actions)[0] & { type: "embed_reply" } | undefined;
      const embed = embedAction ? buildEmbed(embedAction) : undefined;

      const { cleanText, links } = extractLinks(reply);
      const content = embed ? undefined : cleanText.slice(0, 1900);

      const oldStopData = channelStopMessage.get(targetChannel.id);
      if (oldStopData) {
        try {
          const oldMsg = await targetChannel.messages.fetch(oldStopData.msgId);
          await oldMsg.edit({ components: [] });
        } catch (error) {
          logger.warn("Failed to clear old stop button via /stop", error);
        }
      }

      const joinEmbed: APIEmbed = {
        title: "Raphaël a rejoint la conversation",
        description: "Tous les membres peuvent interagir avec lui ici.",
        color: 0x2ecc71
      };

      const stopButtonId = `raphael-stop-${targetChannel.id}-${Date.now()}`;
      const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(stopButtonId)
          .setLabel("Stop")
          .setStyle(ButtonStyle.Danger)
      );
      const linkRow = buildLinkButtons(links);
      const components = linkRow ? [linkRow, stopRow] : [stopRow];

      const sent = await targetChannel.send({ content, embeds: embed ? [embed] : [joinEmbed], components });
      channelStopMessage.set(targetChannel.id, { msgId: sent.id, buttonId: stopButtonId });
      activeChannels.add(targetChannel.id);

      await interaction.editReply({ content: `Réponse envoyée dans ${targetChannel}.`, embeds: [] });
    } catch (error) {
      logger.error("talk command failed", error);
      if (error instanceof Error && error.message === "OLLAMA_UNAVAILABLE") {
        await interaction.editReply({ content: "Ollama est injoignable sur 127.0.0.1:11434. Lance 'ollama serve' puis réessaie." });
      } else {
        await interaction.editReply({ content: "Désolé, une erreur est survenue lors de l'appel à l'IA." });
      }
    } finally {
      stopTyping?.();
    }
    return;
  }

  if (interaction.commandName === "messbasse") {
    if (!isActive) {
      await interaction.reply({ content: "Raphaël est en pause. Redémarre-le pour continuer.", flags: MessageFlags.Ephemeral });
      return;
    }

    const prompt = interaction.options.getString("prompt", true);
    const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
    const promptWithContext = appendUserContext(prompt, interaction.user, member, interaction.guild);
    const historyKey = `priv:${interaction.user.id}`;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const { reply, actions } = await chatWithOllama(promptWithContext, historyKey, interaction.guild);
      if (actions.length > 0) {
        await Promise.all(actions.map(a => performAction(a, { guild: interaction.guild })));
      }

      const embedAction = actions.find(a => a.type === "embed_reply") as (typeof actions)[0] & { type: "embed_reply" } | undefined;
      const embed = embedAction ? buildEmbed(embedAction) : undefined;

      const { cleanText, links } = extractLinks(reply);
      const content = embed ? undefined : cleanText.slice(0, 1900);
      const linkRow = buildLinkButtons(links);

      await interaction.editReply({ content, embeds: embed ? [embed] : undefined, components: linkRow ? [linkRow] : undefined });
    } catch (error) {
      logger.error("messbasse command failed", error);
      if (error instanceof Error && error.message === "OLLAMA_UNAVAILABLE") {
        await interaction.editReply({ content: "Ollama est injoignable sur 127.0.0.1:11434. Lance 'ollama serve' puis réessaie." });
      } else {
        await interaction.editReply({ content: "Désolé, une erreur est survenue lors de l'appel à l'IA." });
      }
    }
    return;
  }

  if (interaction.commandName === "dm") {
    if (!isActive) {
      await interaction.reply({ content: "Raphaël est en pause. Redémarre-le pour continuer.", flags: MessageFlags.Ephemeral });
      return;
    }

    const dmUserId = interaction.user.id;
    const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
    const historyKey = `dm:${dmUserId}`;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let stopTyping: (() => void) | undefined;
    try {
      const dmChannel = await interaction.user.createDM();
      stopTyping = startTyping(dmChannel);
      const starterPrompt = appendUserContext(
        `Présente-toi en une phrase comme Raphaël, avec un ton amical. Utilisateur: ${interaction.user.username}`,
        interaction.user,
        member,
        interaction.guild
      );
      const { reply, actions } = await chatWithOllama(starterPrompt, historyKey, interaction.guild);
      const actionNotes = actions.length > 0 ? await Promise.all(actions.map(a => performAction(a, { guild: interaction.guild }))) : [];
      const allNotes = actionNotes.flat();

      const embedAction = actions.find(a => a.type === "embed_reply") as (typeof actions)[0] & { type: "embed_reply" } | undefined;
      const embed = embedAction ? buildEmbed(embedAction) : undefined;

      const { cleanText, links } = extractLinks(reply);
      const suffix = allNotes.length ? `\n\nActions:\n- ${allNotes.join("\n- ")}` : "";
      const content = embed ? undefined : `${cleanText}${suffix}`.slice(0, 1900);
      const linkRow = buildLinkButtons(links);

      const sent = await dmChannel.send({ content, embeds: embed ? [embed] : undefined, components: linkRow ? [linkRow] : undefined });

      activeDMs.add(dmUserId);
      await interaction.editReply({ content: `Conversation DM lancée.`, embeds: [] });
    } catch (error) {
      logger.error("dm command failed", error);
      if (error instanceof Error && error.message === "OLLAMA_UNAVAILABLE") {
        await interaction.editReply({ content: "Ollama est injoignable sur 127.0.0.1:11434. Lance 'ollama serve' puis réessaie." });
      } else {
        await interaction.editReply({ content: "Désolé, une erreur est survenue lors de l'appel à l'IA." });
      }
    } finally {
      stopTyping?.();
    }
    return;
  }
});

(async () => {
  try {
    await registerCommands();
    await client.login(botToken);
  } catch (error) {
    logger.error("Failed to start the bot", error);
    process.exit(1);
  }
})();

client.on("messageCreate", async (message) => {
  if (!isActive) return;
  if (message.author.bot) return;

  // Gestion des DM
  if (!message.guild) {
    if (!activeDMs.has(message.author.id)) return;

    const prompt = message.content?.trim();
    if (!prompt) return;

    upsertUser({ id: message.author.id, username: message.author.username, discriminator: message.author.discriminator });

    const historyKey = `dm:${message.author.id}`;

    let stopTyping: (() => void) | undefined;
    try {
      stopTyping = startTyping(message.channel as any);
      const promptWithContext = appendUserContext(prompt, message.author, null, null);
      const { reply, actions } = await chatWithOllama(promptWithContext, historyKey, null);
      if (actions.length > 0) {
        await Promise.all(actions.map(a => performAction(a, { guild: null })));
      }

      const embedAction = actions.find(a => a.type === "embed_reply") as (typeof actions)[0] & { type: "embed_reply" } | undefined;
      const embed = embedAction ? buildEmbed(embedAction) : undefined;

      const { cleanText, links } = extractLinks(reply);
      const content = embed ? undefined : cleanText.slice(0, 1900);
      const linkRow = buildLinkButtons(links);

      await message.reply({ content, embeds: embed ? [embed] : undefined, components: linkRow ? [linkRow] : undefined });
    } catch (error) {
      if (error instanceof Error && error.message === "OLLAMA_UNAVAILABLE") {
        await message.reply("Ollama est injoignable sur 127.0.0.1:11434. Lance 'ollama serve' puis réessaie.");
      } else {
        logger.error("dm message handler failed", error);
      }
    } finally {
      stopTyping?.();
    }
    return;
  }

  // Gestion des salons
  if (!activeChannels.has(message.channelId)) return;

  const prompt = message.content?.trim();
  if (!prompt) return;

  upsertUser({ id: message.author.id, username: message.author.username, discriminator: message.author.discriminator });

  const historyKey = `${message.guildId ?? "dm"}:${message.channelId}`;

  let stopTyping: (() => void) | undefined;
  try {
    stopTyping = startTyping(message.channel as any);
    const promptWithContext = appendUserContext(prompt, message.author, message.member, message.guild);
    const { reply, actions } = await chatWithOllama(promptWithContext, historyKey, message.guild);
    if (actions.length > 0) {
      await Promise.all(actions.map(a => performAction(a, { guild: message.guild })));
    }

    const embedAction = actions.find(a => a.type === "embed_reply") as (typeof actions)[0] & { type: "embed_reply" } | undefined;
    const embed = embedAction ? buildEmbed(embedAction) : undefined;

    const { cleanText, links } = extractLinks(reply);
    const content = embed ? undefined : cleanText.slice(0, 1900);

    const stopButtonId = `raphael-stop-${message.channelId}-${Date.now()}`;
    const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(stopButtonId)
        .setLabel("Stop")
        .setStyle(ButtonStyle.Danger)
    );
    const linkRow = buildLinkButtons(links);
    const components = linkRow ? [linkRow, stopRow] : [stopRow];

    const oldStopData = channelStopMessage.get(message.channelId);
    if (oldStopData) {
      try {
        const oldMsg = await (message.channel as TextChannel).messages.fetch(oldStopData.msgId);
        await oldMsg.edit({ components: [] });
      } catch (error) {
        logger.warn("Failed to clear old stop button in auto-response", error);
      }
    }

    const sent = await message.reply({ content, embeds: embed ? [embed] : undefined, components });
    channelStopMessage.set(message.channelId, { msgId: sent.id, buttonId: stopButtonId });
  } catch (error) {
    if (error instanceof Error && error.message === "OLLAMA_UNAVAILABLE") {
      await message.reply("Ollama est injoignable sur 127.0.0.1:11434. Lance 'ollama serve' puis réessaie.");
    } else {
      logger.error("message handler failed", error);
    }
  } finally {
    stopTyping?.();
  }
});

export default client;
