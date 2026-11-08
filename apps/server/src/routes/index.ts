import { Router } from 'express';

import { agentsRouter } from '../modules/agents/agents.routes.js';
import { auditRouter } from '../modules/audit/audit.routes.js';
import { dashboardRouter } from '../modules/dashboard/dashboard.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { hospitalRouter } from '../modules/hospitals/hospital.routes.js';
import { notificationRouter } from '../modules/notifications/notification.routes.js';
import { patientRouter } from '../modules/patients/patient.routes.js';
import { ragRouter } from '../modules/rag/rag.routes.js';
import { referralRouter } from '../modules/referrals/referral.routes.js';
import { reviewRouter } from '../modules/review/review.routes.js';
import { routingRouter } from '../modules/routing/routing.routes.js';
import { triageRouter } from '../modules/triage/triage.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';
import { genaiRouter } from '../modules/genai/genai.routes.js';

/** Mounts every module router under the /api/v1 prefix. */
export const apiRouter: Router = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/patients', patientRouter);
apiRouter.use('/triage', triageRouter);
apiRouter.use('/guidelines', ragRouter);
apiRouter.use('/reviews', reviewRouter);
apiRouter.use('/hospitals', hospitalRouter);
apiRouter.use('/routing', routingRouter);
apiRouter.use('/referrals', referralRouter);
apiRouter.use('/agents', agentsRouter);
apiRouter.use('/notifications', notificationRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/audit', auditRouter);
apiRouter.use('/genai', genaiRouter);
