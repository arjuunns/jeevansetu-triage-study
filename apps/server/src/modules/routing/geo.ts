import type { GeoPoint } from '@jeevansetu/types';

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two coordinates in kilometres (Haversine). */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rough travel-time estimate in minutes. Urban Indian ambulance speeds average
 * well below highway speed; we model ~32 km/h plus a fixed dispatch overhead.
 * This is a transparent heuristic — a maps/traffic API can replace it later.
 */
export function estimateTravelMinutes(distanceKm: number): number {
  const AVG_SPEED_KMH = 32;
  const DISPATCH_OVERHEAD_MIN = 4;
  return Math.round((distanceKm / AVG_SPEED_KMH) * 60 + DISPATCH_OVERHEAD_MIN);
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
