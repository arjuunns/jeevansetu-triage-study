import { Router } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { screenVisit } from '../safety/safety.service.js';
import { getAssessment, runTriageForVisit } from './triage.service.js';

/** Triage & safety routes (Phases 5 & 6). */
export const triageRouter: Router = Router();

triageRouter.use(requireAuth);

// Run (or re-run) the deterministic safety screen for a visit.
triageRouter.post(
  '/visits/:visitId/safety-screen',
  requirePermission('recommendation:read'),
  asyncHandler(async (req, res) => {
    const result = await screenVisit(req.params.visitId!, auditContextFrom(req));
    sendOk(res, result, 201);
  }),
);

// Run the AI triage engine for a visit (safety overlay applied automatically).
triageRouter.post(
  '/visits/:visitId/triage',
  requirePermission('recommendation:read'),
  asyncHandler(async (req, res) => {
    const result = await runTriageForVisit(req.params.visitId!, auditContextFrom(req));
    sendOk(res, result, 201);
  }),
);

triageRouter.get(
  '/visits/:visitId/assessment',
  requirePermission('recommendation:read'),
  asyncHandler(async (req, res) => {
    sendOk(res, await getAssessment(req.params.visitId!));
  }),
);
