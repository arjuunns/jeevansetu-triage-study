import { geoPointSchema } from '@jeevansetu/types';
import { z } from 'zod';
import { Router } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { runVisitPipeline } from './orchestrator.js';

/** Multi-agent pipeline routes (Phase 12). */
export const agentsRouter: Router = Router();

const pipelineSchema = z.object({ origin: geoPointSchema.optional() });

agentsRouter.use(requireAuth);

agentsRouter.post(
  '/visits/:visitId/pipeline',
  requirePermission('recommendation:read'),
  validate(pipelineSchema),
  asyncHandler(async (req, res) => {
    const result = await runVisitPipeline(
      req.params.visitId!,
      { origin: (req.body as { origin?: { latitude: number; longitude: number } }).origin },
      auditContextFrom(req),
    );
    sendOk(res, result, 201);
  }),
);
