import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { SafetyScreenResult } from '@jeevansetu/types';

import type { SafetyInput } from '../src/modules/safety/safety.engine.js';
import type { TriageContext } from '../src/modules/triage/triage.prompts.js';

/**
 * Shared loader for the research cohort built by research/build_cohort.py.
 *
 * Only `input` (what a nurse knows at triage) may reach the pipeline. The
 * converters below take a `TriageInput`, never a whole case, so labels and
 * outcomes cannot leak into prompts by accident.
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_COHORT = path.join(REPO_ROOT, 'data/mimic_ed_cohort.json');
export const DEFAULT_RETRIEVAL_CACHE = path.join(REPO_ROOT, 'research/retrieval_cache.json');

/** Fixed timestamp so safety-screen output is byte-identical across runs. */
export const SAFETY_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export interface TriageInput {
  age: number;
  gender: string;
  arrivalTransport: string;
  chiefComplaint: string;
  vitals: {
    temperatureC?: number;
    heartRate?: number;
    respiratoryRate?: number;
    oxygenSaturation?: number;
    systolicBp?: number;
    diastolicBp?: number;
  };
  painScore: number | null;
}

export interface CohortCase {
  stayId: string;
  subjectId: string;
  input: TriageInput;
  label: { esi: number };
  outcome: { disposition: string; dischargeDiagnoses: string[] };
}

export function loadCohort(file = DEFAULT_COHORT): CohortCase[] {
  return JSON.parse(fs.readFileSync(file, 'utf-8')).cases;
}

/** MIMIC chief complaints are comma-separated lists, e.g. "Abd pain, Vomiting". */
function splitComplaint(chiefComplaint: string): string[] {
  return chiefComplaint
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toSafetyInput(input: TriageInput): SafetyInput {
  return {
    // MIMIC does not record consciousness at triage; the flag only matters when true.
    vitals: { ...input.vitals, isUnconscious: false },
    symptoms: splitComplaint(input.chiefComplaint).map((name) => ({ name })),
  };
}

export function toTriageContext(input: TriageInput, safety: SafetyScreenResult): TriageContext {
  const [primary, ...secondary] = splitComplaint(input.chiefComplaint);
  return {
    // History, allergies and medications are not recorded at MIMIC triage.
    patient: { age: input.age, gender: input.gender },
    vitals: { ...input.vitals, painScore: input.painScore ?? undefined },
    primarySymptom: primary ?? input.chiefComplaint,
    secondarySymptoms: secondary,
    chiefComplaint: input.chiefComplaint,
    arrivalTransport: input.arrivalTransport,
    safety,
  };
}
