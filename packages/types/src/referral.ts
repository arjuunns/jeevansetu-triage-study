import type { ReferralDocFormat, SeverityLevel } from './enums.js';

/**
 * The data assembled into a referral document (Phase 11). This is the
 * doctor-approved snapshot; nothing here is AI-authored without sign-off.
 */
export interface ReferralPayload {
  referralId: string;
  visitId: string;
  generatedAt: string;
  patient: {
    name: string;
    age: number;
    gender: string;
    bloodGroup: string;
    phone?: string;
  };
  clinical: {
    chiefComplaint?: string;
    primarySymptom: string;
    secondarySymptoms: string[];
    severity: SeverityLevel;
    vitals: Record<string, number | boolean | undefined>;
    aiReasoning: string;
    possibleConditions: string[];
    riskFactors: string[];
  };
  approval: {
    doctorName: string;
    doctorId: string;
    action: string;
    justification?: string;
    approvedAt: string;
  };
  destination: {
    hospitalName: string;
    hospitalId: string;
    department: string;
    address?: string;
    distanceKm?: number;
  };
  citations: { source: string; title: string; snippet: string }[];
}

/** A persisted referral document artifact. */
export interface ReferralDocument {
  id: string;
  referralId: string;
  format: ReferralDocFormat;
  /** S3 object URL (PDF) or inline payload reference (FHIR/QR). */
  url: string;
  checksum: string;
  createdAt: string;
}
