import type {
  SafetyScreenResult,
  SafetyRuleId,
  Symptom,
  TriggeredSafetyRule,
  VitalSigns,
} from '@jeevansetu/types';

/**
 * Phase 5 — Deterministic Medical Safety Engine.
 *
 * This module is intentionally free of AI, randomness, and I/O. It is a pure,
 * exhaustively-testable function that encodes hard clinical red-flag rules.
 *
 * Contract: if ANY rule fires, the patient is CRITICAL and that verdict OVERRIDES
 * whatever the AI triage engine later concludes. The safety screen always runs
 * BEFORE the AI, and its output is non-negotiable. We deliberately err toward
 * over-triage (false positives are acceptable; missing a life-threat is not).
 */

export interface SafetyInput {
  vitals: VitalSigns;
  /** Rules read symptom names only; severity is accepted for callers that have it. */
  symptoms: (Pick<Symptom, 'name'> & Partial<Pick<Symptom, 'severity'>>)[];
}

/** Keyword groups used to detect red-flag presentations from free-text symptoms. */
const SYMPTOM_KEYWORDS = {
  cardiacArrest: ['cardiac arrest', 'no pulse', 'pulseless', 'not breathing', 'apnea', 'apnoea'],
  chestPain: ['chest pain', 'chest pressure', 'chest tightness', 'angina'],
  stroke: [
    'facial droop',
    'face drooping',
    'slurred speech',
    'aphasia',
    'one-sided weakness',
    'one sided weakness',
    'hemiparesis',
    'sudden numbness',
    'stroke',
    'fast positive',
  ],
  trauma: [
    'major trauma',
    'severe trauma',
    'head injury',
    'penetrating',
    'gunshot',
    'stab wound',
    'amputation',
    'crush injury',
    'fall from height',
    'road accident',
    'rta',
  ],
  bleeding: [
    'severe bleeding',
    'hemorrhage',
    'haemorrhage',
    'uncontrolled bleeding',
    'massive bleeding',
    'exsanguination',
    'spurting blood',
  ],
  unconscious: ['unconscious', 'unresponsive', 'not responding', 'collapsed', 'loss of consciousness'],
  respiratoryDistress: [
    'severe breathlessness',
    'gasping',
    'cannot breathe',
    "can't breathe",
    'respiratory distress',
    'choking',
    'stridor',
  ],
} as const;

function normalize(symptoms: SafetyInput['symptoms']): string[] {
  return symptoms.map((s) => s.name.trim().toLowerCase());
}

/**
 * A keyword matches only where a word starts, so "rta" does not fire inside
 * "aorta"; suffixes are allowed so plurals ("stab wounds") still match.
 */
function containsKeyword(term: string, needle: string): boolean {
  let from = term.indexOf(needle);
  while (from !== -1) {
    if (from === 0 || !/[a-z0-9]/.test(term[from - 1]!)) return true;
    from = term.indexOf(needle, from + 1);
  }
  return false;
}

function anyMatch(haystack: string[], needles: readonly string[]): string | null {
  for (const term of haystack) {
    for (const needle of needles) {
      if (containsKeyword(term, needle)) return term;
    }
  }
  return null;
}

type RuleDefinition = {
  id: SafetyRuleId;
  label: string;
  /** Returns a triggered-rule record if the condition is met, else null. */
  evaluate: (input: SafetyInput, symptomTerms: string[]) => TriggeredSafetyRule | null;
};

/** Ordered list of deterministic rules. Order only affects presentation. */
const RULES: RuleDefinition[] = [
  {
    id: 'CARDIAC_ARREST',
    label: 'Suspected cardiac arrest',
    evaluate: (input, terms) => {
      const match = anyMatch(terms, SYMPTOM_KEYWORDS.cardiacArrest);
      const noPulse = input.vitals.heartRate === 0;
      if (!match && !noPulse) return null;
      return {
        ruleId: 'CARDIAC_ARREST',
        label: 'Suspected cardiac arrest',
        rationale: 'Pulselessness/absent respiration is an immediate life threat requiring CPR.',
        evidence: { symptom: match ?? 'n/a', heartRate: input.vitals.heartRate ?? 'unknown' },
      };
    },
  },
  {
    id: 'UNCONSCIOUS',
    label: 'Unconscious / unresponsive patient',
    evaluate: (input, terms) => {
      const match = anyMatch(terms, SYMPTOM_KEYWORDS.unconscious);
      const gcsLow = typeof input.vitals.glasgowComaScale === 'number' && input.vitals.glasgowComaScale <= 8;
      if (!input.vitals.isUnconscious && !match && !gcsLow) return null;
      return {
        ruleId: 'UNCONSCIOUS',
        label: 'Unconscious / unresponsive patient',
        rationale: 'Unconsciousness (GCS ≤ 8) indicates inability to protect the airway.',
        evidence: {
          isUnconscious: input.vitals.isUnconscious,
          glasgowComaScale: input.vitals.glasgowComaScale ?? 'unknown',
          symptom: match ?? 'n/a',
        },
      };
    },
  },
  {
    id: 'CRITICAL_HYPOXIA',
    label: 'Critically low oxygen saturation',
    evaluate: (input) => {
      const spo2 = input.vitals.oxygenSaturation;
      if (typeof spo2 !== 'number' || spo2 >= 90) return null;
      return {
        ruleId: 'CRITICAL_HYPOXIA',
        label: 'Critically low oxygen saturation',
        rationale: 'SpO₂ < 90% is critical hypoxaemia (spec rule: oxygen < 90 ⇒ critical).',
        evidence: { oxygenSaturation: spo2 },
      };
    },
  },
  {
    id: 'SEVERE_HYPOXIA_WITH_CHEST_PAIN',
    label: 'Chest pain with hypoxia',
    evaluate: (input, terms) => {
      const spo2 = input.vitals.oxygenSaturation;
      const chest = anyMatch(terms, SYMPTOM_KEYWORDS.chestPain);
      if (!chest || typeof spo2 !== 'number' || spo2 >= 92) return null;
      return {
        ruleId: 'SEVERE_HYPOXIA_WITH_CHEST_PAIN',
        label: 'Chest pain with hypoxia',
        rationale: 'Chest pain with SpO₂ < 92% suggests ACS/PE (spec rule: chest pain + oxygen < 92).',
        evidence: { symptom: chest, oxygenSaturation: spo2 },
      };
    },
  },
  {
    id: 'STROKE_SIGNS',
    label: 'Acute stroke signs (FAST positive)',
    evaluate: (_input, terms) => {
      const match = anyMatch(terms, SYMPTOM_KEYWORDS.stroke);
      if (!match) return null;
      return {
        ruleId: 'STROKE_SIGNS',
        label: 'Acute stroke signs (FAST positive)',
        rationale: 'Focal neuro deficit is time-critical ("time is brain"); needs immediate imaging.',
        evidence: { symptom: match },
      };
    },
  },
  {
    id: 'SEVERE_TRAUMA',
    label: 'Severe / major trauma',
    evaluate: (_input, terms) => {
      const match = anyMatch(terms, SYMPTOM_KEYWORDS.trauma);
      if (!match) return null;
      return {
        ruleId: 'SEVERE_TRAUMA',
        label: 'Severe / major trauma',
        rationale: 'High-energy or penetrating trauma carries occult life-threatening injury risk.',
        evidence: { symptom: match },
      };
    },
  },
  {
    id: 'SEVERE_BLEEDING',
    label: 'Severe / uncontrolled bleeding',
    evaluate: (_input, terms) => {
      const match = anyMatch(terms, SYMPTOM_KEYWORDS.bleeding);
      if (!match) return null;
      return {
        ruleId: 'SEVERE_BLEEDING',
        label: 'Severe / uncontrolled bleeding',
        rationale: 'Uncontrolled haemorrhage causes rapid haemodynamic collapse.',
        evidence: { symptom: match },
      };
    },
  },
  {
    id: 'SEVERE_RESPIRATORY_DISTRESS',
    label: 'Severe respiratory distress',
    evaluate: (input, terms) => {
      const match = anyMatch(terms, SYMPTOM_KEYWORDS.respiratoryDistress);
      const rr = input.vitals.respiratoryRate;
      const rrCritical = typeof rr === 'number' && (rr >= 30 || rr <= 6);
      if (!match && !rrCritical) return null;
      return {
        ruleId: 'SEVERE_RESPIRATORY_DISTRESS',
        label: 'Severe respiratory distress',
        rationale: 'Respiratory rate ≥ 30 or ≤ 6, or stridor/choking, signals impending failure.',
        evidence: { symptom: match ?? 'n/a', respiratoryRate: rr ?? 'unknown' },
      };
    },
  },
  {
    id: 'SEVERE_BRADYCARDIA',
    label: 'Severe bradycardia',
    evaluate: (input) => {
      const hr = input.vitals.heartRate;
      if (typeof hr !== 'number' || hr === 0 || hr >= 40) return null;
      return {
        ruleId: 'SEVERE_BRADYCARDIA',
        label: 'Severe bradycardia',
        rationale: 'Heart rate < 40 bpm risks inadequate perfusion.',
        evidence: { heartRate: hr },
      };
    },
  },
  {
    id: 'SEVERE_TACHYCARDIA',
    label: 'Severe tachycardia',
    evaluate: (input) => {
      const hr = input.vitals.heartRate;
      if (typeof hr !== 'number' || hr <= 150) return null;
      return {
        ruleId: 'SEVERE_TACHYCARDIA',
        label: 'Severe tachycardia',
        rationale: 'Heart rate > 150 bpm may indicate unstable arrhythmia.',
        evidence: { heartRate: hr },
      };
    },
  },
  {
    id: 'SEVERE_HYPOTENSION',
    label: 'Severe hypotension / shock',
    evaluate: (input) => {
      const sbp = input.vitals.systolicBp;
      if (typeof sbp !== 'number' || sbp >= 90) return null;
      return {
        ruleId: 'SEVERE_HYPOTENSION',
        label: 'Severe hypotension / shock',
        rationale: 'Systolic BP < 90 mmHg indicates shock/hypoperfusion.',
        evidence: { systolicBp: sbp },
      };
    },
  },
  {
    id: 'HYPERTENSIVE_CRISIS',
    label: 'Hypertensive crisis',
    evaluate: (input) => {
      const sbp = input.vitals.systolicBp;
      const dbp = input.vitals.diastolicBp;
      const crisis = (typeof sbp === 'number' && sbp >= 220) || (typeof dbp === 'number' && dbp >= 120);
      if (!crisis) return null;
      return {
        ruleId: 'HYPERTENSIVE_CRISIS',
        label: 'Hypertensive crisis',
        rationale: 'SBP ≥ 220 or DBP ≥ 120 mmHg risks end-organ damage.',
        evidence: { systolicBp: sbp ?? 'unknown', diastolicBp: dbp ?? 'unknown' },
      };
    },
  },
  {
    id: 'HYPERPYREXIA',
    label: 'Hyperpyrexia',
    evaluate: (input) => {
      const t = input.vitals.temperatureC;
      if (typeof t !== 'number' || t < 41) return null;
      return {
        ruleId: 'HYPERPYREXIA',
        label: 'Hyperpyrexia',
        rationale: 'Core temperature ≥ 41 °C risks neurological injury.',
        evidence: { temperatureC: t },
      };
    },
  },
  {
    id: 'SEVERE_HYPOTHERMIA',
    label: 'Severe hypothermia',
    evaluate: (input) => {
      const t = input.vitals.temperatureC;
      if (typeof t !== 'number' || t > 32) return null;
      return {
        ruleId: 'SEVERE_HYPOTHERMIA',
        label: 'Severe hypothermia',
        rationale: 'Core temperature ≤ 32 °C causes cardiac instability.',
        evidence: { temperatureC: t },
      };
    },
  },
];

/** Maps each triggered rule to a deterministic, immediate bedside action. */
const RULE_ACTIONS: Record<SafetyRuleId, string> = {
  CARDIAC_ARREST: 'Start CPR immediately, call code blue, attach defibrillator.',
  STROKE_SIGNS: 'Activate stroke pathway, record last-known-well time, urgent CT head.',
  SEVERE_TRAUMA: 'Activate trauma team, control catastrophic haemorrhage, C-spine precautions.',
  UNCONSCIOUS: 'Protect airway (recovery position/airway adjunct), check glucose, monitor GCS.',
  CRITICAL_HYPOXIA: 'Apply high-flow oxygen, prepare airway support, continuous SpO₂ monitoring.',
  SEVERE_HYPOXIA_WITH_CHEST_PAIN: 'Oxygen, 12-lead ECG, aspirin if indicated, prepare for ACS pathway.',
  SEVERE_BLEEDING: 'Apply direct pressure/tourniquet, large-bore IV access, activate transfusion.',
  SEVERE_BRADYCARDIA: 'Continuous ECG, prepare atropine/pacing, identify reversible causes.',
  SEVERE_TACHYCARDIA: 'Continuous ECG, assess stability, prepare for cardioversion if unstable.',
  SEVERE_HYPOTENSION: 'IV access, fluid resuscitation, identify and treat shock cause.',
  HYPERTENSIVE_CRISIS: 'Controlled BP reduction, assess for end-organ damage, neuro obs.',
  SEVERE_RESPIRATORY_DISTRESS: 'High-flow oxygen, sit upright, prepare airway/ventilatory support.',
  HYPERPYREXIA: 'Active cooling, IV fluids, investigate sepsis/heat illness.',
  SEVERE_HYPOTHERMIA: 'Active rewarming, handle gently (arrhythmia risk), continuous cardiac monitoring.',
};

/**
 * Run the deterministic safety screen. Pure function — same input always yields
 * the same output. Throws nothing; invalid/missing vitals simply do not trigger
 * the rules that depend on them.
 *
 * @param input  Vitals and symptoms collected at intake.
 * @param now    Injected timestamp (ISO string) so callers control time for tests.
 */
export function runSafetyScreen(input: SafetyInput, now: string): SafetyScreenResult {
  const terms = normalize(input.symptoms);
  const triggeredRules: TriggeredSafetyRule[] = [];

  for (const rule of RULES) {
    const hit = rule.evaluate(input, terms);
    if (hit) triggeredRules.push(hit);
  }

  const isCritical = triggeredRules.length > 0;
  const recommendedActions = dedupe(triggeredRules.map((r) => RULE_ACTIONS[r.ruleId]));

  return {
    isCritical,
    forcedSeverity: isCritical ? 'CRITICAL' : null,
    triggeredRules,
    recommendedActions,
    evaluatedAt: now,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Exposed for documentation/UI: the full catalogue of safety rules. */
export const SAFETY_RULE_CATALOGUE = RULES.map((r) => ({ id: r.id, label: r.label }));
