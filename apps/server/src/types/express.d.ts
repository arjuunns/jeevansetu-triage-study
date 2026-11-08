import type { UserRole } from '@jeevansetu/types';

/** The authenticated principal resolved by the auth middleware. */
export interface AuthContext {
  userId: string;
  clerkUserId: string;
  role: UserRole;
  hospitalId: string | null;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id for this request, surfaced in logs and audit entries. */
      requestId: string;
      /** Present once the auth middleware has run on a protected route. */
      authContext?: AuthContext;
    }
  }
}

export {};
