import { getAuth } from '@clerk/express';
import { roleHasPermission, type Permission, type UserRole } from '@jeevansetu/types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { env, features } from '../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

/**
 * Phase 2 — Authentication & RBAC.
 *
 * `requireAuth` resolves the Clerk session, loads the corresponding JeevanSetu
 * user, and attaches an AuthContext to the request. `requirePermission` and
 * `requireRole` build on it to gate routes by the role → permission matrix
 * defined in @jeevansetu/types.
 *
 * When AUTH_DISABLED is set (local dev only) a synthetic super-admin context is
 * injected so intake/safety flows can be exercised without a Clerk project.
 */
export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  void resolveAuth(req)
    .then(() => next())
    .catch(next);
};

async function resolveAuth(req: Request): Promise<void> {
  if (!features.auth) {
    // Dev bypass — clearly synthetic, never reachable in production builds.
    // Query a seeded super admin from DB to avoid foreign key violations (like on registeredById).
    const devUser = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN' },
    });

    req.authContext = {
      userId: devUser?.id || 'dev-super-admin',
      clerkUserId: devUser?.clerkUserId || 'dev',
      role: 'SUPER_ADMIN',
      hospitalId: devUser?.hospitalId || null,
      email: devUser?.email || 'dev@jeevansetu.local',
    };
    return;
  }

  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) throw new UnauthorizedError();

  const user = await prisma.user.findUnique({
    where: { clerkUserId },
    select: { id: true, clerkUserId: true, role: true, hospitalId: true, email: true, isActive: true, deletedAt: true },
  });

  if (!user || user.deletedAt || !user.isActive) {
    throw new UnauthorizedError('User account is inactive or not provisioned');
  }

  req.authContext = {
    userId: user.id,
    clerkUserId: user.clerkUserId,
    role: user.role as UserRole,
    hospitalId: user.hospitalId,
    email: user.email,
  };
}

/** Require the caller to hold a specific permission. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    const ctx = req.authContext;
    if (!ctx) return next(new UnauthorizedError());
    if (!isAuthDisabled && !roleHasPermission(ctx.role, permission)) {
      return next(new ForbiddenError(`Missing permission: ${permission}`));
    }
    next();
  };
}

/** Require the caller's role to be one of `roles`. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const ctx = req.authContext;
    if (!ctx) return next(new UnauthorizedError());
    if (!isAuthDisabled && !roles.includes(ctx.role)) {
      return next(new ForbiddenError(`Requires one of roles: ${roles.join(', ')}`));
    }
    next();
  };
}

/** True only in dev when Clerk is not configured. */
export const isAuthDisabled = !features.auth;
