import { z } from 'zod';

import { SEVERITY_LEVELS, ESI_LEVELS } from './enums.js';

/**
 * Strict schema for the AI triage engine's output (Phase 6). The model is
 * forced to emit exactly this shape; anything else fails validation and is
 * retried. This is the structured-output / hallucination-prevention boundary.
 */
export const triageResultSchema = z.object({
  severity: z.enum(SEVERITY_LEVELS),
  esiLevel: z.number().int().min(1).max(5).describe('ESI acuity level 1..5 the model assigns') as z.ZodType<1 | 2 | 3 | 4 | 5>,
  /** Model self-reported confidence in [0,1]. */
  confidence: z.number().min(0).max(1),
  /** Human-readable clinical reasoning. Required — no silent recommendations. */
  reasoning: z.string().min(10),
  possibleConditions: z
    .array(
      z.object({
        condition: z.string().min(1),
        likelihood: z.enum(['LOW', 'MODERATE', 'HIGH']),
        icd10: z.string().optional(),
      }),
    )
    .min(1),
  recommendedDepartment: z.string().min(1),
  recommendedTests: z.array(z.string()).default([]),
  riskFactors: z.array(z.string()).default([]),
  /** Red-flag symptoms the model wants the reviewing doctor to confirm. */
  redFlags: z.array(z.string()).default([]),
});
export type TriageResult = z.infer<typeof triageResultSchema>;

/** A retrieved guideline citation attached to a triage assessment (Phase 7). */
export const guidelineCitationSchema = z.object({
  guidelineId: z.string(),
  source: z.string(),
  title: z.string(),
  chunkId: z.string(),
  snippet: z.string(),
  page: z.number().int().optional(),
  /** Cosine similarity / relevance score in [0,1]. */
  score: z.number().min(0).max(1),
});
export type GuidelineCitation = z.infer<typeof guidelineCitationSchema>;

export const ESI_LEVEL_VALUES = ESI_LEVELS;

/**
 * Full triage assessment as surfaced to the doctor: the AI result, the
 * deterministic safety overlay, and the supporting evidence.
 */
export interface TriageAssessmentView {
  id: string;
  visitId: string;
  aiResult: TriageResult;
  /** Set when the deterministic safety layer overrode the AI severity. */
  safetyOverride: {
    triggered: boolean;
    forcedSeverity: 'CRITICAL' | null;
    triggeredRules: string[];
  };
  citations: GuidelineCitation[];
  createdAt: string;
}
