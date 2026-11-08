import { describe, expect, it } from 'vitest';

import { runSafetyScreen, type SafetyInput } from './safety.engine.js';

const NOW = '2026-01-01T00:00:00.000Z';

function screen(partial: Partial<SafetyInput>): ReturnType<typeof runSafetyScreen> {
  const input: SafetyInput = {
    vitals: { isUnconscious: false },
    symptoms: [],
    ...partial,
  };
  return runSafetyScreen(input, NOW);
}

describe('runSafetyScreen — spec rules', () => {
  it('oxygen < 90 ⇒ CRITICAL', () => {
    const r = screen({ vitals: { oxygenSaturation: 88, isUnconscious: false } });
    expect(r.isCritical).toBe(true);
    expect(r.forcedSeverity).toBe('CRITICAL');
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('CRITICAL_HYPOXIA');
  });

  it('oxygen exactly 90 does NOT trigger critical hypoxia', () => {
    const r = screen({ vitals: { oxygenSaturation: 90, isUnconscious: false } });
    expect(r.triggeredRules.map((x) => x.ruleId)).not.toContain('CRITICAL_HYPOXIA');
  });

  it('chest pain + oxygen < 92 ⇒ CRITICAL', () => {
    const r = screen({
      vitals: { oxygenSaturation: 91, isUnconscious: false },
      symptoms: [{ name: 'Chest pain radiating to left arm', severity: 'SEVERE' }],
    });
    expect(r.isCritical).toBe(true);
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('SEVERE_HYPOXIA_WITH_CHEST_PAIN');
  });

  it('chest pain with normal oxygen does NOT trigger the combined rule', () => {
    const r = screen({
      vitals: { oxygenSaturation: 98, isUnconscious: false },
      symptoms: [{ name: 'Chest pain', severity: 'MODERATE' }],
    });
    expect(r.triggeredRules.map((x) => x.ruleId)).not.toContain('SEVERE_HYPOXIA_WITH_CHEST_PAIN');
  });

  it('unconscious flag ⇒ CRITICAL', () => {
    const r = screen({ vitals: { isUnconscious: true } });
    expect(r.isCritical).toBe(true);
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('UNCONSCIOUS');
  });

  it('GCS ≤ 8 ⇒ CRITICAL via unconscious rule', () => {
    const r = screen({ vitals: { glasgowComaScale: 6, isUnconscious: false } });
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('UNCONSCIOUS');
  });
});

describe('runSafetyScreen — symptom red flags', () => {
  it.each([
    ['cardiac arrest', 'CARDIAC_ARREST'],
    ['sudden facial droop and slurred speech', 'STROKE_SIGNS'],
    ['gunshot wound to abdomen', 'SEVERE_TRAUMA'],
    ['uncontrolled bleeding from thigh', 'SEVERE_BLEEDING'],
  ])('symptom "%s" triggers %s', (symptom, ruleId) => {
    const r = screen({ symptoms: [{ name: symptom, severity: 'SEVERE' }] });
    expect(r.isCritical).toBe(true);
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain(ruleId);
  });

  it('matches keywords only at word starts ("rta" does not fire inside "aorta")', () => {
    expect(screen({ symptoms: [{ name: 'dilated aorta on prior scan' }] }).isCritical).toBe(false);
    expect(screen({ symptoms: [{ name: 'RTA, pillion rider' }] }).triggeredRules.map((x) => x.ruleId)).toContain(
      'SEVERE_TRAUMA',
    );
  });

  it('still matches plural forms', () => {
    const r = screen({ symptoms: [{ name: 'multiple stab wounds' }] });
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('SEVERE_TRAUMA');
  });
});

describe('runSafetyScreen — vital thresholds', () => {
  it('systolic BP < 90 ⇒ hypotension/shock', () => {
    const r = screen({ vitals: { systolicBp: 80, isUnconscious: false } });
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('SEVERE_HYPOTENSION');
  });

  it('heart rate > 150 ⇒ severe tachycardia', () => {
    const r = screen({ vitals: { heartRate: 175, isUnconscious: false } });
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('SEVERE_TACHYCARDIA');
  });

  it('respiratory rate ≥ 30 ⇒ respiratory distress', () => {
    const r = screen({ vitals: { respiratoryRate: 34, isUnconscious: false } });
    expect(r.triggeredRules.map((x) => x.ruleId)).toContain('SEVERE_RESPIRATORY_DISTRESS');
  });
});

describe('runSafetyScreen — non-critical & determinism', () => {
  it('normal vitals and benign symptom ⇒ not critical', () => {
    const r = screen({
      vitals: {
        oxygenSaturation: 99,
        heartRate: 72,
        respiratoryRate: 16,
        systolicBp: 120,
        diastolicBp: 80,
        temperatureC: 37,
        isUnconscious: false,
      },
      symptoms: [{ name: 'mild sore throat', severity: 'MILD' }],
    });
    expect(r.isCritical).toBe(false);
    expect(r.forcedSeverity).toBeNull();
    expect(r.triggeredRules).toHaveLength(0);
  });

  it('is deterministic for identical input', () => {
    const input: Partial<SafetyInput> = {
      vitals: { oxygenSaturation: 85, isUnconscious: false },
      symptoms: [{ name: 'chest pain', severity: 'SEVERE' }],
    };
    expect(screen(input)).toEqual(screen(input));
  });

  it('produces a deduplicated recommended-action list', () => {
    const r = screen({ vitals: { oxygenSaturation: 70, isUnconscious: true } });
    expect(new Set(r.recommendedActions).size).toBe(r.recommendedActions.length);
    expect(r.recommendedActions.length).toBeGreaterThan(0);
  });
});
