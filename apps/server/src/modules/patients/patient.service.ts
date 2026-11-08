import type { FullIntake, PatientIntake, SymptomReport, VitalSigns } from '@jeevansetu/types';

import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { runVisitPipeline } from '../agents/orchestrator.js';
import { recordAudit, type AuditContext } from '../audit/audit.service.js';
import { screenVisit } from '../safety/safety.service.js';

import { signDocUrl } from '../../lib/storage.js';

/**
 * Phase 4 — Patient Intake Module.
 *
 * The nurse intake flow registers a patient, opens a visit, records vitals and
 * symptoms in a single transaction, then runs the deterministic safety screen
 * (Phase 5 runs BEFORE any AI). All writes are audited.
 */

export interface FullIntakeResult {
  patientId: string;
  visitId: string;
  patientName: string;
  hospitalName: string;
  safety: Awaited<ReturnType<typeof screenVisit>>;
}

export async function createFullIntake(
  data: FullIntake,
  context: AuditContext,
): Promise<FullIntakeResult> {
  const { patient, vitals, symptoms, chiefComplaint } = data;

  const { patientId, visitId } = await prisma.$transaction(async (tx) => {
    const createdPatient = await tx.patient.create({
      data: {
        ...patient,
        registeredById: context.userId ?? undefined,
        createdBy: context.userId ?? undefined,
      },
    });

    const visit = await tx.visit.create({
      data: {
        patientId: createdPatient.id,
        chiefComplaint,
        status: 'REGISTERED',
        createdBy: context.userId ?? undefined,
        vitals: { create: mapVitals(vitals, context.userId) },
        symptoms: { create: mapSymptoms(symptoms, context.userId) },
      },
    });

    return { patientId: createdPatient.id, visitId: visit.id };
  });

  await recordAudit({
    action: 'PATIENT_CREATED',
    entityType: 'Patient',
    entityId: patientId,
    newState: patient,
    context,
  });
  await recordAudit({
    action: 'VISIT_CREATED',
    entityType: 'Visit',
    entityId: visitId,
    newState: { patientId, chiefComplaint },
    context,
  });

  // Safety layer executes immediately at intake, before any AI.
  const safety = await screenVisit(visitId, context);

  // Automatically trigger the AI triage pipeline (which retrieves guidelines and runs risk assessment)
  // in the background, so the patient is successfully triaged and visible in the Doctor Review Queue.
  runVisitPipeline(visitId, {}, context).catch((err) => {
    logger.error({ err, visitId }, 'Failed to run AI triage pipeline on patient intake');
  });

  const user = context.userId ? await prisma.user.findFirst({
    where: { id: context.userId, deletedAt: null },
    include: { hospital: true },
  }) : null;
  const hospitalName = user?.hospital?.name ?? 'Network Hospital';

  return { patientId, visitId, patientName: patient.name, hospitalName, safety };
}


export async function registerPatient(data: PatientIntake, context: AuditContext) {
  const patient = await prisma.patient.create({
    data: {
      ...data,
      registeredById: context.userId ?? undefined,
      createdBy: context.userId ?? undefined,
    },
  });
  await recordAudit({
    action: 'PATIENT_CREATED',
    entityType: 'Patient',
    entityId: patient.id,
    newState: data,
    context,
  });
  return patient;
}

export async function recordVitals(visitId: string, vitals: VitalSigns, context: AuditContext) {
  const visit = await prisma.visit.findFirst({ where: { id: visitId, deletedAt: null } });
  if (!visit) throw new NotFoundError('Visit');

  const created = await prisma.vitalSigns.create({
    data: { visitId, ...mapVitalsSingle(vitals, context.userId) },
  });
  await recordAudit({
    action: 'VITALS_RECORDED',
    entityType: 'Visit',
    entityId: visitId,
    newState: vitals,
    context,
  });
  // Re-run safety after new vitals (deterministic, idempotent on stable input).
  await screenVisit(visitId, context);
  return created;
}

export async function recordSymptoms(
  visitId: string,
  report: SymptomReport,
  context: AuditContext,
) {
  const visit = await prisma.visit.findFirst({ where: { id: visitId, deletedAt: null } });
  if (!visit) throw new NotFoundError('Visit');

  await prisma.symptom.createMany({ data: mapSymptoms(report, context.userId).map((s) => ({ ...s, visitId })) });
  await recordAudit({
    action: 'SYMPTOMS_RECORDED',
    entityType: 'Visit',
    entityId: visitId,
    newState: report,
    context,
  });
  await screenVisit(visitId, context);
  return prisma.symptom.findMany({ where: { visitId, deletedAt: null } });
}

export async function getPatient(patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, deletedAt: null },
    include: {
      medicalHistory: { where: { deletedAt: null } },
      visits: { where: { deletedAt: null }, orderBy: { arrivalAt: 'desc' }, take: 20 },
    },
  });
  if (!patient) throw new NotFoundError('Patient');
  return patient;
}

export async function getVisit(visitId: string) {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, deletedAt: null },
    include: {
      patient: true,
      vitals: { orderBy: { recordedAt: 'desc' } },
      symptoms: { where: { deletedAt: null } },
      assessment: { include: { reasoning: true, review: true, citations: true } },
      routing: {
        include: {
          selectedHospital: true,
        },
      },
      referral: {
        include: {
          documents: true,
          hospital: true,
        },
      },
      agentRuns: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!visit) throw new NotFoundError('Visit');

  if (visit.referral?.documents) {
    const signedDocs = await Promise.all(
      visit.referral.documents.map(async (doc) => ({
        ...doc,
        url: await signDocUrl(doc.url),
      }))
    );
    visit.referral = {
      ...visit.referral,
      documents: signedDocs,
    };
  }

  return visit;
}

export async function listPatients(page: number, pageSize: number, search?: string) {
  const where = {
    deletedAt: null,
    ...(search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { phone: { contains: search } }] }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.patient.count({ where }),
  ]);
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

// ── mappers ──────────────────────────────────────────────────────────────────

function mapVitalsSingle(v: VitalSigns, userId?: string | null) {
  return {
    temperatureC: v.temperatureC,
    oxygenSaturation: v.oxygenSaturation,
    heartRate: v.heartRate,
    respiratoryRate: v.respiratoryRate,
    systolicBp: v.systolicBp,
    diastolicBp: v.diastolicBp,
    glasgowComaScale: v.glasgowComaScale,
    isUnconscious: v.isUnconscious,
    createdBy: userId ?? undefined,
  };
}

function mapVitals(v: VitalSigns, userId?: string | null) {
  return [mapVitalsSingle(v, userId)];
}

function mapSymptoms(report: SymptomReport, userId?: string | null) {
  return [
    { ...stripSymptom(report.primarySymptom), isPrimary: true, createdBy: userId ?? undefined },
    ...report.secondarySymptoms.map((s) => ({
      ...stripSymptom(s),
      isPrimary: false,
      createdBy: userId ?? undefined,
    })),
  ];
}

function stripSymptom(s: SymptomReport['primarySymptom']) {
  return { name: s.name, severity: s.severity, duration: s.duration, notes: s.notes };
}
