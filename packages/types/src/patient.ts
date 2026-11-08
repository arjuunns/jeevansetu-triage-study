import { z } from 'zod';

import { BLOOD_GROUPS, GENDERS, SYMPTOM_SEVERITIES } from './enums.js';

/**
 * Patient demographic & medical-background intake (Phase 4).
 * Validation bounds are clinically plausible guards, not diagnostic limits.
 */
export const patientIntakeSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(120),
  age: z.number().int().min(0).max(130),
  gender: z.enum(GENDERS),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,15}$/, 'Invalid phone number')
    .optional(),
  guardianName: z.string().trim().optional(),
  guardianPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{7,15}$/, 'Invalid phone number')
    .optional(),
  bloodGroup: z.enum(BLOOD_GROUPS).default('UNKNOWN'),
  heightCm: z.number().positive().max(280).optional(),
  weightKg: z.number().positive().max(500).optional(),
  allergies: z.array(z.string().trim().min(1)).default([]),
  existingDiseases: z.array(z.string().trim().min(1)).default([]),
  medications: z.array(z.string().trim().min(1)).default([]),
});
export type PatientIntake = z.infer<typeof patientIntakeSchema>;

/**
 * Vital signs (Phase 4). Each measurement is bounded to physiologically
 * survivable extremes; out-of-range inputs are rejected before they reach the
 * safety engine so that we never feed it impossible data.
 */
export const vitalSignsSchema = z.object({
  /** Body temperature in degrees Celsius. */
  temperatureC: z.number().min(20).max(45).optional(),
  /** Peripheral oxygen saturation (SpO2) as a percentage. */
  oxygenSaturation: z.number().int().min(0).max(100).optional(),
  /** Heart rate in beats per minute. */
  heartRate: z.number().int().min(0).max(300).optional(),
  /** Respiratory rate in breaths per minute. */
  respiratoryRate: z.number().int().min(0).max(80).optional(),
  /** Systolic blood pressure in mmHg. */
  systolicBp: z.number().int().min(40).max(300).optional(),
  /** Diastolic blood pressure in mmHg. */
  diastolicBp: z.number().int().min(20).max(200).optional(),
  /** Glasgow Coma Scale total, 3 (deep coma) .. 15 (fully alert). */
  glasgowComaScale: z.number().int().min(3).max(15).optional(),
  /** True if the patient is unresponsive/unconscious on assessment. */
  isUnconscious: z.boolean().default(false),
});
export type VitalSigns = z.infer<typeof vitalSignsSchema>;

/** A single reported symptom. */
export const symptomSchema = z.object({
  name: z.string().trim().min(1).max(120),
  severity: z.enum(SYMPTOM_SEVERITIES).default('MODERATE'),
  isPrimary: z.boolean().default(false),
  /** Free-text or ISO-8601 duration, e.g. "3 days", "PT2H". */
  duration: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type Symptom = z.infer<typeof symptomSchema>;

/** The complete symptom payload for a visit. */
export const symptomReportSchema = z
  .object({
    primarySymptom: symptomSchema,
    secondarySymptoms: z.array(symptomSchema).default([]),
  })
  .transform((report) => ({
    ...report,
    primarySymptom: { ...report.primarySymptom, isPrimary: true },
  }));
export type SymptomReport = z.infer<typeof symptomReportSchema>;

/**
 * One-shot intake payload: register a patient and open a visit with vitals and
 * symptoms in a single transaction. Used by the nurse intake form.
 */
export const fullIntakeSchema = z.object({
  patient: patientIntakeSchema,
  vitals: vitalSignsSchema,
  symptoms: symptomReportSchema,
  chiefComplaint: z.string().trim().max(1000).optional(),
});
export type FullIntake = z.infer<typeof fullIntakeSchema>;
