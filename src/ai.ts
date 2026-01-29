// ai.ts
// Fonctions liées à l'IA (Ollama, prompts, parsing, historique)
import ollama from "ollama";
import { Guild, User, GuildMember } from "discord.js";
import logger from "./logger";

export type AllowedAction =
  | { type: "change_nick"; nickname: string; userId: string }
  | { type: "embed_reply"; title?: string; description: string; footer?: string; image?: string; thumbnail?: string; author?: string; url?: string };

export const SYSTEM_PROMPT = `
Tu es Raphaël, l’Esprit du Sage, inspiré du manga "Moi, quand je me réincarne en slime".
Ton rôle est d’analyser, expliquer et guider avec une précision parfaite.

STYLE :
- Ton neutre, calme, analytique.
- Pas d’émotions humaines.
- Pas d’humour.
- Pas de phrases inutiles.
- Tu t’adresses à l’utilisateur en utilisant son pseudo (Display).
- Tu peux utiliser des formulations comme : "Analyse en cours…", "Résultat :", "Conclusion :".

RÈGLES DE FORMAT :
1. Réponse COURTE (1–2 phrases) = texte simple, pas d’embed.
2. Réponse LONGUE (explication, liste, analyse) = OBLIGATOIREMENT un embed.
3. En cas de demande de code, le code doit être donné sous cette forme $[]
3. Si l’utilisateur fait un rappel ("d’ailleurs", "comme je disais"), tu continues sur le même sujet brièvement.
4. Si l’utilisateur change de sujet, tu passes en mode neutre immédiatement.
5. Tu peux ajouter un emoji du serveur à la fin d’une réponse courte si pertinent.

EMBEDS :
- Texte hors embed : optionnel (peut être vide).
- L’embed contient TOUTE l’explication détaillée.
- Format obligatoire :
  $embed[TITRE;DESCRIPTION;FOOTER;IMAGE;THUMBNAIL;AUTEUR;URL]
- Les 7 champs doivent être présents, séparés par ;.
- Si un champ est vide, utilise _.
- DESCRIPTION : utilise **gras**, listes (- item), et \\n pour les retours à la ligne.
- FOOTER : texte simple sans markdown.

EXEMPLES VALIDES :
Bonne question ! $embed[Comment je fonctionne;**Analyse :**\\n- Répondre aux requêtes\\n- Fournir des explications optimisées;Par Raphaël;_;_;_;_]

$embed[Titre;Description complète ici;Par Raphaël;_;_;_;_]

EXEMPLE INTERDIT :
$embed[Titre;Description;Par Raphaël;_;_;_;_]  ❌ manque un champ

AUTRE ACTION :
$nick[nouveau_pseudo;user_id]
`;

export type HistoryMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const history = new Map<string, HistoryMessage[]>();
export let activeModel = process.env.OLLAMA_MODEL ?? "llama3.1";

export function setActiveModel(model: string) {
  activeModel = model;
}

export function clearHistory() {
  history.clear();
}

export function updateHistory(key: string, messages: HistoryMessage[]): void {
  history.set(key, messages.slice(-150));
}

export function registerTurn(key: string, userContent: string, assistantContent: string): void {
  const previous = history.get(key) ?? [];
  updateHistory(key, [...previous, { role: "user", content: userContent }, { role: "assistant", content: assistantContent }]);
}

export function buildUserContext(user: User, member: GuildMember | null, guild: Guild | null): string {
  const lines: string[] = [];
  const fallbackDisplay = (user as { globalName?: string }).globalName ?? user.username;
  const displayName = member?.displayName ?? fallbackDisplay;
  lines.push(`Pseudo (à utiliser): ${displayName}`);
  lines.push(`User ID: ${user.id}`);
  if (guild) {
    lines.push(`Serveur: ${guild.name}`);
    
    // Ajoute les emojis du serveur
    const emojis = guild.emojis.cache
      .filter(e => !!e.available)
      .map(e => `<:${e.name}:${e.id}>`)
      .slice(0, 50); // Limite à 50 pour éviter trop de tokens
    if (emojis.length) {
      lines.push(`Emojis serveur (utilise-les dans tes réponses): ${emojis.join(" ")}`);
    }
  } else {
    lines.push("Contexte: DM");
  }
  if (member) {
    const roleNames = member.roles.cache
      .filter((r) => !r.managed && r.name !== "@everyone")
      .map((r) => r.name)
      .slice(0, 10);
    if (roleNames.length) {
      lines.push(`Rôles: ${roleNames.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function appendUserContext(prompt: string, user: User, member: GuildMember | null, guild: Guild | null): string {
  const context = buildUserContext(user, member, guild);
  return `${prompt}\n\nInfos utilisateur (pour personnaliser ta réponse):\n${context}`;
}

export function tryParseAction(raw: string, guild: Guild | null = null): { reply: string; actions: AllowedAction[] } {
  const actions: AllowedAction[] = [];
  let reply = raw;

  // Détecte $nick[nouveau_pseudo,id_utilisateur]
  const nickRegex = /\$nick\[([^;\]]+);([^\]]+)\]/g;
  let nickMatch;
  while ((nickMatch = nickRegex.exec(raw)) !== null) {
    const nickname = nickMatch[1]?.trim();
    const userId = nickMatch[2]?.trim();
    if (nickname && userId) {
      actions.push({ type: "change_nick", nickname, userId });
    }
  }

  // Détecte $embed[titre;description;footer;image;thumbnail;author;url]
  const embedRegex = /\$embed\[([^\]]*)\]/gi;
  let eMatch;
  while ((eMatch = embedRegex.exec(raw)) !== null) {
    const content = eMatch[1].trim();
    const parts = content.split(";").map(p => p.trim());
    
    // S'assure qu'on a exactement 7 parties
    while (parts.length < 7) {
      parts.push("_");
    }
    
    const [title, description, footer, image, thumbnail, author, url] = parts;
    
    if (description && description !== "_") {
      actions.push({
        type: "embed_reply",
        title: title === "_" ? undefined : title,
        description,
        footer: footer === "_" ? undefined : footer,
        image: image === "_" ? undefined : image,
        thumbnail: thumbnail === "_" ? undefined : thumbnail,
        author: author === "_" ? undefined : author,
        url: url === "_" ? undefined : url
      });
    }
  }

  // Supprime les codes d'action de la réponse et nettoie les artefacts
  reply = raw
    .replace(/\$nick\[[^;\]]+;[^\]]+\]/g, "")
    .replace(/\$embed\[[^\]]*\]/gi, "")
    .replace(/^```[\w]*\n?|```$/gm, "")  // Supprime seulement les code blocks
    .replace(/Par Raphaël\s*$/gi, "")  // Supprime "Par Raphaël" orphelin
    .replace(/^\s*:\s*/g, "")  // Supprime : en début
    .replace(/[\*\s"']+$/g, "")  // Supprime artefacts en fin de chaîne
    .replace(/^\s*[\*"']+\s*/g, "")  // Supprime artefacts en début
    .replace(/\s{2,}/g, " ")  // Réduit espaces multiples
    .trim();

  // Gère le format $[code]
  reply = reply.replace(/\$\[([\s\S]*?)\]/g, (match, code) => {
    return `\`\`\`\n${code.trim()}\n\`\`\``;
  });

  // Corrige les emojis mal formés <:name> -> <:name:id>
  if (guild) {
    reply = reply.replace(/<:([a-zA-Z0-9_]+)(?::>|>)/g, (match, name) => {
      const emoji = guild.emojis.cache.find(e => e.name === name);
      return emoji ? `<:${emoji.name}:${emoji.id}>` : match;
    });
  }

  return { reply: reply || "", actions };
}

export function isConnRefused(error: unknown): boolean {
  const cause = (error as any)?.cause;
  if (cause && typeof cause === "object" && "code" in cause && (cause as any).code === "ECONNREFUSED") {
    return true;
  }
  if (error instanceof Error && /ECONNREFUSED/.test(error.message)) {
    return true;
  }
  return false;
}

export async function chatWithOllama(prompt: string, key: string, guild: Guild | null = null): Promise<{ reply: string; actions: AllowedAction[] }> {
  const previous = history.get(key) ?? [];
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...previous,
    { role: "user", content: prompt }
  ];

  logger.info("\n[PROMPT IN]", key);
  logger.info("User:", prompt);
  logger.info("History:", previous.length, "messages");

  let response;
  try {
    response = await ollama.chat({ model: activeModel, messages });
  } catch (error) {
    if (isConnRefused(error)) {
      const err = new Error("OLLAMA_UNAVAILABLE");
      err.cause = error as Error;
      throw err;
    }
    throw error;
  }

  const assistantContent = response.message?.content ?? "";

  logger.info("[PROMPT OUT]", key);
  logger.info("Assistant:", assistantContent);
  logger.info("---");

  registerTurn(key, prompt, assistantContent);
  return tryParseAction(assistantContent, guild);
}
