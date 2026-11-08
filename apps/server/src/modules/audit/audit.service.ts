import type { AuditAction } from '@jeevansetu/types';
import type { Prisma } from '@prisma/client';

import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Phase 15 — Audit System.
 *
 * Every clinically or operationally significant mutation is recorded with the
 * actor, timestamp, before/after state, and request context (IP, device). Audit
 * writes must never break the primary operation, so failures are logged and
 * swallowed rather than propagated.
 */
export interface AuditContext {
  userId?: string | null;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface RecordAuditArgs {
  action: AuditAction;
  entityType: string;
  entityId: string;
  previousState?: unknown;
  newState?: unknown;
  context?: AuditContext;
  metadata?: Record<string, unknown>;
}

/** Persist a single audit log entry. Best-effort: never throws to the caller. */
export async function recordAudit(args: RecordAuditArgs): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId,
        userId: args.context?.userId ?? null,
        previousState: toJson(args.previousState),
        newState: toJson(args.newState),
        ipAddress: args.context?.ipAddress,
        userAgent: args.context?.userAgent,
        metadata: {
          ...(args.metadata ?? {}),
          ...(args.context?.requestId ? { requestId: args.context.requestId } : {}),
        } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.error({ err, action: args.action, entityId: args.entityId }, 'Failed to write audit log');
  }
}

/**
 * Run a mutating operation inside a Prisma transaction and write an audit entry
 * atomically with it, capturing the diff. The audit row is part of the same
 * transaction, so either both the change and its audit persist, or neither do.
 */
export async function withAudit<T>(
  args: Omit<RecordAuditArgs, 'previousState' | 'newState'> & {
    previousState?: unknown;
  },
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  deriveNewState?: (result: T) => unknown,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await operation(tx);
    await tx.auditLog.create({
      data: {
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId,
        userId: args.context?.userId ?? null,
        previousState: toJson(args.previousState),
        newState: toJson(deriveNewState ? deriveNewState(result) : result),
        ipAddress: args.context?.ipAddress,
        userAgent: args.context?.userAgent,
        metadata: {
          ...(args.metadata ?? {}),
          ...(args.context?.requestId ? { requestId: args.context.requestId } : {}),
        } as Prisma.InputJsonValue,
      },
    });
    return result;
  });
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  // Round-trip through JSON to strip Dates/undefined into a Prisma-safe shape.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Query audit history for a single entity, newest first. */
export async function getEntityAuditTrail(entityType: string, entityId: string, limit = 100) {
  return prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { user: { select: { id: true, email: true, role: true } } },
  });
}
