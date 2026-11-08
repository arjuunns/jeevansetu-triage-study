import { USER_ROLES, type UserRole } from '@jeevansetu/types';
import { z } from 'zod';

import { NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit, type AuditContext } from '../audit/audit.service.js';

/** Phase 2 — user provisioning and role administration (Super Admin). */

export const provisionUserSchema = z.object({
  clerkUserId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  role: z.enum(USER_ROLES).default('NURSE'),
  hospitalId: z.string().optional(),
});
export type ProvisionUserInput = z.infer<typeof provisionUserSchema>;

/** Upsert a user, typically driven by a Clerk webhook on sign-up. */
export async function provisionUser(input: ProvisionUserInput) {
  return prisma.user.upsert({
    where: { clerkUserId: input.clerkUserId },
    create: input,
    update: {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      hospitalId: input.hospitalId,
    },
  });
}

export const changeRoleSchema = z.object({ role: z.enum(USER_ROLES), hospitalId: z.string().optional() });

export async function changeRole(
  userId: string,
  role: UserRole,
  hospitalId: string | undefined,
  context: AuditContext,
) {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) throw new NotFoundError('User');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { role, hospitalId, updatedBy: context.userId ?? undefined },
  });

  await recordAudit({
    action: 'USER_ROLE_CHANGED',
    entityType: 'User',
    entityId: userId,
    previousState: { role: existing.role, hospitalId: existing.hospitalId },
    newState: { role, hospitalId },
    context,
  });
  return updated;
}

export async function listUsers() {
  return prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      hospitalId: true,
      isActive: true,
      lastLoginAt: true,
    },
  });
}

export async function getMe(clerkUserId: string) {
  const user = await prisma.user.findUnique({
    where: { clerkUserId },
    include: { hospital: { select: { id: true, name: true } } },
  });
  if (!user) throw new NotFoundError('User');
  return user;
}
