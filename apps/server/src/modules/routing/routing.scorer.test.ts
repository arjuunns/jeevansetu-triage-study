import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WEIGHTS,
  rankCandidates,
  scoreCandidate,
  weightsForSeverity,
  type CandidateInput,
} from './routing.scorer.js';

function candidate(overrides: Partial<CandidateInput>): CandidateInput {
  return {
    hospitalId: 'h1',
    hospitalName: 'Test Hospital',
    distanceKm: 5,
    availableBeds: 10,
    maxBedsReference: 20,
    hasMatchingSpecialist: true,
    hasRequiredEquipment: true,
    emergencyTier: 3,
    ...overrides,
  };
}

describe('routing scorer', () => {
  it('produces a score in [0,1]', () => {
    const c = scoreCandidate(candidate({}), DEFAULT_WEIGHTS);
    expect(c.score).toBeGreaterThanOrEqual(0);
    expect(c.score).toBeLessThanOrEqual(1);
  });

  it('ranks a closer, better-equipped hospital above a far, ill-equipped one', () => {
    const near = candidate({ hospitalId: 'near', distanceKm: 2 });
    const far = candidate({
      hospitalId: 'far',
      distanceKm: 40,
      hasMatchingSpecialist: false,
      hasRequiredEquipment: false,
      availableBeds: 0,
      emergencyTier: 1,
    });
    const ranked = rankCandidates([far, near], DEFAULT_WEIGHTS, 5);
    expect(ranked[0]?.hospitalId).toBe('near');
  });

  it('zero available beds yields a zero capacity factor', () => {
    const c = scoreCandidate(candidate({ availableBeds: 0 }), DEFAULT_WEIGHTS);
    expect(c.factors.capacity).toBe(0);
  });

  it('distance score decreases monotonically with distance', () => {
    const close = scoreCandidate(candidate({ distanceKm: 1 }), DEFAULT_WEIGHTS);
    const mid = scoreCandidate(candidate({ distanceKm: 15 }), DEFAULT_WEIGHTS);
    const farc = scoreCandidate(candidate({ distanceKm: 50 }), DEFAULT_WEIGHTS);
    expect(close.factors.distance).toBeGreaterThan(mid.factors.distance);
    expect(mid.factors.distance).toBeGreaterThan(farc.factors.distance);
  });

  it('critical severity weights emergency capability higher than low severity', () => {
    expect(weightsForSeverity('CRITICAL').emergencyLevel).toBeGreaterThan(
      weightsForSeverity('LOW').emergencyLevel,
    );
  });

  it('includes a human-readable reasoning string', () => {
    const c = scoreCandidate(candidate({}), DEFAULT_WEIGHTS);
    expect(c.reasoning).toContain('Test Hospital');
    expect(c.reasoning.length).toBeGreaterThan(10);
  });
});
