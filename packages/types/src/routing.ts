import { z } from 'zod';

/** Geographic coordinate. */
export const geoPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof geoPointSchema>;

/** Weighting profile for the smart routing scorer (Phase 10). */
export interface RoutingWeights {
  distance: number;
  capacity: number;
  specialistMatch: number;
  equipmentMatch: number;
  emergencyLevel: number;
}

/** One hospital candidate in a ranked routing result. */
export interface HospitalRouteCandidate {
  hospitalId: string;
  hospitalName: string;
  /** Overall score in [0,1]; higher is better. */
  score: number;
  distanceKm: number;
  estimatedTravelMinutes: number;
  /** Per-factor contribution breakdown, for explainability. */
  factors: {
    distance: number;
    capacity: number;
    specialistMatch: number;
    equipmentMatch: number;
    emergencyLevel: number;
  };
  availableBeds: number;
  hasMatchingSpecialist: boolean;
  hasRequiredEquipment: boolean;
  /** Natural-language explanation of why this hospital ranked where it did. */
  reasoning: string;
}

export interface RoutingResult {
  visitId: string;
  candidates: HospitalRouteCandidate[];
  weightsUsed: RoutingWeights;
  generatedAt: string;
}

export const routingRequestSchema = z.object({
  visitId: z.string(),
  origin: geoPointSchema,
  requiredDepartment: z.string(),
  requiredEquipment: z.array(z.string()).default([]),
  severity: z.enum(['CRITICAL', 'HIGH', 'MODERATE', 'LOW']),
  maxResults: z.number().int().min(1).max(20).default(5),
});
export type RoutingRequest = z.infer<typeof routingRequestSchema>;
