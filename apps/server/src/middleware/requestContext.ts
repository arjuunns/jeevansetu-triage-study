import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

/**
 * Assigns a correlation id to every request and exposes it via the
 * `x-request-id` response header. The id flows into structured logs and audit
 * records so a single clinical action can be traced end-to-end.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length <= 100 ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

/** Best-effort client IP extraction honouring a single trusted proxy hop. */
export function clientIp(req: Request): string | undefined {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim();
  return req.socket.remoteAddress ?? undefined;
}
