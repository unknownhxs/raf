// database.ts
// Gestion de la base de données SQLite pour le suivi des utilisateurs
import Database from 'better-sqlite3';
import logger from './logger';

const db = new Database('./data/users.db');

// Créer la table si elle n'existe pas
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT,
    discriminator TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    last_interaction DATETIME
  );
`);

logger.info('Database initialized');

export function getUser(userId: string): any {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(userId);
}

export function upsertUser(user: { id: string; username: string; discriminator?: string }): void {
  const existing = getUser(user.id);
  if (existing) {
    const stmt = db.prepare(
      'UPDATE users SET username = ?, discriminator = ?, message_count = message_count + 1, last_interaction = CURRENT_TIMESTAMP WHERE id = ?'
    );
    stmt.run(user.username, user.discriminator || '', user.id);
  } else {
    const stmt = db.prepare(
      'INSERT INTO users (id, username, discriminator, message_count, last_interaction) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)'
    );
    stmt.run(user.id, user.username, user.discriminator || '');
  }
}

export function getUserStats(userId: string): any {
  const stmt = db.prepare('SELECT message_count, joined_at, last_interaction FROM users WHERE id = ?');
  return stmt.get(userId);
}