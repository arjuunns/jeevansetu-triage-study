import { Router } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  changeRole,
  changeRoleSchema,
  getMe,
  listUsers,
  provisionUser,
  provisionUserSchema,
} from './users.service.js';

/** User & RBAC administration routes (Phase 2). */
export const usersRouter: Router = Router();

usersRouter.use(requireAuth);

// Current authenticated user's profile.
usersRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const clerkUserId = req.authContext?.clerkUserId;
    if (!clerkUserId) throw new UnauthorizedError();
    sendOk(res, await getMe(clerkUserId));
  }),
);

usersRouter.get(
  '/',
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (_req, res) => sendOk(res, await listUsers())),
);

usersRouter.post(
  '/',
  requireRole('SUPER_ADMIN'),
  validate(provisionUserSchema),
  asyncHandler(async (req, res) => sendOk(res, await provisionUser(req.body), 201)),
);

usersRouter.patch(
  '/:id/role',
  requireRole('SUPER_ADMIN'),
  validate(changeRoleSchema),
  asyncHandler(async (req, res) => {
    const { role, hospitalId } = req.body as { role: never; hospitalId?: string };
    sendOk(res, await changeRole(req.params.id!, role, hospitalId, auditContextFrom(req)));
  }),
);
