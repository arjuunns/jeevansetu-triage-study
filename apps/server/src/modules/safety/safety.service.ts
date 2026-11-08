import type { SafetyScreenResult } from '@jeevansetu/types';

import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { recordAudit, type AuditContext } from '../audit/audit.service.js';
import { broadcastEmergency } from '../notifications/notification.service.js';
import { runSafetyScreen, type SafetyInput } from './safety.engine.js';

/**
 * Service layer for the safety screen. Loads a visit's latest vitals & symptoms,
 * runs the deterministic engine, persists the verdict onto the triage assessment
 * (creating a stub assessment if needed), raises an EmergencyAlert on a critical
 * finding, and writes the audit trail.
 */
export async function screenVisit(
  visitId: string,
  context: AuditContext,
): Promise<SafetyScreenResult> {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, deletedAt: null },
    include: {
      patient: {
        include: {
          registeredBy: {
            include: {
              hospital: true,
            },
          },
        },
      },
      vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
      symptoms: { where: { deletedAt: null } },
    },
  });
  if (!visit) throw new NotFoundError('Visit');

  const latest = visit.vitals[0];
  const input: SafetyInput = {
    vitals: {
      temperatureC: latest?.temperatureC ?? undefined,
      oxygenSaturation: latest?.oxygenSaturation ?? undefined,
      heartRate: latest?.heartRate ?? undefined,
      respiratoryRate: latest?.respiratoryRate ?? undefined,
      systolicBp: latest?.systolicBp ?? undefined,
      diastolicBp: latest?.diastolicBp ?? undefined,
      glasgowComaScale: latest?.glasgowComaScale ?? undefined,
      isUnconscious: latest?.isUnconscious ?? false,
    },
    symptoms: visit.symptoms.map((s) => ({ name: s.name, severity: s.severity })),
  };

  const result: SafetyScreenResult = runSafetyScreen(input, new Date().toISOString());

  // Persist verdict onto (or into a new) triage assessment, and update visit status.
  await prisma.$transaction(async (tx) => {
    await tx.triageAssessment.upsert({
      where: { visitId },
      create: {
        visitId,
        safetyIsCritical: result.isCritical,
        safetyForcedSeverity: result.forcedSeverity ?? undefined,
        safetyTriggeredRules: result.triggeredRules as unknown as object,
      },
      update: {
        safetyIsCritical: result.isCritical,
        safetyForcedSeverity: result.forcedSeverity ?? null,
        safetyTriggeredRules: result.triggeredRules as unknown as object,
      },
    });

    await tx.visit.update({
      where: { id: visitId },
      data: { status: 'SAFETY_SCREENED' },
    });

    if (result.isCritical) {
      await tx.emergencyAlert.create({
        data: {
          visitId,
          severity: 'CRITICAL',
          status: 'ACTIVE',
          title: 'Critical patient detected by safety screen',
          message: result.recommendedActions.join(' '),
          triggeredRules: result.triggeredRules.map((r) => r.ruleId),
        },
      });
    }
  });

  await recordAudit({
    action: 'SAFETY_SCREEN_EXECUTED',
    entityType: 'Visit',
    entityId: visitId,
    newState: result,
    context,
    metadata: { isCritical: result.isCritical, rules: result.triggeredRules.map((r) => r.ruleId) },
  });

  if (result.isCritical) {
    logger.warn(
      { visitId, rules: result.triggeredRules.map((r) => r.ruleId) },
      'Safety screen flagged CRITICAL patient',
    );
    
    const patientName = visit.patient.name;
    const hospitalName = visit.patient.registeredBy?.hospital?.name ?? 'Network Hospital';

    broadcastEmergency(
      'Emergency',
      'CRITICAL Safety Alert',
      `Patient ${patientName} at ${hospitalName} flagged as CRITICAL by safety screen. Rules: ${result.triggeredRules.map((r) => r.label).join(', ')}`,
      { visitId }
    ).catch((err) => {
      logger.error({ err, visitId }, 'Failed to broadcast emergency for safety critical visit');
    });
  }

  return result;
}
