import { Router } from 'express';
import { z } from 'zod';

import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { listNotifications, markRead, broadcastEmergency } from './notification.service.js';

/** Notification routes (Phase 13). */
export const notificationRouter: Router = Router();

// Manual emergency broadcast endpoint (accessible to authorized users)
notificationRouter.post(
  '/broadcast',
  validate(z.object({
    department: z.string().min(1),
    title: z.string().min(3),
    body: z.string().min(3),
    payload: z.record(z.any()).optional(),
  })),
  asyncHandler(async (req, res) => {
    const { department, title, body, payload } = req.body;
    const notifiedCount = await broadcastEmergency(department, title, body, payload);
    sendOk(res, { notifiedCount });
  }),
);

notificationRouter.use(requireAuth);

notificationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.authContext?.userId;
    if (!userId) throw new UnauthorizedError();
    const unreadOnly = req.query.unread === 'true';
    sendOk(res, await listNotifications(userId, unreadOnly));
  }),
);

notificationRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const userId = req.authContext?.userId;
    if (!userId) throw new UnauthorizedError();
    sendOk(res, await markRead(req.params.id!, userId));
  }),
);

