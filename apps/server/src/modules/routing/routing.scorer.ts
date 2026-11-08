import type {
  HospitalRouteCandidate,
  RoutingWeights,
  SeverityLevel,
} from '@jeevansetu/types';

import { estimateTravelMinutes } from './geo.js';

/**
 * Phase 10 — Smart Routing Scorer (pure, deterministic, testable).
 *
 * Scores each hospital candidate on five normalised [0,1] factors — distance,
 * capacity, specialist match, equipment match, emergency capability — combines
 * them with severity-tuned weights, and emits a human-readable explanation of
 * the ranking ("route reasoning"). Higher score = better destination.
 */

export interface CandidateInput {
  hospitalId: string;
  hospitalName: string;
  distanceKm: number;
  availableBeds: number;
  maxBedsReference: number;
  hasMatchingSpecialist: boolean;
  hasRequiredEquipment: boolean;
  /** 0..4 capability tier (NONE..COMPREHENSIVE). */
  emergencyTier: number;
}

/** Default factor weights; specialised by severity below. Must sum to 1. */
export const DEFAULT_WEIGHTS: RoutingWeights = {
  distance: 0.3,
  capacity: 0.2,
  specialistMatch: 0.25,
  equipmentMatch: 0.15,
  emergencyLevel: 0.1,
};

/**
 * For CRITICAL patients, capability and proximity dominate (golden hour); for
 * lower acuity, specialist match and capacity matter relatively more.
 */
export function weightsForSeverity(severity: SeverityLevel): RoutingWeights {
  switch (severity) {
    case 'CRITICAL':
      return { distance: 0.35, capacity: 0.15, specialistMatch: 0.15, equipmentMatch: 0.15, emergencyLevel: 0.2 };
    case 'HIGH':
      return { distance: 0.3, capacity: 0.2, specialistMatch: 0.25, equipmentMatch: 0.15, emergencyLevel: 0.1 };
    default:
      return { distance: 0.25, capacity: 0.25, specialistMatch: 0.3, equipmentMatch: 0.1, emergencyLevel: 0.05 };
  }
}

/** Distance score: 1 at 0 km, decaying smoothly, ~0 beyond ~60 km. */
function distanceScore(distanceKm: number): number {
  return clamp01(1 / (1 + distanceKm / 12));
}

function capacityScore(availableBeds: number, reference: number): number {
  if (availableBeds <= 0) return 0;
  if (reference <= 0) return availableBeds > 0 ? 0.5 : 0;
  return clamp01(availableBeds / reference);
}

export function scoreCandidate(
  input: CandidateInput,
  weights: RoutingWeights,
): HospitalRouteCandidate {
  const factors = {
    distance: distanceScore(input.distanceKm),
    capacity: capacityScore(input.availableBeds, input.maxBedsReference),
    specialistMatch: input.hasMatchingSpecialist ? 1 : 0,
    equipmentMatch: input.hasRequiredEquipment ? 1 : 0,
    emergencyLevel: clamp01(input.emergencyTier / 4),
  };

  const score = clamp01(
    factors.distance * weights.distance +
      factors.capacity * weights.capacity +
      factors.specialistMatch * weights.specialistMatch +
      factors.equipmentMatch * weights.equipmentMatch +
      factors.emergencyLevel * weights.emergencyLevel,
  );

  return {
    hospitalId: input.hospitalId,
    hospitalName: input.hospitalName,
    score: round(score),
    distanceKm: round(input.distanceKm),
    estimatedTravelMinutes: estimateTravelMinutes(input.distanceKm),
    factors: {
      distance: round(factors.distance),
      capacity: round(factors.capacity),
      specialistMatch: factors.specialistMatch,
      equipmentMatch: factors.equipmentMatch,
      emergencyLevel: round(factors.emergencyLevel),
    },
    availableBeds: input.availableBeds,
    hasMatchingSpecialist: input.hasMatchingSpecialist,
    hasRequiredEquipment: input.hasRequiredEquipment,
    reasoning: explain(input, factors),
  };
}

export function rankCandidates(
  inputs: CandidateInput[],
  weights: RoutingWeights,
  maxResults: number,
): HospitalRouteCandidate[] {
  return inputs
    .map((c) => scoreCandidate(c, weights))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function explain(input: CandidateInput, factors: { distance: number }): string {
  const parts: string[] = [];
  parts.push(`${round(input.distanceKm)} km away (~${estimateTravelMinutes(input.distanceKm)} min)`);
  parts.push(input.hasMatchingSpecialist ? 'has a matching on-duty specialist' : 'no matching specialist on duty');
  parts.push(input.hasRequiredEquipment ? 'has the required equipment' : 'missing required equipment');
  parts.push(`${input.availableBeds} bed(s) available`);
  parts.push(`emergency capability tier ${input.emergencyTier}/4`);
  void factors;
  return `${input.hospitalName}: ${parts.join('; ')}.`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
