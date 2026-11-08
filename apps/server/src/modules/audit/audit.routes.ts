import { Router } from 'express';

import { asyncHandler, sendOk } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { getEntityAuditTrail } from './audit.service.js';

/** Audit log routes (Phase 15). Restricted to roles holding auditLog:manage. */
export const auditRouter: Router = Router();

auditRouter.use(requireAuth);

auditRouter.get(
  '/',
  requirePermission('auditLog:manage'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(Number(req.query.pageSize ?? 50), 200);
    const where = {
      ...(req.query.action ? { action: req.query.action as never } : {}),
      ...(req.query.entityType ? { entityType: String(req.query.entityType) } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { email: true, role: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);
    sendOk(res, { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  }),
);

auditRouter.get(
  '/:entityType/:entityId',
  requirePermission('auditLog:manage'),
  asyncHandler(async (req, res) => {
    sendOk(res, await getEntityAuditTrail(req.params.entityType!, req.params.entityId!));
  }),
);
