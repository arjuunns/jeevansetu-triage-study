import { createHash } from 'node:crypto';

import type { ReferralPayload } from '@jeevansetu/types';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { putObject, signDocUrl } from '../../lib/storage.js';
import { recordAudit, type AuditContext } from '../audit/audit.service.js';
import { dispatchNotification } from '../notifications/notification.service.js';
import { buildFhirReferral } from './fhir.js';
import { renderReferralPdf } from './pdf.js';
import { generateQrPng } from './qr.js';

/**
 * Phase 11 — Referral Generation service.
 *
 * Assembles the doctor-approved referral snapshot, then generates three
 * artifacts — a PDF, an HL7 FHIR R4 Bundle, and a QR code — persisting each as a
 * ReferralDocument. A referral can only be generated after a doctor has reviewed
 * (not rejected) the assessment; the AI never produces a referral unsupervised.
 */
export async function generateReferral(
  visitId: string,
  selectedHospitalId: string | undefined,
  context: AuditContext,
) {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, deletedAt: null },
    include: {
      patient: true,
      vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
      symptoms: { where: { deletedAt: null } },
      assessment: {
        include: { reasoning: true, review: { include: { doctor: true } }, citations: true },
      },
      routing: true,
    },
  });
  if (!visit) throw new NotFoundError('Visit');

  const assessment = visit.assessment;
  if (!assessment) throw new ValidationError('Visit has no triage assessment to refer from');
  const review = assessment.review;
  if (!review) throw new ValidationError('A doctor must review the assessment before a referral is generated');
  if (review.action === 'REJECT') throw new ConflictError('Cannot generate a referral for a rejected assessment');

  const hospitalId =
    selectedHospitalId ?? visit.routing?.selectedHospitalId ?? undefined;
  const hospital = hospitalId
    ? await prisma.hospital.findUnique({ where: { id: hospitalId } })
    : null;

  const referral = await prisma.referral.upsert({
    where: { visitId },
    create: { visitId, hospitalId: hospital?.id, status: 'DRAFT', payload: {} },
    update: { hospitalId: hospital?.id },
  });

  const primary = visit.symptoms.find((s) => s.isPrimary) ?? visit.symptoms[0];
  const latest = visit.vitals[0];

  const payload: ReferralPayload = {
    referralId: referral.id,
    visitId,
    generatedAt: new Date().toISOString(),
    patient: {
      name: visit.patient.name,
      age: visit.patient.age,
      gender: visit.patient.gender,
      bloodGroup: visit.patient.bloodGroup,
      phone: visit.patient.phone ?? undefined,
    },
    clinical: {
      chiefComplaint: visit.chiefComplaint ?? undefined,
      primarySymptom: primary?.name ?? 'unspecified',
      secondarySymptoms: visit.symptoms.filter((s) => !s.isPrimary).map((s) => s.name),
      severity: assessment.finalSeverity ?? assessment.aiSeverity ?? 'MODERATE',
      vitals: {
        temperatureC: latest?.temperatureC ?? undefined,
        oxygenSaturation: latest?.oxygenSaturation ?? undefined,
        heartRate: latest?.heartRate ?? undefined,
        respiratoryRate: latest?.respiratoryRate ?? undefined,
        systolicBp: latest?.systolicBp ?? undefined,
        diastolicBp: latest?.diastolicBp ?? undefined,
      },
      aiReasoning: assessment.reasoning?.reasoningText ?? 'Not available',
      possibleConditions: extractConditions(assessment.possibleConditions),
      riskFactors: assessment.riskFactors,
    },
    approval: {
      doctorName: doctorName(review.doctor),
      doctorId: review.doctorId,
      action: review.action,
      justification: review.justification ?? undefined,
      approvedAt: review.reviewedAt.toISOString(),
    },
    destination: {
      hospitalName: hospital?.name ?? 'To be determined',
      hospitalId: hospital?.id ?? '',
      department: review.overrideDepartment ?? assessment.recommendedDepartment ?? 'General Medicine',
      address: hospital?.address,
    },
    citations: assessment.citations.map((c) => ({ source: c.source, title: c.title, snippet: c.snippet })),
  };

  // Generate the three artifacts.
  const verifyUrl = `${env.WEB_ORIGIN}/referrals/verify/${referral.referralCode}`;
  const qrPng = await generateQrPng(verifyUrl);
  const pdfBuffer = await renderReferralPdf(payload, qrPng);
  const fhir = buildFhirReferral(payload);
  const fhirBuffer = Buffer.from(JSON.stringify(fhir, null, 2));

  const [pdfObj, fhirObj, qrObj] = await Promise.all([
    putObject(`referrals/${referral.id}`, 'referral.pdf', pdfBuffer, 'application/pdf'),
    putObject(`referrals/${referral.id}`, 'referral.fhir.json', fhirBuffer, 'application/fhir+json'),
    putObject(`referrals/${referral.id}`, 'referral-qr.png', qrPng, 'image/png'),
  ]);

  await prisma.$transaction(async (tx) => {
    await tx.referral.update({
      where: { id: referral.id },
      data: { status: 'GENERATED', payload: payload as unknown as object, updatedBy: context.userId ?? undefined },
    });
    await tx.referralDocument.deleteMany({ where: { referralId: referral.id } });
    await tx.referralDocument.createMany({
      data: [
        { referralId: referral.id, format: 'PDF', url: pdfObj.url, checksum: pdfObj.checksum, sizeBytes: pdfObj.sizeBytes },
        { referralId: referral.id, format: 'FHIR_JSON', url: fhirObj.url, checksum: fhirObj.checksum, sizeBytes: fhirObj.sizeBytes },
        { referralId: referral.id, format: 'QR_CODE', url: qrObj.url, checksum: qrObj.checksum, sizeBytes: qrObj.sizeBytes },
      ],
    });
    await tx.visit.update({ where: { id: visitId }, data: { status: 'REFERRED' } });
    await tx.agentExecution.create({
      data: { visitId, agentType: 'REFERRAL_GENERATION', status: 'SUCCEEDED', output: { referralId: referral.id } },
    });
    if (hospital) {
      await tx.notification.create({
        data: {
          type: 'REFERRAL_GENERATED',
          channel: 'IN_APP',
          status: 'PENDING',
          title: 'New referral received',
          body: `Referral ${referral.referralCode} for ${payload.patient.name} (${payload.clinical.severity}).`,
          payload: { referralId: referral.id, hospitalId: hospital.id },
        },
      });
    }
  });

  await recordAudit({
    action: 'REFERRAL_GENERATED',
    entityType: 'Referral',
    entityId: referral.id,
    newState: { visitId, hospitalId: hospital?.id, severity: payload.clinical.severity },
    context,
  });

  if (hospital?.email) {
    // Resolve referring hospital name
    let referringHospitalName = 'Referring Hospital';
    if (context.userId) {
      const referringUser = await prisma.user.findFirst({
        where: { id: context.userId, deletedAt: null },
        include: { hospital: true },
      });
      if (referringUser?.hospital) {
        referringHospitalName = referringUser.hospital.name;
      }
    }

    dispatchNotification({
      type: 'REFERRAL_GENERATED',
      channel: 'EMAIL',
      title: `Patient Referral from ${referringHospitalName}`,
      body: `Dear Clinician,\n\nA new patient referral has been generated from ${referringHospitalName} prior to their arrival.\n\nPatient Name: ${payload.patient.name}\nClinical Severity: ${payload.clinical.severity}\nPrimary Symptom: ${payload.clinical.primarySymptom}\nReferral Code: ${referral.referralCode}\n\nPlease prepare for the patient's arrival. Details are available in the clinician dashboard.`,
      to: hospital.email,
      payload: { referralId: referral.id, hospitalId: hospital.id },
    }).catch((err) => {
      logger.error({ err, referralId: referral.id }, 'Failed to send referral email notification');
    });
  }

  return {
    referralId: referral.id,
    referralCode: referral.referralCode,
    verifyUrl,
    documents: { pdf: pdfObj.url, fhir: fhirObj.url, qr: qrObj.url },
    fhir,
    payload,
  };
}

export async function getReferral(visitId: string) {
  const referral = await prisma.referral.findFirst({
    where: { visitId, deletedAt: null },
    include: { documents: true, hospital: true },
  });
  if (!referral) throw new NotFoundError('Referral');

  referral.documents = await Promise.all(
    referral.documents.map(async (doc) => ({
      ...doc,
      url: await signDocUrl(doc.url),
    }))
  );

  return referral;
}

function extractConditions(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((c) => (typeof c === 'object' && c && 'condition' in c ? String((c as { condition: unknown }).condition) : null))
    .filter((c): c is string => Boolean(c));
}

function doctorName(doctor: { firstName: string | null; lastName: string | null; email: string }): string {
  const name = [doctor.firstName, doctor.lastName].filter(Boolean).join(' ');
  return name || doctor.email;
}

/** Stable checksum helper exposed for verification flows. */
export function checksumOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
