import { z } from 'zod';
import {
  REVIEW_ACTIONS,
  SEVERITY_LEVELS,
  type AuditAction,
  type SeverityLevel,
} from '@jeevansetu/types';

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit, type AuditContext } from '../audit/audit.service.js';
import { signDocUrl } from '../../lib/storage.js';

/**
 * Phase 8 — Human-in-the-Loop.
 *
 * A doctor reviews an AI assessment and takes one of four actions. APPROVE keeps
 * the AI severity; MODIFY/OVERRIDE change it and REQUIRE a justification; REJECT
 * discards the AI recommendation. A safety-CRITICAL assessment can never be
 * overridden below CRITICAL — the deterministic floor holds even against a human
 * downgrade, surfacing as a ConflictError the doctor must consciously resolve.
 *
 * Every action is persisted as an immutable DoctorReview and a TriageDecision,
 * and written to the audit trail.
 */
export const reviewActionSchema = z
  .object({
    action: z.enum(REVIEW_ACTIONS),
    justification: z.preprocess(
      (val) => (val === null || val === '' || typeof val !== 'string' ? undefined : val.trim()),
      z.string().min(1, 'Please provide a clinical justification note').max(2000).optional()
    ),
    overrideSeverity: z.preprocess(
      (val) => (val === null || val === '' || val === undefined ? undefined : val),
      z.enum(SEVERITY_LEVELS).optional()
    ),
    overrideDepartment: z.preprocess(
      (val) => (val === null || val === '' || typeof val !== 'string' ? undefined : val.trim()),
      z.string().min(1).max(120).optional()
    ),
  })
  .superRefine((val, ctx) => {
    if ((val.action === 'OVERRIDE' || val.action === 'MODIFY') && !val.justification) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['justification'],
        message: 'Justification is required when overriding or modifying the AI recommendation',
      });
    }
    if (val.action === 'OVERRIDE' && !val.overrideSeverity && !val.overrideDepartment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overrideSeverity'],
        message: 'Please select a new severity level or department for this override',
      });
    }
  });

export type ReviewActionInput = z.infer<typeof reviewActionSchema>;

const ACTION_AUDIT: Record<ReviewActionInput['action'], AuditAction> = {
  APPROVE: 'DOCTOR_APPROVED',
  MODIFY: 'DOCTOR_MODIFIED',
  OVERRIDE: 'DOCTOR_OVERRIDDEN',
  REJECT: 'DOCTOR_REJECTED',
};

export async function submitReview(
  visitId: string,
  doctorId: string,
  input: ReviewActionInput,
  context: AuditContext,
) {
  const assessment = await prisma.triageAssessment.findFirst({
    where: { visitId, deletedAt: null },
    include: { review: true },
  });
  if (!assessment) throw new NotFoundError('Triage assessment');
  if (assessment.review) throw new ConflictError('This assessment has already been reviewed');

  // Enforce the deterministic safety floor against human downgrade.
  if (
    assessment.safetyIsCritical &&
    input.overrideSeverity &&
    input.overrideSeverity !== 'CRITICAL'
  ) {
    throw new ForbiddenError(
      'Safety rules flagged this patient CRITICAL. The severity cannot be downgraded below CRITICAL.',
    );
  }

  const finalSeverity: SeverityLevel = resolveFinalSeverity(assessment, input);

  const previousState = {
    aiSeverity: assessment.aiSeverity,
    finalSeverity: assessment.finalSeverity,
  };

  const result = await prisma.$transaction(async (tx) => {
    const review = await tx.doctorReview.create({
      data: {
        assessmentId: assessment.id,
        doctorId,
        action: input.action,
        justification: input.justification,
        overrideSeverity: input.overrideSeverity,
        overrideDepartment: input.overrideDepartment,
      },
    });

    await tx.triageDecision.upsert({
      where: { assessmentId: assessment.id },
      create: {
        assessmentId: assessment.id,
        finalSeverity,
        decidedByAi: input.action === 'APPROVE',
        notes: input.justification,
      },
      update: { finalSeverity, decidedByAi: input.action === 'APPROVE', notes: input.justification },
    });

    await tx.triageAssessment.update({
      where: { id: assessment.id },
      data: {
        finalSeverity,
        recommendedDepartment: input.overrideDepartment ?? assessment.recommendedDepartment,
      },
    });

    await tx.visit.update({
      where: { id: visitId },
      data: { status: input.action === 'REJECT' ? 'UNDER_REVIEW' : 'APPROVED' },
    });

    return review;
  });

  await recordAudit({
    action: ACTION_AUDIT[input.action],
    entityType: 'TriageAssessment',
    entityId: assessment.id,
    previousState,
    newState: { action: input.action, finalSeverity, justification: input.justification },
    context,
  });

  return { reviewId: result.id, finalSeverity, action: input.action };
}

function resolveFinalSeverity(
  assessment: { aiSeverity: SeverityLevel | null; safetyForcedSeverity: SeverityLevel | null },
  input: ReviewActionInput,
): SeverityLevel {
  if (assessment.safetyForcedSeverity === 'CRITICAL') return 'CRITICAL';
  if (input.overrideSeverity) return input.overrideSeverity;
  if (assessment.aiSeverity) return assessment.aiSeverity;
  throw new ValidationError('Assessment has no severity to finalise');
}

/** The doctor review queue: assessments awaiting human sign-off, critical first. */
export async function getReviewQueue(hospitalId?: string | null) {
  return prisma.triageAssessment.findMany({
    where: {
      deletedAt: null,
      review: null,
      finalSeverity: { not: null },
      ...(hospitalId
        ? { visit: { patient: { registeredBy: { hospitalId } } } }
        : {}),
    },
    orderBy: [{ safetyIsCritical: 'desc' }, { createdAt: 'asc' }],
    include: {
      visit: {
        include: {
          patient: { select: { name: true, age: true, gender: true } },
          routing: {
            include: {
              selectedHospital: { select: { name: true } },
            },
          },
        },
      },
      citations: true,
      reasoning: true,
    },
    take: 100,
  });
}

/** The processed review history: assessments that have already been reviewed. */
export async function getReviewHistory(hospitalId?: string | null) {
  const history = await prisma.triageAssessment.findMany({
    where: {
      deletedAt: null,
      NOT: { review: null },
      ...(hospitalId
        ? { visit: { patient: { registeredBy: { hospitalId } } } }
        : {}),
    },
    orderBy: { review: { reviewedAt: 'desc' } },
    include: {
      visit: {
        include: {
          patient: { select: { name: true, age: true, gender: true } },
          routing: {
            include: {
              selectedHospital: { select: { name: true } },
            },
          },
          referral: {
            include: {
              documents: true,
            },
          },
        },
      },
      review: {
        include: {
          doctor: { select: { firstName: true, lastName: true, email: true } },
        },
      },
      citations: true,
      reasoning: true,
    },
    take: 100,
  });

  // Pre-sign document URLs for all referrals in history
  for (const item of history) {
    if (item.visit.referral?.documents) {
      item.visit.referral.documents = await Promise.all(
        item.visit.referral.documents.map(async (doc) => ({
          ...doc,
          url: await signDocUrl(doc.url),
        }))
      );
    }
  }

  return history;
}

