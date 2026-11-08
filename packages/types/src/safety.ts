import type { SeverityLevel } from './enums.js';

/** Stable identifiers for each deterministic safety rule (Phase 5). */
export const SAFETY_RULE_IDS = [
  'CARDIAC_ARREST',
  'STROKE_SIGNS',
  'SEVERE_TRAUMA',
  'UNCONSCIOUS',
  'CRITICAL_HYPOXIA',
  'SEVERE_HYPOXIA_WITH_CHEST_PAIN',
  'SEVERE_BLEEDING',
  'SEVERE_BRADYCARDIA',
  'SEVERE_TACHYCARDIA',
  'SEVERE_HYPOTENSION',
  'HYPERTENSIVE_CRISIS',
  'SEVERE_RESPIRATORY_DISTRESS',
  'HYPERPYREXIA',
  'SEVERE_HYPOTHERMIA',
] as const;
export type SafetyRuleId = (typeof SAFETY_RULE_IDS)[number];

/** A single rule that fired during deterministic screening. */
export interface TriggeredSafetyRule {
  ruleId: SafetyRuleId;
  label: string;
  /** Plain-language explanation of why the rule fired, for the audit trail. */
  rationale: string;
  /** The measured/observed values that satisfied the rule's condition. */
  evidence: Record<string, number | boolean | string>;
}

/**
 * Output of the deterministic safety engine. When `isCritical` is true the
 * downstream pipeline must treat the patient as CRITICAL regardless of what the
 * AI concludes — rules always override AI.
 */
export interface SafetyScreenResult {
  isCritical: boolean;
  /** Forced floor severity. CRITICAL when any rule fires, else null. */
  forcedSeverity: Extract<SeverityLevel, 'CRITICAL'> | null;
  triggeredRules: TriggeredSafetyRule[];
  /** Immediate, deterministic instructions for the bedside worker. */
  recommendedActions: string[];
  evaluatedAt: string;
}
