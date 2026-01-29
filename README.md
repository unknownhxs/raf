# Bot Discord en TypeScript

Bot Discord en TypeScript avec `discord.js` et Ollama. Raphaël est le roi du savoir : il guide, discute et fournit des informations utiles avec un ton amical et clair. Il peut suggérer des pseudos et envoyer des embeds informatifs.

## Prerequis
- Node.js 18+
- Un token de bot Discord
- Ollama installé localement avec un modèle disponible (ex: `llama3.1`)

## Installation
1. Copier `.env.example` en `.env` et renseigner les valeurs.
2. Installer les dependances :
   ```bash
   npm install
   ```

## Scripts
- `npm run dev` : lance le bot en mode dev avec rechargement.
- `npm run build` : compile TypeScript vers `dist/`.
- `npm start` : execute la version compilee.

## Variables d'environnement
- `DISCORD_TOKEN` (obligatoire)
- `DISCORD_CLIENT_ID` (obligatoire pour enregistrer les slash commands globales)
- `OLLAMA_MODEL` (optionnel, par défaut `llama3.1`)

## Commandes
- `/ping` : test basique.
- `/modele nom:<string> [reset:true|false]` : change le modèle Ollama utilisé, optionnellement réinitialise l'historique.
- `/talk [salon:<text channel>]` : lance raphaël dans un salon (choisi ou courant). L'IA initie la conversation et écoute tous les messages du salon ; chaque réponse inclut un bouton Stop actif qui remplace le précédent. L'IA peut changer son pseudo ou envoyer des embeds selon ses décisions.
- `/dm` : lance une conversation DM avec raphaël. L'IA initie la conversation et raphaël répondra ensuite à tous tes messages privés. Fonctionne comme `/talk` mais en privé.
- `/messbasse prompt:<string>` : conversation privée et éphémère avec raphaël. L'historique est propre à l'utilisateur; l'IA peut choisir d'envoyer un embed.
- `/stop` : met raphaël en pause (il n'interagit plus jusqu'à redémarrage).

## Notes sur l'IA
- L'historique par salon/conversation garde les derniers échanges (limité à 150 messages).
- L'IA répond en texte brut et peut inclure des codes d'action $[nickname,nouveau_pseudo,id_utilisateur] ou $[[embed,[...]]] détectés automatiquement; les actions non autorisées sont ignorées.
