import { z } from 'zod';
import { Router } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { generateReferral, getReferral } from './referral.service.js';

/** Referral routes (Phase 11). */
export const referralRouter: Router = Router();

const generateSchema = z.object({ hospitalId: z.string().optional() });

referralRouter.use(requireAuth);

referralRouter.post(
  '/visits/:visitId/generate',
  requirePermission('referral:generate'),
  validate(generateSchema),
  asyncHandler(async (req, res) => {
    const result = await generateReferral(
      req.params.visitId!,
      (req.body as { hospitalId?: string }).hospitalId,
      auditContextFrom(req),
    );
    sendOk(res, result, 201);
  }),
);

referralRouter.get(
  '/visits/:visitId',
  requirePermission('patient:read'),
  asyncHandler(async (req, res) => sendOk(res, await getReferral(req.params.visitId!))),
);
