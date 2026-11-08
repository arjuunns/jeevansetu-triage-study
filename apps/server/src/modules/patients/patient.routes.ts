import { Router } from 'express';

import { asyncHandler } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import * as controller from './patient.controller.js';

/**
 * Patient & visit routes (Phase 4). All routes require authentication; mutating
 * routes additionally require the nurse-level intake permissions from the RBAC
 * matrix.
 */
export const patientRouter: Router = Router();

patientRouter.use(requireAuth);

// One-shot nurse intake: register patient + visit + vitals + symptoms + safety screen.
patientRouter.post(
  '/intake',
  requirePermission('patient:register'),
  asyncHandler(controller.fullIntake),
);

patientRouter.post(
  '/intake/parse-voice',
  requirePermission('patient:register'),
  asyncHandler(controller.parseVoiceTranscript),
);

patientRouter.post('/', requirePermission('patient:register'), asyncHandler(controller.registerPatient));
patientRouter.get('/', requirePermission('patient:read'), asyncHandler(controller.listPatients));
patientRouter.get('/:patientId', requirePermission('patient:read'), asyncHandler(controller.getPatient));

// Visit-scoped clinical data capture.
patientRouter.post(
  '/visits/:visitId/vitals',
  requirePermission('vitals:record'),
  asyncHandler(controller.recordVitals),
);
patientRouter.post(
  '/visits/:visitId/symptoms',
  requirePermission('symptoms:record'),
  asyncHandler(controller.recordSymptoms),
);
patientRouter.get(
  '/visits/:visitId',
  requirePermission('patient:read'),
  asyncHandler(controller.getVisit),
);
