import { Router } from 'express';

import { features } from '../../config/env.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { isNeo4jAvailable } from '../routing/neo4j.js';

/**
 * Health & readiness probes (Phase 17). `/health` is a cheap liveness check;
 * `/health/ready` verifies downstream dependencies for load-balancer readiness.
 */
export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ ok: true, data: { status: 'up', time: new Date().toISOString() } });
});

healthRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const checks = await Promise.allSettled([
      prisma.$queryRaw`SELECT 1`,
      isNeo4jAvailable(),
    ]);

    const [db, graph] = checks;
    const ready = db.status === 'fulfilled';
    sendOk(
      res,
      {
        status: ready ? 'ready' : 'degraded',
        dependencies: {
          postgres: db.status === 'fulfilled' ? 'up' : 'down',
          neo4j: graph.status === 'fulfilled' && graph.value ? 'up' : 'down',
          features,
        },
      },
      ready ? 200 : 503,
    );
  }),
);
