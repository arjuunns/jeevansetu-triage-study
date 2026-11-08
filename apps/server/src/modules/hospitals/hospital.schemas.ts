import { z } from 'zod';

import { EMERGENCY_LEVELS } from '@jeevansetu/types';

/** Validation schemas for hospital management (Phase 9). */

export const createHospitalSchema = z.object({
  name: z.string().trim().min(2).max(200),
  address: z.string().trim().min(5).max(400),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  phone: z.string().trim().max(20).optional(),
  emergencyLevel: z.enum(EMERGENCY_LEVELS).default('BASIC'),
  isTraumaCenter: z.boolean().default(false),
});
export type CreateHospitalInput = z.infer<typeof createHospitalSchema>;

export const updateHospitalSchema = createHospitalSchema.partial();

export const capacitySchema = z.object({
  icuBedsTotal: z.number().int().min(0).optional(),
  icuBedsAvailable: z.number().int().min(0).optional(),
  generalBedsTotal: z.number().int().min(0).optional(),
  generalBedsAvailable: z.number().int().min(0).optional(),
  ventilatorsTotal: z.number().int().min(0).optional(),
  ventilatorsAvailable: z.number().int().min(0).optional(),
  ambulancesTotal: z.number().int().min(0).optional(),
  ambulancesAvailable: z.number().int().min(0).optional(),
});
export type CapacityInput = z.infer<typeof capacitySchema>;

export const departmentSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().max(20).optional(),
  isAvailable: z.boolean().default(true),
});

export const specialistSchema = z.object({
  name: z.string().trim().min(2).max(120),
  specialty: z.string().trim().min(2).max(120),
  departmentId: z.string().optional(),
  registrationNo: z.string().trim().max(60).optional(),
  isOnDuty: z.boolean().default(false),
});

export const resourceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().max(60).optional(),
  quantity: z.number().int().min(0).default(1),
  isOperational: z.boolean().default(true),
});
