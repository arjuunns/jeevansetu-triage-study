import type { ReferralPayload, SeverityLevel } from '@jeevansetu/types';

/**
 * Phase 11 — HL7 FHIR R4 referral builder.
 *
 * Produces a FHIR transaction Bundle containing a Patient, a ServiceRequest
 * (the referral), and an Encounter, cross-referenced by fullUrl. This is a
 * standards-compliant interoperability artifact that receiving hospital systems
 * can ingest. Priority is mapped from JeevanSetu severity.
 */

const SEVERITY_TO_FHIR_PRIORITY: Record<SeverityLevel, 'stat' | 'urgent' | 'asap' | 'routine'> = {
  CRITICAL: 'stat',
  HIGH: 'urgent',
  MODERATE: 'asap',
  LOW: 'routine',
};

const GENDER_MAP: Record<string, 'male' | 'female' | 'other' | 'unknown'> = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
  UNKNOWN: 'unknown',
};

export function buildFhirReferral(payload: ReferralPayload): Record<string, unknown> {
  const patientUrn = `urn:uuid:patient-${payload.visitId}`;
  const encounterUrn = `urn:uuid:encounter-${payload.visitId}`;
  const requestUrn = `urn:uuid:referral-${payload.referralId}`;

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    timestamp: payload.generatedAt,
    identifier: { system: 'https://jeevansetu.health/referral', value: payload.referralId },
    entry: [
      {
        fullUrl: patientUrn,
        resource: {
          resourceType: 'Patient',
          name: [{ text: payload.patient.name }],
          gender: GENDER_MAP[payload.patient.gender] ?? 'unknown',
          telecom: payload.patient.phone
            ? [{ system: 'phone', value: payload.patient.phone }]
            : undefined,
          extension: [
            {
              url: 'https://jeevansetu.health/fhir/age',
              valueInteger: payload.patient.age,
            },
            {
              url: 'https://jeevansetu.health/fhir/bloodGroup',
              valueString: payload.patient.bloodGroup,
            },
          ],
        },
        request: { method: 'POST', url: 'Patient' },
      },
      {
        fullUrl: encounterUrn,
        resource: {
          resourceType: 'Encounter',
          status: 'in-progress',
          class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'emergency' },
          subject: { reference: patientUrn },
          reasonCode: [{ text: payload.clinical.chiefComplaint ?? payload.clinical.primarySymptom }],
        },
        request: { method: 'POST', url: 'Encounter' },
      },
      {
        fullUrl: requestUrn,
        resource: {
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          priority: SEVERITY_TO_FHIR_PRIORITY[payload.clinical.severity],
          subject: { reference: patientUrn },
          encounter: { reference: encounterUrn },
          authoredOn: payload.approval.approvedAt,
          requester: { display: payload.approval.doctorName },
          performer: [{ display: payload.destination.hospitalName }],
          code: { text: `Referral to ${payload.destination.department}` },
          reasonCode: [
            { text: payload.clinical.primarySymptom },
            ...payload.clinical.possibleConditions.map((c) => ({ text: c })),
          ],
          note: [
            { text: `AI reasoning (doctor-approved): ${payload.clinical.aiReasoning}` },
            ...(payload.approval.justification
              ? [{ text: `Doctor justification: ${payload.approval.justification}` }]
              : []),
            ...payload.citations.map((c) => ({ text: `Guideline [${c.source}] ${c.title}: ${c.snippet}` })),
          ],
        },
        request: { method: 'POST', url: 'ServiceRequest' },
      },
    ],
  };
}
