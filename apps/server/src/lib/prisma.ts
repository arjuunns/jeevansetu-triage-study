import { PrismaClient } from '@prisma/client';

import { isProd } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Single shared PrismaClient. A global cache prevents exhausting the connection
 * pool when the dev server hot-reloads.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProd ? ['error', 'warn'] : ['error', 'warn'],
  });

if (!isProd) globalForPrisma.prisma = prisma;

/** Soft-delete-aware default filter helper. */
export const notDeleted = { deletedAt: null } as const;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Prisma disconnected');
}
