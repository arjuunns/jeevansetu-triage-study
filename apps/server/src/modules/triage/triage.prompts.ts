import type { GuidelineCitation, SafetyScreenResult } from '@jeevansetu/types';

import { ESI_ALGORITHM_GUIDE } from './esi.guide.js';

export interface TriageContext {
  /** History fields are `undefined` when the source does not record them (shown as "not recorded"). */
  patient: { age: number; gender: string; allergies?: string[]; existingDiseases?: string[]; medications?: string[] };
  vitals: Record<string, number | boolean | undefined>;
  primarySymptom: string;
  secondarySymptoms: string[];
  chiefComplaint?: string;
  arrivalTransport?: string;
  safety: SafetyScreenResult;
}

/** Which optional evidence sections the user prompt includes (ablation switches). */
export interface PromptSections {
  safety: boolean;
  guidelines: boolean;
  /** The full curated ESI algorithm summary (research condition; off in production). */
  algorithm?: boolean;
  /** Show the "no critical red flags" verdict when no rule fires (default true; false = silent unless a rule fires). */
  safetyNotice?: boolean;
}

/**
 * System prompt for the triage agent. It is explicit about the non-negotiable
 * rules of the platform: the model assists, it never decides; it must stay
 * grounded in the provided data and guidelines; and the deterministic safety
 * verdict is authoritative.
 */
export const TRIAGE_SYSTEM_PROMPT = `You are a clinical triage assistant for JeevanSetu, a hospital triage and routing platform in India.

NON-NEGOTIABLE RULES:
1. You ASSIST clinicians. You NEVER make autonomous or final medical decisions. A human doctor reviews and approves every output.
2. A deterministic safety engine runs BEFORE you. If it flags the patient CRITICAL, you MUST NOT downgrade below CRITICAL. Its verdict overrides yours.
3. Ground every conclusion ONLY in the provided vitals, symptoms, history, and retrieved guideline excerpts. Do NOT invent findings, lab values, or guidelines. If evidence is insufficient, say so and lower your confidence.
4. Prefer over-triage to under-triage when uncertain. Patient safety outweighs efficiency.
5. Cite the relevant retrieved guideline(s) in your reasoning when they informed your assessment.

Return ONLY the structured assessment in the required schema. Confidence must honestly reflect evidence quality (0 = no basis, 1 = unambiguous).`;

export function buildTriageUserPrompt(
  ctx: TriageContext,
  citations: GuidelineCitation[],
  sections: PromptSections = { safety: true, guidelines: true },
): string {
  const guidelineBlock =
    citations.length > 0
      ? citations
          .map(
            (c, i) =>
              `==================================================\n` +
              `GUIDELINE EXCERPT [${i + 1}]\n` +
              `==================================================\n` +
              `• Source: ${c.source}\n` +
              `• Title: ${c.title}\n` +
              `• Content Excerpt:\n${c.snippet.trim()}\n` +
              `==================================================`
          )
          .join('\n\n')
      : 'No guideline excerpts were retrieved. Rely on the patient data and standard ESI/MTS triage principles, and lower confidence accordingly.';

  const safetyBlock = ctx.safety.isCritical
    ? `SAFETY ENGINE VERDICT: CRITICAL (authoritative). Triggered rules: ${ctx.safety.triggeredRules
        .map((r) => r.label)
        .join('; ')}. You must not assign a severity below CRITICAL.`
    : 'SAFETY ENGINE VERDICT: no critical red flags detected. Assess normally.';

  const optionalBlocks = [
    sections.algorithm ? `ESI ALGORITHM REFERENCE\n${ESI_ALGORITHM_GUIDE.replace(/^## /gm, '')}` : null,
    sections.safety && (ctx.safety.isCritical || sections.safetyNotice !== false) ? safetyBlock : null,
    sections.guidelines ? `RETRIEVED GUIDELINE EXCERPTS\n${guidelineBlock}` : null,
  ]
    .filter(Boolean)
    .map((block) => `${block}\n\n`)
    .join('');

  return `PATIENT
Age: ${ctx.patient.age}; Gender: ${ctx.patient.gender}${ctx.arrivalTransport ? `\nArrival: ${ctx.arrivalTransport}` : ''}
Existing conditions: ${formatList(ctx.patient.existingDiseases)}
Allergies: ${formatList(ctx.patient.allergies)}
Current medications: ${formatList(ctx.patient.medications)}

VITALS
${formatVitals(ctx.vitals)}

PRESENTATION
Chief complaint: ${ctx.chiefComplaint ?? 'not specified'}
Primary symptom: ${ctx.primarySymptom}
Secondary symptoms: ${ctx.secondarySymptoms.join(', ') || 'none'}

${optionalBlocks}TASK
Produce a structured triage assessment: severity, ESI level (1-5), confidence, clinical reasoning (referencing the data and any guideline excerpts by number), the most likely conditions with likelihood, the recommended hospital department, recommended initial tests, risk factors, and red-flag symptoms the reviewing doctor should confirm.`;
}

function formatList(values?: string[]): string {
  if (values === undefined) return 'not recorded';
  return values.join(', ') || 'none reported';
}

function formatVitals(vitals: Record<string, number | boolean | undefined>): string {
  const labels: Record<string, string> = {
    temperatureC: 'Temperature (°C)',
    oxygenSaturation: 'SpO₂ (%)',
    heartRate: 'Heart rate (bpm)',
    respiratoryRate: 'Respiratory rate (/min)',
    systolicBp: 'Systolic BP (mmHg)',
    diastolicBp: 'Diastolic BP (mmHg)',
    glasgowComaScale: 'GCS',
    isUnconscious: 'Unconscious',
    painScore: 'Pain (0-10)',
  };
  const lines = Object.entries(vitals)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${labels[k] ?? k}: ${v}`);
  return lines.length ? lines.join('\n') : 'No vitals recorded.';
}
