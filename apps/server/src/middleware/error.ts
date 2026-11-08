import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { logger } from '../config/logger.js';
import { AppError } from '../lib/errors.js';
import { errorBody } from '../lib/http.js';

/** 404 handler for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(errorBody('NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

/**
 * Centralised error middleware. Maps known error shapes (AppError, Zod, Prisma)
 * onto the standard ApiError envelope and never leaks internals in production.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error({ err, requestId: req.requestId }, err.message);
    res.status(err.statusCode).json(errorBody(err.code, err.message, err.details));
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json(errorBody('VALIDATION_ERROR', 'Validation failed', err.flatten()));
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res
        .status(409)
        .json(errorBody('CONFLICT', 'A record with these unique fields already exists', err.meta));
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json(errorBody('NOT_FOUND', 'Record not found'));
      return;
    }
    logger.error({ err, requestId: req.requestId }, 'Prisma error');
    res.status(400).json(errorBody('DATABASE_ERROR', 'Database request failed'));
    return;
  }

  logger.error({ err, requestId: req.requestId }, 'Unhandled error');
  res.status(500).json(errorBody('INTERNAL_ERROR', 'An unexpected error occurred'));
}
