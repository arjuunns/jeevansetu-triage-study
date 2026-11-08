/**
 * Canonical domain enums for JeevanSetu.
 *
 * These are declared as `as const` arrays with derived union types so they are
 * usable both at runtime (iteration, validation, UI dropdowns) and at the type
 * level. The Prisma schema mirrors these exact string values.
 */

export const USER_ROLES = ['NURSE', 'DOCTOR', 'HOSPITAL_ADMIN', 'CMO', 'SUPER_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'] as const;
export type Gender = (typeof GENDERS)[number];

export const BLOOD_GROUPS = [
  'A_POSITIVE',
  'A_NEGATIVE',
  'B_POSITIVE',
  'B_NEGATIVE',
  'AB_POSITIVE',
  'AB_NEGATIVE',
  'O_POSITIVE',
  'O_NEGATIVE',
  'UNKNOWN',
] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/**
 * Clinical severity. Maps loosely to ESI/MTS acuity. CRITICAL always implies an
 * immediate, possibly life-threatening condition that bypasses AI ranking.
 */
export const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/** Emergency Severity Index acuity level, 1 (most acute) .. 5 (least). */
export const ESI_LEVELS = [1, 2, 3, 4, 5] as const;
export type EsiLevel = (typeof ESI_LEVELS)[number];

export const SYMPTOM_SEVERITIES = ['MILD', 'MODERATE', 'SEVERE'] as const;
export type SymptomSeverity = (typeof SYMPTOM_SEVERITIES)[number];

export const VISIT_STATUSES = [
  'REGISTERED',
  'SAFETY_SCREENED',
  'TRIAGED',
  'UNDER_REVIEW',
  'APPROVED',
  'REFERRED',
  'ADMITTED',
  'DISCHARGED',
  'CANCELLED',
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/** Actions a doctor can take on an AI triage assessment (human-in-the-loop). */
export const REVIEW_ACTIONS = ['APPROVE', 'MODIFY', 'OVERRIDE', 'REJECT'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REFERRAL_STATUSES = [
  'DRAFT',
  'GENERATED',
  'SENT',
  'ACKNOWLEDGED',
  'ACCEPTED',
  'DECLINED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_DOC_FORMATS = ['PDF', 'FHIR_JSON', 'QR_CODE'] as const;
export type ReferralDocFormat = (typeof REFERRAL_DOC_FORMATS)[number];

/** Hospital emergency-care capability tier. */
export const EMERGENCY_LEVELS = [
  'NONE',
  'BASIC',
  'INTERMEDIATE',
  'ADVANCED',
  'COMPREHENSIVE',
] as const;
export type EmergencyLevel = (typeof EMERGENCY_LEVELS)[number];

export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_TYPES = [
  'EMERGENCY_ALERT',
  'REFERRAL_GENERATED',
  'DOCTOR_REVIEW_REQUIRED',
  'CAPACITY_WARNING',
  'ROUTING_COMPLETED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'FAILED', 'READ'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Every auditable mutation in the system. */
export const AUDIT_ACTIONS = [
  'PATIENT_CREATED',
  'PATIENT_UPDATED',
  'VITALS_RECORDED',
  'VITALS_UPDATED',
  'SYMPTOMS_RECORDED',
  'VISIT_CREATED',
  'SAFETY_SCREEN_EXECUTED',
  'AI_TRIAGE_EXECUTED',
  'GUIDELINES_RETRIEVED',
  'DOCTOR_REVIEW_STARTED',
  'DOCTOR_APPROVED',
  'DOCTOR_MODIFIED',
  'DOCTOR_OVERRIDDEN',
  'DOCTOR_REJECTED',
  'ROUTING_EXECUTED',
  'HOSPITAL_ASSIGNED',
  'REFERRAL_GENERATED',
  'CAPACITY_UPDATED',
  'GUIDELINE_UPLOADED',
  'USER_ROLE_CHANGED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The seven agents of the multi-agent triage pipeline. */
export const AGENT_TYPES = [
  'PATIENT_INTAKE',
  'TRIAGE',
  'GUIDELINE_RETRIEVAL',
  'RISK_ASSESSMENT',
  'ROUTING',
  'REFERRAL_GENERATION',
  'SUPERVISOR',
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_EXECUTION_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED_BY_SUPERVISOR',
] as const;
export type AgentExecutionStatus = (typeof AGENT_EXECUTION_STATUSES)[number];

export const GUIDELINE_SOURCES = ['WHO', 'ICMR', 'ESI', 'MTS', 'AIIMS', 'OTHER'] as const;
export type GuidelineSource = (typeof GUIDELINE_SOURCES)[number];

export const GUIDELINE_STATUSES = ['UPLOADING', 'PROCESSING', 'INDEXED', 'FAILED'] as const;
export type GuidelineStatus = (typeof GUIDELINE_STATUSES)[number];

export const EMERGENCY_ALERT_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type EmergencyAlertStatus = (typeof EMERGENCY_ALERT_STATUSES)[number];

/**
 * Role → permission matrix, encoding the user-roles section of the spec.
 * Used by RBAC guards on the server and to gate UI affordances on the client.
 */
export const PERMISSIONS = [
  'patient:register',
  'patient:read',
  'vitals:record',
  'symptoms:record',
  'recommendation:read',
  'triage:review',
  'triage:approve',
  'triage:override',
  'referral:generate',
  'hospital:manage',
  'specialist:manage',
  'capacity:update',
  'department:manage',
  'analytics:read',
  'hospitalLoad:read',
  'referralTrends:read',
  'systemPerformance:read',
  'user:manage',
  'aiSettings:manage',
  'auditLog:manage',
  'guideline:upload',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  NURSE: ['patient:register', 'patient:read', 'vitals:record', 'symptoms:record', 'recommendation:read'],
  DOCTOR: [
    'patient:read',
    'recommendation:read',
    'triage:review',
    'triage:approve',
    'triage:override',
    'referral:generate',
  ],
  HOSPITAL_ADMIN: ['hospital:manage', 'specialist:manage', 'capacity:update', 'department:manage'],
  CMO: ['analytics:read', 'hospitalLoad:read', 'referralTrends:read', 'systemPerformance:read'],
  SUPER_ADMIN: [
    'user:manage',
    'hospital:manage',
    'aiSettings:manage',
    'auditLog:manage',
    'guideline:upload',
    'patient:read',
    'analytics:read',
  ],
} as const;

/** Returns true if `role` is granted `permission`. */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
