import { Router } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as service from './hospital.service.js';
import {
  capacitySchema,
  createHospitalSchema,
  departmentSchema,
  resourceSchema,
  specialistSchema,
  updateHospitalSchema,
} from './hospital.schemas.js';

/** Hospital management routes (Phase 9). */
export const hospitalRouter: Router = Router();

// hospitalRouter.use(requireAuth);

hospitalRouter.get(
  '/',
  // requirePermission('patient:read'),
  asyncHandler(async (_req, res) => sendOk(res, await service.listHospitals())),
);

hospitalRouter.get(
  '/:id',
  requirePermission('patient:read'),
  asyncHandler(async (req, res) => sendOk(res, await service.getHospital(req.params.id!))),
);

hospitalRouter.post(
  '/',
  requirePermission('hospital:manage'),
  validate(createHospitalSchema),
  asyncHandler(async (req, res) => sendOk(res, await service.createHospital(req.body, auditContextFrom(req)), 201)),
);

hospitalRouter.patch(
  '/:id',
  requirePermission('hospital:manage'),
  validate(updateHospitalSchema),
  asyncHandler(async (req, res) =>
    sendOk(res, await service.updateHospital(req.params.id!, req.body, auditContextFrom(req))),
  ),
);

hospitalRouter.put(
  '/:id/capacity',
  requirePermission('capacity:update'),
  validate(capacitySchema),
  asyncHandler(async (req, res) =>
    sendOk(res, await service.updateCapacity(req.params.id!, req.body, auditContextFrom(req))),
  ),
);

hospitalRouter.post(
  '/:id/departments',
  requirePermission('department:manage'),
  validate(departmentSchema),
  asyncHandler(async (req, res) => sendOk(res, await service.addDepartment(req.params.id!, req.body), 201)),
);

hospitalRouter.post(
  '/:id/specialists',
  requirePermission('specialist:manage'),
  validate(specialistSchema),
  asyncHandler(async (req, res) => sendOk(res, await service.addSpecialist(req.params.id!, req.body), 201)),
);

hospitalRouter.post(
  '/:id/resources',
  requirePermission('hospital:manage'),
  validate(resourceSchema),
  asyncHandler(async (req, res) => sendOk(res, await service.addResource(req.params.id!, req.body), 201)),
);
