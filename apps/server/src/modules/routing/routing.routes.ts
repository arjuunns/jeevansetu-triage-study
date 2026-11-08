import { routingRequestSchema } from '@jeevansetu/types';
import { Router } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { routeVisit } from './routing.service.js';

/** Smart routing routes (Phase 10). */
export const routingRouter: Router = Router();

routingRouter.use(requireAuth);

routingRouter.post(
  '/',
  requirePermission('referral:generate'),
  validate(routingRequestSchema),
  asyncHandler(async (req, res) => {
    const result = await routeVisit(req.body, auditContextFrom(req));
    sendOk(res, result, 201);
  }),
);
