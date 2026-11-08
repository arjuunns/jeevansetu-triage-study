import { Router } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { getReviewQueue, getReviewHistory, reviewActionSchema, submitReview } from './review.service.js';

/** Doctor review routes (Phase 8). */
export const reviewRouter: Router = Router();

reviewRouter.use(requireAuth);

reviewRouter.get(
  '/queue',
  requirePermission('triage:review'),
  asyncHandler(async (req, res) => {
    sendOk(res, await getReviewQueue(req.authContext?.hospitalId));
  }),
);

reviewRouter.get(
  '/history',
  requirePermission('triage:review'),
  asyncHandler(async (req, res) => {
    sendOk(res, await getReviewHistory(req.authContext?.hospitalId));
  }),
);

reviewRouter.post(
  '/visits/:visitId/review',
  requirePermission('triage:approve'),
  validate(reviewActionSchema),
  asyncHandler(async (req, res) => {
    const doctorId = req.authContext?.userId;
    if (!doctorId) throw new UnauthorizedError();
    const result = await submitReview(req.params.visitId!, doctorId, req.body, auditContextFrom(req));
    sendOk(res, result, 201);
  }),
);
