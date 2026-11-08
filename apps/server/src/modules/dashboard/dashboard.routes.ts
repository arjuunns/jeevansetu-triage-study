import { Router } from 'express';

import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { getDashboardMetrics } from './dashboard.service.js';

/** CMO dashboard routes (Phase 14). */
export const dashboardRouter: Router = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get(
  '/metrics',
  requirePermission('analytics:read'),
  asyncHandler(async (_req, res) => sendOk(res, await getDashboardMetrics())),
);
