import { prisma } from '../../lib/prisma.js';

/**
 * Phase 14 — CMO Dashboard metrics. Real aggregate queries over the operational
 * tables. Results feed both the REST endpoint (initial load) and the realtime
 * channel (live updates).
 */
export interface DashboardMetrics {
  totals: {
    patients: number;
    criticalPatients: number;
    referrals: number;
    activeAlerts: number;
  };
  rates: {
    routingSuccessRate: number;
    overrideRate: number;
    avgAiConfidence: number;
    avgTriageSeconds: number | null;
  };
  severityDistribution: { severity: string; count: number }[];
  hospitalOccupancy: { hospitalId: string; name: string; occupancyPct: number; availableBeds: number }[];
  referralTrend: { date: string; count: number }[];
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const [
    patients,
    criticalPatients,
    referrals,
    activeAlerts,
    severityGroups,
    reviews,
    overrides,
    confidenceAgg,
    triageLatency,
    capacities,
    routingRuns,
    routingSuccess,
  ] = await Promise.all([
    prisma.patient.count({ where: { deletedAt: null } }),
    prisma.triageAssessment.count({ where: { finalSeverity: 'CRITICAL', deletedAt: null } }),
    prisma.referral.count({ where: { deletedAt: null } }),
    prisma.emergencyAlert.count({ where: { status: 'ACTIVE' } }),
    prisma.triageAssessment.groupBy({
      by: ['finalSeverity'],
      where: { finalSeverity: { not: null }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.doctorReview.count({ where: { deletedAt: null } }),
    prisma.doctorReview.count({ where: { action: { in: ['OVERRIDE', 'MODIFY'] }, deletedAt: null } }),
    prisma.triageAssessment.aggregate({ _avg: { aiConfidence: true }, where: { deletedAt: null } }),
    prisma.agentExecution.aggregate({ _avg: { latencyMs: true }, where: { agentType: 'TRIAGE' } }),
    prisma.hospital.findMany({
      where: { deletedAt: null },
      include: { capacity: true },
    }),
    prisma.hospitalRouting.count(),
    prisma.hospitalRouting.count({ where: { selectedHospitalId: { not: null } } }),
  ]);

  const severityDistribution = severityGroups.map((g) => ({
    severity: g.finalSeverity ?? 'UNKNOWN',
    count: g._count._all,
  }));

  const hospitalOccupancy = capacities.map((h) => {
    const total = (h.capacity?.icuBedsTotal ?? 0) + (h.capacity?.generalBedsTotal ?? 0);
    const available = (h.capacity?.icuBedsAvailable ?? 0) + (h.capacity?.generalBedsAvailable ?? 0);
    const occupancyPct = total > 0 ? Math.round(((total - available) / total) * 100) : 0;
    return { hospitalId: h.id, name: h.name, occupancyPct, availableBeds: available };
  });

  const avgTriageMs = triageLatency._avg.latencyMs;

  return {
    totals: { patients, criticalPatients, referrals, activeAlerts },
    rates: {
      routingSuccessRate: routingRuns > 0 ? round(routingSuccess / routingRuns) : 0,
      overrideRate: reviews > 0 ? round(overrides / reviews) : 0,
      avgAiConfidence: round(confidenceAgg._avg.aiConfidence ?? 0),
      avgTriageSeconds: avgTriageMs ? round(avgTriageMs / 1000) : null,
    },
    severityDistribution,
    hospitalOccupancy,
    referralTrend: await referralTrend(),
  };
}

/** Daily referral counts for the last 14 days. */
async function referralTrend(): Promise<{ date: string; count: number }[]> {
  const rows = await prisma.$queryRaw<{ date: Date; count: bigint }[]>`
    SELECT date_trunc('day', "createdAt") AS date, COUNT(*)::bigint AS count
    FROM referrals
    WHERE "deletedAt" IS NULL AND "createdAt" > NOW() - INTERVAL '14 days'
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  return rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), count: Number(r.count) }));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
