// logger.ts
// Configuration de la journalisation avec Winston
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'discord-bot' },
  transports: [
    // Écrire tous les logs de niveau `error` et en dessous dans `error.log`
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    // Écrire tous les logs de niveau `info` et en dessous dans `combined.log`
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Si nous ne sommes pas en production, logger aussi dans la console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

export default logger;