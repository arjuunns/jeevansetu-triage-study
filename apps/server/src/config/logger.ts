import pino from 'pino';

import { env, isDev } from './env.js';

/**
 * Structured logger (pino). In development we pretty-print; in production we
 * emit JSON for ingestion by the observability stack. PHI must never be logged
 * — log identifiers (visitId, patientId) rather than clinical content.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    remove: true,
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
