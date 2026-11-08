import type { Request } from 'express';

import { clientIp } from '../middleware/requestContext.js';
import type { AuditContext } from '../modules/audit/audit.service.js';

/** Build the audit/actor context that accompanies every mutating operation. */
export function auditContextFrom(req: Request): AuditContext {
  return {
    userId: req.authContext?.userId ?? null,
    ipAddress: clientIp(req),
    userAgent: req.header('user-agent') ?? undefined,
    requestId: req.requestId,
  };
}
