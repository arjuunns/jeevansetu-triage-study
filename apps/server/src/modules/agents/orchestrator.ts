import type { GeoPoint } from '@jeevansetu/types';

import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import type { AuditContext } from '../audit/audit.service.js';
import { routeVisit } from '../routing/routing.service.js';
import { runSafetyScreen, type SafetyInput } from '../safety/safety.engine.js';
import { screenVisit } from '../safety/safety.service.js';
import { runTriageForVisit } from '../triage/triage.service.js';
import { superviseRouting, superviseTriage, type SupervisorVerdict } from './supervisor.js';

/**
 * Phase 12 — Multi-Agent Orchestrator.
 *
 * Runs the agent pipeline for a visit and records a supervised AgentExecution at
 * each stage:
 *   1. Patient Intake Agent      — normalises captured visit data
 *   2. Safety screen (Phase 5)   — deterministic, authoritative
 *   3. Triage Agent (+ Guideline Retrieval + Risk Assessment) — Phase 6/7
 *   4. Routing Agent             — Phase 10 (only when an origin is provided)
 *   7. Supervisor Agent          — validates each output
 *
 * The pipeline deliberately STOPS before the human-in-the-loop boundary: it does
 * NOT auto-approve or auto-generate a referral. A doctor must review first.
 */
export interface PipelineResult {
  visitId: string;
  steps: { agent: string; status: 'SUCCEEDED' | 'FAILED'; verdict?: SupervisorVerdict; summary: string }[];
  awaitingDoctorReview: boolean;
}

export async function runVisitPipeline(
  visitId: string,
  options: { origin?: GeoPoint },
  context: AuditContext,
): Promise<PipelineResult> {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, deletedAt: null },
    include: { vitals: { orderBy: { recordedAt: 'desc' }, take: 1 }, symptoms: { where: { deletedAt: null } } },
  });
  if (!visit) throw new NotFoundError('Visit');

  const steps: PipelineResult['steps'] = [];

  // 1. Intake agent — record normalised snapshot.
  await prisma.agentExecution.create({
    data: {
      visitId,
      agentType: 'PATIENT_INTAKE',
      status: 'SUCCEEDED',
      output: { symptomCount: visit.symptoms.length, hasVitals: visit.vitals.length > 0 },
    },
  });
  steps.push({ agent: 'PATIENT_INTAKE', status: 'SUCCEEDED', summary: 'Visit data normalised.' });

  // 2. Safety screen — deterministic, runs before AI.
  const safety = await screenVisit(visitId, context);
  steps.push({
    agent: 'SAFETY',
    status: 'SUCCEEDED',
    summary: safety.isCritical
      ? `CRITICAL: ${safety.triggeredRules.map((r) => r.label).join('; ')}`
      : 'No critical red flags.',
  });

  // 3. Triage agent (with guideline retrieval + risk assessment), supervised.
  const triage = await runTriageForVisit(visitId, context);
  const triageVerdict = superviseTriage(triage.result, triage.safety);
  await annotateLatestAgentRun(visitId, 'TRIAGE', triageVerdict);
  steps.push({
    agent: 'TRIAGE',
    status: triageVerdict.approved ? 'SUCCEEDED' : 'FAILED',
    verdict: triageVerdict,
    summary: `${triage.result.severity} (confidence ${triage.result.confidence}). ${triageVerdict.notes}`,
  });

  // 4. Routing agent — resolves origin from options, user hospital, or first active hospital.
  let origin = options.origin;
  if (!origin) {
    if (context.userId) {
      const user = await prisma.user.findFirst({
        where: { id: context.userId },
        include: { hospital: true },
      });
      if (user?.hospital) {
        origin = {
          latitude: user.hospital.latitude,
          longitude: user.hospital.longitude,
        };
      }
    }
    if (!origin) {
      const firstHospital = await prisma.hospital.findFirst({
        where: { deletedAt: null, isActive: true },
      });
      if (firstHospital) {
        origin = {
          latitude: firstHospital.latitude,
          longitude: firstHospital.longitude,
        };
      }
    }
  }

  if (origin) {
    try {
      const latest = visit.vitals[0];
      const safetyInput: SafetyInput = {
        vitals: {
          oxygenSaturation: latest?.oxygenSaturation ?? undefined,
          isUnconscious: latest?.isUnconscious ?? false,
        },
        symptoms: visit.symptoms.map((s) => ({ name: s.name, severity: s.severity })),
      };
      // Re-derive severity for routing weighting (safety floor honoured by triage).
      void runSafetyScreen(safetyInput, new Date().toISOString());

      const routing = await routeVisit(
        {
          visitId,
          origin,
          requiredDepartment: triage.result.recommendedDepartment,
          requiredEquipment: [],
          severity: triage.result.severity,
          maxResults: 5,
        },
        context,
      );
      const routingVerdict = superviseRouting(routing.candidates);
      await annotateLatestAgentRun(visitId, 'ROUTING', routingVerdict);
      steps.push({
        agent: 'ROUTING',
        status: routingVerdict.approved ? 'SUCCEEDED' : 'FAILED',
        verdict: routingVerdict,
        summary: routing.candidates[0]
          ? `Top hospital: ${routing.candidates[0].hospitalName} (score ${routing.candidates[0].score}).`
          : 'No candidate hospitals available.',
      });
    } catch (err) {
      logger.error({ err, visitId }, 'Routing step failed in pipeline');
      steps.push({ agent: 'ROUTING', status: 'FAILED', summary: 'Routing unavailable.' });
    }
  }

  // Pipeline stops here — referral generation requires a doctor's review.
  await prisma.visit.update({ where: { id: visitId }, data: { status: 'UNDER_REVIEW' } });

  return { visitId, steps, awaitingDoctorReview: true };
}

async function annotateLatestAgentRun(
  visitId: string,
  agentType: 'TRIAGE' | 'ROUTING',
  verdict: SupervisorVerdict,
): Promise<void> {
  const latest = await prisma.agentExecution.findFirst({
    where: { visitId, agentType },
    orderBy: { createdAt: 'desc' },
  });
  if (latest) {
    await prisma.agentExecution.update({
      where: { id: latest.id },
      data: {
        supervisorVerdict: verdict as unknown as object,
        status: verdict.approved ? 'SUCCEEDED' : 'REJECTED_BY_SUPERVISOR',
      },
    });
  }
}
