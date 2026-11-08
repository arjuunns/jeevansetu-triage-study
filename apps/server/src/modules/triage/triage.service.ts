import type { SafetyScreenResult } from '@jeevansetu/types';

import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit, type AuditContext } from '../audit/audit.service.js';
import { runSafetyScreen, type SafetyInput } from '../safety/safety.engine.js';
import { dispatchNotification } from '../notifications/notification.service.js';
import { runTriage } from './triage.engine.js';
import type { TriageContext } from './triage.prompts.js';

/**
 * Phase 6 service layer. Orchestrates: load visit → (safety already run at intake,
 * re-derived here for the engine context) → run AI triage graph → persist
 * assessment, AI reasoning, citations, and an AgentExecution record → audit.
 */
export async function runTriageForVisit(visitId: string, context: AuditContext) {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, deletedAt: null },
    include: {
      patient: true,
      vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
      symptoms: { where: { deletedAt: null } },
    },
  });
  if (!visit) throw new NotFoundError('Visit');

  const latest = visit.vitals[0];
  const safetyInput: SafetyInput = {
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
  const safety: SafetyScreenResult = runSafetyScreen(safetyInput, new Date().toISOString());

  const primary = visit.symptoms.find((s) => s.isPrimary) ?? visit.symptoms[0];
  const triageContext: TriageContext = {
    patient: {
      age: visit.patient.age,
      gender: visit.patient.gender,
      allergies: visit.patient.allergies,
      existingDiseases: visit.patient.existingDiseases,
      medications: visit.patient.medications,
    },
    vitals: safetyInput.vitals,
    primarySymptom: primary?.name ?? 'unspecified',
    secondarySymptoms: visit.symptoms.filter((s) => !s.isPrimary).map((s) => s.name),
    chiefComplaint: visit.chiefComplaint ?? undefined,
    safety,
  };

  const startedAt = Date.now();
  const engine = await runTriage(triageContext);
  const latencyMs = Date.now() - startedAt;

  const assessment = await prisma.$transaction(async (tx) => {
    const a = await tx.triageAssessment.upsert({
      where: { visitId },
      create: {
        visitId,
        safetyIsCritical: safety.isCritical,
        safetyForcedSeverity: safety.forcedSeverity ?? undefined,
        safetyTriggeredRules: safety.triggeredRules as unknown as object,
        aiSeverity: engine.result.severity,
        esiLevel: engine.result.esiLevel,
        aiConfidence: engine.result.confidence,
        recommendedDepartment: engine.result.recommendedDepartment,
        possibleConditions: engine.result.possibleConditions as unknown as object,
        recommendedTests: engine.result.recommendedTests,
        riskFactors: engine.result.riskFactors,
        redFlags: engine.result.redFlags,
        finalSeverity: engine.result.severity,
        createdBy: context.userId ?? undefined,
      },
      update: {
        aiSeverity: engine.result.severity,
        esiLevel: engine.result.esiLevel,
        aiConfidence: engine.result.confidence,
        recommendedDepartment: engine.result.recommendedDepartment,
        possibleConditions: engine.result.possibleConditions as unknown as object,
        recommendedTests: engine.result.recommendedTests,
        riskFactors: engine.result.riskFactors,
        redFlags: engine.result.redFlags,
        finalSeverity: engine.result.severity,
      },
    });

    await tx.aIReasoning.upsert({
      where: { assessmentId: a.id },
      create: {
        assessmentId: a.id,
        model: engine.model,
        reasoningText: engine.reasoningText,
        rawOutput: (engine.rawOutput ?? engine.result) as object,
        retries: engine.attempts,
      },
      update: {
        model: engine.model,
        reasoningText: engine.reasoningText,
        rawOutput: (engine.rawOutput ?? engine.result) as object,
        retries: engine.attempts,
      },
    });

    // Replace citation records for this assessment.
    await tx.guidelineCitationRecord.deleteMany({ where: { assessmentId: a.id } });
    if (engine.citations.length > 0) {
      const uniqueGuidelineIds = [...new Set(engine.citations.map((c) => c.guidelineId).filter(Boolean))] as string[];
      const existingGuidelines = await tx.guideline.findMany({
        where: { id: { in: uniqueGuidelineIds } },
        select: { id: true },
      });
      const existingIds = new Set(existingGuidelines.map((g) => g.id));

      await tx.guidelineCitationRecord.createMany({
        data: engine.citations.map((c) => ({
          assessmentId: a.id,
          guidelineId: c.guidelineId && existingIds.has(c.guidelineId) ? c.guidelineId : null,
          chunkId: c.chunkId,
          source: c.source,
          title: c.title,
          snippet: c.snippet,
          score: c.score,
        })),
      });
    }

    await tx.agentExecution.create({
      data: {
        visitId,
        agentType: 'TRIAGE',
        status: 'SUCCEEDED',
        input: triageContext as unknown as object,
        output: engine.result as unknown as object,
        latencyMs,
      },
    });

    await tx.visit.update({ where: { id: visitId }, data: { status: 'TRIAGED' } });
    return a;
  });

  try {
    const { publish } = await import('../../realtime/events.js');
    publish('triage', { visitId });
  } catch (err) {
    logger.error({ err, visitId }, 'Failed to publish triage realtime event');
  }

  await recordAudit({
    action: 'AI_TRIAGE_EXECUTED',
    entityType: 'Visit',
    entityId: visitId,
    newState: { severity: engine.result.severity, confidence: engine.result.confidence },
    context,
    metadata: { usedFallback: engine.usedFallback, attempts: engine.attempts, latencyMs },
  });

  if (visit.patient.guardianPhone) {
    const severity = engine.result.severity;
    const patientName = visit.patient.name;
    const guardianNameStr = visit.patient.guardianName ? `Dear ${visit.patient.guardianName}, ` : 'Dear Guardian, ';
    const bodyText = `${guardianNameStr}primary triage for ${patientName} is complete. Results indicate severity level: ${severity}. Please be mentally prepared for the outcome. A specialist review is in progress.`;

    dispatchNotification({
      type: 'ROUTING_COMPLETED',
      channel: 'SMS',
      title: 'Triage Results Notification',
      body: bodyText,
      to: visit.patient.guardianPhone,
      payload: { visitId, severity },
    }).catch((err) => {
      logger.error({ err, visitId }, 'Failed to send guardian triage SMS notification');
    });
  }

  return { assessmentId: assessment.id, ...engine, safety };
}

export async function getAssessment(visitId: string) {
  const assessment = await prisma.triageAssessment.findFirst({
    where: { visitId, deletedAt: null },
    include: { reasoning: true, citations: true, review: true, decision: true },
  });
  if (!assessment) throw new NotFoundError('Triage assessment');
  return assessment;
}
