/**
 * @jeevansetu/types — shared domain contracts consumed by both the Express
 * server and the Next.js web app. Enums here are the single source of truth and
 * are mirrored 1:1 in the Prisma schema.
 */
export * from './enums.js';
export * from './patient.js';
export * from './triage.js';
export * from './safety.js';
export * from './routing.js';
export * from './referral.js';
export * from './api.js';
