import type {
  EmergencyLevel,
  HospitalRouteCandidate,
  RoutingRequest,
  RoutingResult,
} from '@jeevansetu/types';

import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit, type AuditContext } from '../audit/audit.service.js';
import { haversineKm } from './geo.js';
import { isNeo4jAvailable, withSession } from './neo4j.js';
import { rankCandidates, weightsForSeverity, type CandidateInput } from './routing.scorer.js';

const EMERGENCY_TIER: Record<EmergencyLevel, number> = {
  NONE: 0,
  BASIC: 1,
  INTERMEDIATE: 2,
  ADVANCED: 3,
  COMPREHENSIVE: 4,
};

/**
 * Phase 10 — Smart Routing Engine service. Pulls candidate hospitals (Neo4j when
 * available, else PostgreSQL), computes distance, then ranks via the pure scorer.
 * The ranked list with per-factor scores and explanations is persisted and
 * returned for doctor selection.
 */
export async function routeVisit(req: RoutingRequest, context: AuditContext): Promise<RoutingResult> {
  const visit = await prisma.visit.findFirst({ where: { id: req.visitId, deletedAt: null } });
  if (!visit) throw new NotFoundError('Visit');

  const useGraph = await isNeo4jAvailable();
  let raw = useGraph ? await candidatesFromGraph(req) : await candidatesFromPostgres(req);
  if (raw.length === 0 && useGraph) {
    logger.warn('Neo4j returned 0 candidate hospitals, falling back to PostgreSQL');
    raw = await candidatesFromPostgres(req);
  }

  const weights = weightsForSeverity(req.severity);
  const candidates: HospitalRouteCandidate[] = rankCandidates(raw, weights, req.maxResults);

  const result: RoutingResult = {
    visitId: req.visitId,
    candidates,
    weightsUsed: weights,
    generatedAt: new Date().toISOString(),
  };

  await prisma.hospitalRouting.upsert({
    where: { visitId: req.visitId },
    create: {
      visitId: req.visitId,
      selectedHospitalId: candidates[0]?.hospitalId,
      rankedCandidates: candidates as unknown as object,
      weightsUsed: weights as unknown as object,
      requiredDepartment: req.requiredDepartment,
      createdBy: context.userId ?? undefined,
    },
    update: {
      selectedHospitalId: candidates[0]?.hospitalId,
      rankedCandidates: candidates as unknown as object,
      weightsUsed: weights as unknown as object,
      requiredDepartment: req.requiredDepartment,
    },
  });

  await prisma.agentExecution.create({
    data: {
      visitId: req.visitId,
      agentType: 'ROUTING',
      status: 'SUCCEEDED',
      input: req as unknown as object,
      output: result as unknown as object,
    },
  });

  await recordAudit({
    action: 'ROUTING_EXECUTED',
    entityType: 'Visit',
    entityId: req.visitId,
    newState: { top: candidates[0]?.hospitalName, count: candidates.length, engine: useGraph ? 'neo4j' : 'postgres' },
    context,
  });

  return result;
}

/** Candidate retrieval via Neo4j graph traversal. */
async function candidatesFromGraph(req: RoutingRequest): Promise<CandidateInput[]> {
  const records = await withSession((session) =>
    session.run(
      `
      MATCH (h:Hospital)
      WHERE h.isActive = true
      OPTIONAL MATCH (h)-[:HAS_DEPARTMENT]->(d:Department {name: $department})
      OPTIONAL MATCH (h)-[:EMPLOYS]->(s:Specialist)
        WHERE toLower(s.specialty) CONTAINS toLower($department) AND s.isOnDuty = true
      OPTIONAL MATCH (h)-[:HAS_RESOURCE]->(r:Resource)
        WHERE r.name IN $equipment AND r.isOperational = true
      RETURN h,
        count(DISTINCT d) AS deptCount,
        count(DISTINCT s) AS specialistCount,
        count(DISTINCT r) AS resourceCount
      `,
      { department: req.requiredDepartment, equipment: req.requiredEquipment },
    ),
  );

  return records.records.map((rec) => {
    const h = rec.get('h').properties as Record<string, unknown>;
    const distanceKm = haversineKm(req.origin, {
      latitude: Number(h.latitude),
      longitude: Number(h.longitude),
    });
    return {
      hospitalId: String(h.id),
      hospitalName: String(h.name),
      distanceKm,
      availableBeds: Number(h.availableBeds ?? 0),
      maxBedsReference: Number(h.totalBeds ?? 0),
      hasMatchingSpecialist: Number(rec.get('specialistCount')) > 0,
      hasRequiredEquipment:
        req.requiredEquipment.length === 0 || Number(rec.get('resourceCount')) >= req.requiredEquipment.length,
      emergencyTier: EMERGENCY_TIER[(h.emergencyLevel as EmergencyLevel) ?? 'BASIC'] ?? 1,
    } satisfies CandidateInput;
  });
}

/** Candidate retrieval via PostgreSQL (fallback when Neo4j is unavailable). */
async function candidatesFromPostgres(req: RoutingRequest): Promise<CandidateInput[]> {
  const hospitals = await prisma.hospital.findMany({
    where: { deletedAt: null, isActive: true },
    include: {
      capacity: true,
      specialists: { where: { deletedAt: null, isOnDuty: true } },
      resources: { where: { deletedAt: null, isOperational: true } },
      departments: { where: { deletedAt: null } },
    },
  });

  const dept = req.requiredDepartment.toLowerCase();
  return hospitals.map((h) => {
    const availableBeds = (h.capacity?.icuBedsAvailable ?? 0) + (h.capacity?.generalBedsAvailable ?? 0);
    const totalBeds = (h.capacity?.icuBedsTotal ?? 0) + (h.capacity?.generalBedsTotal ?? 0);
    const hasMatchingSpecialist = h.specialists.some((s) => s.specialty.toLowerCase().includes(dept));
    const equipmentNames = new Set(h.resources.map((r) => r.name.toLowerCase()));
    const hasRequiredEquipment =
      req.requiredEquipment.length === 0 ||
      req.requiredEquipment.every((e) => equipmentNames.has(e.toLowerCase()));
    return {
      hospitalId: h.id,
      hospitalName: h.name,
      distanceKm: haversineKm(req.origin, { latitude: h.latitude, longitude: h.longitude }),
      availableBeds,
      maxBedsReference: totalBeds,
      hasMatchingSpecialist,
      hasRequiredEquipment,
      emergencyTier: EMERGENCY_TIER[h.emergencyLevel] ?? 1,
    } satisfies CandidateInput;
  });
}

/**
 * Mirror a hospital's topology and live capacity into the Neo4j graph. Called
 * whenever a hospital, its capacity, specialists, or resources change. No-ops
 * silently if Neo4j is not configured.
 */
export async function syncHospitalToGraph(hospitalId: string): Promise<void> {
  if (!(await isNeo4jAvailable())) return;
  const h = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    include: {
      capacity: true,
      departments: { where: { deletedAt: null } },
      specialists: { where: { deletedAt: null } },
      resources: { where: { deletedAt: null } },
    },
  });
  if (!h) return;

  const availableBeds = (h.capacity?.icuBedsAvailable ?? 0) + (h.capacity?.generalBedsAvailable ?? 0);
  const totalBeds = (h.capacity?.icuBedsTotal ?? 0) + (h.capacity?.generalBedsTotal ?? 0);

  try {
    await withSession((session) =>
      session.executeWrite(async (tx) => {
        await tx.run(
          `
          MERGE (h:Hospital {id: $id})
          SET h.name = $name, h.latitude = $lat, h.longitude = $lon,
              h.emergencyLevel = $emergencyLevel, h.isTraumaCenter = $isTraumaCenter,
              h.isActive = $isActive, h.availableBeds = $availableBeds, h.totalBeds = $totalBeds
          `,
          {
            id: h.id,
            name: h.name,
            lat: h.latitude,
            lon: h.longitude,
            emergencyLevel: h.emergencyLevel,
            isTraumaCenter: h.isTraumaCenter,
            isActive: h.isActive,
            availableBeds,
            totalBeds,
          },
        );
        // Refresh department/specialist/resource sub-graph.
        await tx.run(`MATCH (h:Hospital {id: $id})-[rel]->(n) DELETE rel, n`, { id: h.id });
        for (const d of h.departments) {
          await tx.run(
            `MATCH (h:Hospital {id: $id}) CREATE (h)-[:HAS_DEPARTMENT]->(:Department {name: $name, available: $available})`,
            { id: h.id, name: d.name, available: d.isAvailable },
          );
        }
        for (const s of h.specialists) {
          await tx.run(
            `MATCH (h:Hospital {id: $id}) CREATE (h)-[:EMPLOYS]->(:Specialist {name: $name, specialty: $specialty, isOnDuty: $isOnDuty})`,
            { id: h.id, name: s.name, specialty: s.specialty, isOnDuty: s.isOnDuty },
          );
        }
        for (const r of h.resources) {
          await tx.run(
            `MATCH (h:Hospital {id: $id}) CREATE (h)-[:HAS_RESOURCE]->(:Resource {name: $name, isOperational: $isOperational})`,
            { id: h.id, name: r.name, isOperational: r.isOperational },
          );
        }
      }),
    );
  } catch (err) {
    logger.error({ err, hospitalId }, 'Failed to sync hospital to Neo4j graph');
  }
}

/** Sync all existing active hospitals in PostgreSQL into Neo4j graph. */
export async function syncAllHospitalsToGraph(): Promise<number> {
  if (!(await isNeo4jAvailable())) return 0;
  try {
    const hospitals = await prisma.hospital.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true },
    });
    let synced = 0;
    for (const h of hospitals) {
      await syncHospitalToGraph(h.id);
      synced++;
    }
    logger.info({ count: synced }, 'Synced hospitals to Neo4j graph');
    return synced;
  } catch (err) {
    logger.error({ err }, 'Failed to batch sync hospitals to Neo4j graph');
    return 0;
  }
}
