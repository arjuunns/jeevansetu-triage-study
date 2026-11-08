import { join } from 'node:path';
import { clerkMiddleware } from '@clerk/express';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env, features } from './config/env.js';
import { logger } from './config/logger.js';
import { errorBody } from './lib/http.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestContext } from './middleware/requestContext.js';
import { apiRouter } from './routes/index.js';

/**
 * Builds the Express application. Order matters: security headers → CORS →
 * correlation id → request logging → body parsing → auth context → routes →
 * 404 → centralised error handler.
 *
 * Note: the RAG upload route consumes a raw application/pdf body, so the global
 * JSON parser is scoped to skip that content type.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { requestId?: string }).requestId ?? 'unknown',
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
    }),
  );

  // Parse JSON for everything except raw PDF uploads (handled per-route).
  app.use((req, res, next) => {
    if (req.is('application/pdf')) return next();
    return express.json({ limit: '2mb' })(req, res, next);
  });
  app.use(express.urlencoded({ extended: true }));

  // Clerk attaches session context when configured; auth middleware enforces it.
  if (features.auth) {
    app.use(clerkMiddleware());
  } else {
    logger.warn('Clerk not configured — auth is DISABLED (dev only). Do not run like this in production.');
  }

  app.use('/api/v1', apiRouter);
  app.use('/uploads', express.static(join(process.cwd(), 'uploads')));

  // Root info.
  app.get('/', (_req, res) => {
    res.json(
      errorBody('USE_API', 'JeevanSetu API. See /api/v1/health'),
    );
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
