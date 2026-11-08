import type { ApiError, ApiSuccess } from '@jeevansetu/types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wrap an async route handler so thrown/rejected errors reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Send a standard success envelope. */
export function sendOk<T>(
  res: Response,
  data: T,
  status = 200,
  meta?: Record<string, unknown>,
): void {
  const body: ApiSuccess<T> = { ok: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

/** Build a standard error envelope (used by the error middleware). */
export function errorBody(code: string, message: string, details?: unknown): ApiError {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}
