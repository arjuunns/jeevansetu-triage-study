import { NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { recordAudit, type AuditContext } from '../audit/audit.service.js';
import { syncHospitalToGraph } from '../routing/routing.service.js';
import type {
  CapacityInput,
  CreateHospitalInput,
} from './hospital.schemas.js';

/**
 * Phase 9 — Hospital Management. CRUD over hospitals, departments, specialists,
 * resources, and real-time capacity. Capacity/topology changes are mirrored into
 * the Neo4j routing graph so the routing engine always scores against live data.
 */

export async function createHospital(data: CreateHospitalInput, context: AuditContext) {
  const hospital = await prisma.hospital.create({
    data: {
      ...data,
      createdBy: context.userId ?? undefined,
      capacity: { create: {} },
    },
    include: { capacity: true },
  });
  await recordAudit({
    action: 'HOSPITAL_ASSIGNED',
    entityType: 'Hospital',
    entityId: hospital.id,
    newState: data,
    context,
    metadata: { operation: 'create' },
  });
  await syncHospitalToGraph(hospital.id);
  return hospital;
}

export async function updateHospital(
  id: string,
  data: Partial<CreateHospitalInput>,
  context: AuditContext,
) {
  const existing = await prisma.hospital.findFirst({ where: { id, deletedAt: null } });
  if (!existing) throw new NotFoundError('Hospital');
  const hospital = await prisma.hospital.update({
    where: { id },
    data: { ...data, updatedBy: context.userId ?? undefined },
  });
  await recordAudit({
    action: 'HOSPITAL_ASSIGNED',
    entityType: 'Hospital',
    entityId: id,
    previousState: existing,
    newState: data,
    context,
    metadata: { operation: 'update' },
  });
  await syncHospitalToGraph(id);
  return hospital;
}

export async function listHospitals() {
  return prisma.hospital.findMany({
    where: { deletedAt: null },
    include: { capacity: true, departments: true, _count: { select: { specialists: true } } },
    orderBy: { name: 'asc' },
  });
}

export async function getHospital(id: string) {
  const hospital = await prisma.hospital.findFirst({
    where: { id, deletedAt: null },
    include: {
      capacity: true,
      departments: { where: { deletedAt: null } },
      specialists: { where: { deletedAt: null } },
      resources: { where: { deletedAt: null } },
    },
  });
  if (!hospital) throw new NotFoundError('Hospital');
  return hospital;
}

export async function updateCapacity(
  hospitalId: string,
  data: CapacityInput,
  context: AuditContext,
) {
  const existing = await prisma.hospitalCapacity.findUnique({ where: { hospitalId } });
  const capacity = await prisma.hospitalCapacity.upsert({
    where: { hospitalId },
    create: { hospitalId, ...data, updatedBy: context.userId ?? undefined },
    update: { ...data, updatedBy: context.userId ?? undefined },
  });
  await recordAudit({
    action: 'CAPACITY_UPDATED',
    entityType: 'Hospital',
    entityId: hospitalId,
    previousState: existing,
    newState: data,
    context,
  });
  await syncHospitalToGraph(hospitalId);

  // Surface a capacity warning when critical resources run low.
  await maybeRaiseCapacityWarning(hospitalId, capacity);
  return capacity;
}

async function maybeRaiseCapacityWarning(
  hospitalId: string,
  capacity: { icuBedsAvailable: number; ventilatorsAvailable: number },
): Promise<void> {
  if (capacity.icuBedsAvailable <= 1 || capacity.ventilatorsAvailable <= 1) {
    const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId }, select: { name: true } });
    await prisma.notification.create({
      data: {
        type: 'CAPACITY_WARNING',
        channel: 'IN_APP',
        status: 'PENDING',
        title: 'Capacity warning',
        body: `${hospital?.name ?? 'A hospital'} is running low on ICU beds/ventilators.`,
        payload: { hospitalId, ...capacity },
      },
    });
  }
}

export async function addDepartment(
  hospitalId: string,
  data: { name: string; code?: string; isAvailable?: boolean },
) {
  await assertHospital(hospitalId);
  return prisma.department.create({ data: { hospitalId, ...data } });
}

export async function addSpecialist(
  hospitalId: string,
  data: { name: string; specialty: string; departmentId?: string; registrationNo?: string; isOnDuty?: boolean },
) {
  await assertHospital(hospitalId);
  const specialist = await prisma.specialist.create({ data: { hospitalId, ...data } });
  await syncHospitalToGraph(hospitalId);
  return specialist;
}

export async function addResource(
  hospitalId: string,
  data: { name: string; category?: string; quantity?: number; isOperational?: boolean },
) {
  await assertHospital(hospitalId);
  const resource = await prisma.hospitalResource.create({ data: { hospitalId, ...data } });
  await syncHospitalToGraph(hospitalId);
  return resource;
}

async function assertHospital(hospitalId: string): Promise<void> {
  const exists = await prisma.hospital.findFirst({ where: { id: hospitalId, deletedAt: null }, select: { id: true } });
  if (!exists) throw new NotFoundError('Hospital');
}
