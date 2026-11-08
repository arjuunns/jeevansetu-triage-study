-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('NURSE', 'DOCTOR', 'HOSPITAL_ADMIN', 'CMO', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SeverityLevel" AS ENUM ('CRITICAL', 'HIGH', 'MODERATE', 'LOW');

-- CreateEnum
CREATE TYPE "SymptomSeverity" AS ENUM ('MILD', 'MODERATE', 'SEVERE');

-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('REGISTERED', 'SAFETY_SCREENED', 'TRIAGED', 'UNDER_REVIEW', 'APPROVED', 'REFERRED', 'ADMITTED', 'DISCHARGED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewAction" AS ENUM ('APPROVE', 'MODIFY', 'OVERRIDE', 'REJECT');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('DRAFT', 'GENERATED', 'SENT', 'ACKNOWLEDGED', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReferralDocFormat" AS ENUM ('PDF', 'FHIR_JSON', 'QR_CODE');

-- CreateEnum
CREATE TYPE "EmergencyLevel" AS ENUM ('NONE', 'BASIC', 'INTERMEDIATE', 'ADVANCED', 'COMPREHENSIVE');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('EMERGENCY_ALERT', 'REFERRAL_GENERATED', 'DOCTOR_REVIEW_REQUIRED', 'CAPACITY_WARNING', 'ROUTING_COMPLETED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('PATIENT_CREATED', 'PATIENT_UPDATED', 'VITALS_RECORDED', 'VITALS_UPDATED', 'SYMPTOMS_RECORDED', 'VISIT_CREATED', 'SAFETY_SCREEN_EXECUTED', 'AI_TRIAGE_EXECUTED', 'GUIDELINES_RETRIEVED', 'DOCTOR_REVIEW_STARTED', 'DOCTOR_APPROVED', 'DOCTOR_MODIFIED', 'DOCTOR_OVERRIDDEN', 'DOCTOR_REJECTED', 'ROUTING_EXECUTED', 'HOSPITAL_ASSIGNED', 'REFERRAL_GENERATED', 'CAPACITY_UPDATED', 'GUIDELINE_UPLOADED', 'USER_ROLE_CHANGED');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('PATIENT_INTAKE', 'TRIAGE', 'GUIDELINE_RETRIEVAL', 'RISK_ASSESSMENT', 'ROUTING', 'REFERRAL_GENERATION', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "AgentExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REJECTED_BY_SUPERVISOR');

-- CreateEnum
CREATE TYPE "GuidelineSource" AS ENUM ('WHO', 'ICMR', 'ESI', 'MTS', 'AIIMS', 'OTHER');

-- CreateEnum
CREATE TYPE "GuidelineStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'INDEXED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmergencyAlertStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'NURSE',
    "hospitalId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "mrn" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "gender" "Gender" NOT NULL,
    "phone" TEXT,
    "bloodGroup" "BloodGroup" NOT NULL DEFAULT 'UNKNOWN',
    "heightCm" DOUBLE PRECISION,
    "weightKg" DOUBLE PRECISION,
    "allergies" TEXT[],
    "existingDiseases" TEXT[],
    "medications" TEXT[],
    "registeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_histories" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "diagnosedAt" TIMESTAMP(3),
    "notes" TEXT,
    "isChronic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "medical_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visits" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" "VisitStatus" NOT NULL DEFAULT 'REGISTERED',
    "chiefComplaint" TEXT,
    "arrivalAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vital_signs" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "temperatureC" DOUBLE PRECISION,
    "oxygenSaturation" INTEGER,
    "heartRate" INTEGER,
    "respiratoryRate" INTEGER,
    "systolicBp" INTEGER,
    "diastolicBp" INTEGER,
    "glasgowComaScale" INTEGER,
    "isUnconscious" BOOLEAN NOT NULL DEFAULT false,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vital_signs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symptoms" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "severity" "SymptomSeverity" NOT NULL DEFAULT 'MODERATE',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "duration" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "symptoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hospitals" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "phone" TEXT,
    "emergencyLevel" "EmergencyLevel" NOT NULL DEFAULT 'BASIC',
    "isTraumaCenter" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "hospitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialists" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "departmentId" TEXT,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "registrationNo" TEXT,
    "isOnDuty" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "specialists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hospital_capacities" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "icuBedsTotal" INTEGER NOT NULL DEFAULT 0,
    "icuBedsAvailable" INTEGER NOT NULL DEFAULT 0,
    "generalBedsTotal" INTEGER NOT NULL DEFAULT 0,
    "generalBedsAvailable" INTEGER NOT NULL DEFAULT 0,
    "ventilatorsTotal" INTEGER NOT NULL DEFAULT 0,
    "ventilatorsAvailable" INTEGER NOT NULL DEFAULT 0,
    "ambulancesTotal" INTEGER NOT NULL DEFAULT 0,
    "ambulancesAvailable" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "hospital_capacities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hospital_resources" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "isOperational" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "hospital_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triage_assessments" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "safetyIsCritical" BOOLEAN NOT NULL DEFAULT false,
    "safetyForcedSeverity" "SeverityLevel",
    "safetyTriggeredRules" JSONB NOT NULL DEFAULT '[]',
    "aiSeverity" "SeverityLevel",
    "esiLevel" INTEGER,
    "aiConfidence" DOUBLE PRECISION,
    "recommendedDepartment" TEXT,
    "possibleConditions" JSONB NOT NULL DEFAULT '[]',
    "recommendedTests" TEXT[],
    "riskFactors" TEXT[],
    "redFlags" TEXT[],
    "finalSeverity" "SeverityLevel",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "triage_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_reasonings" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "reasoningText" TEXT NOT NULL,
    "rawOutput" JSONB NOT NULL,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_reasonings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guideline_citations" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "guidelineId" TEXT,
    "chunkId" TEXT,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "page" INTEGER,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guideline_citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triage_decisions" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "finalSeverity" "SeverityLevel" NOT NULL,
    "decidedByAi" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triage_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_reviews" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "action" "ReviewAction" NOT NULL,
    "justification" TEXT,
    "overrideSeverity" "SeverityLevel",
    "overrideDepartment" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "doctor_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hospital_routings" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "selectedHospitalId" TEXT,
    "rankedCandidates" JSONB NOT NULL DEFAULT '[]',
    "weightsUsed" JSONB NOT NULL,
    "requiredDepartment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "hospital_routings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "hospitalId" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'DRAFT',
    "referralCode" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_documents" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "format" "ReferralDocFormat" NOT NULL,
    "url" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "referral_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guidelines" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" "GuidelineSource" NOT NULL,
    "version" TEXT,
    "description" TEXT,
    "s3Key" TEXT,
    "status" "GuidelineStatus" NOT NULL DEFAULT 'UPLOADING',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "guidelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guideline_chunks" (
    "id" TEXT NOT NULL,
    "guidelineId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "page" INTEGER,
    "tokenCount" INTEGER,
    "vectorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guideline_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT,
    "previousState" JSONB,
    "newState" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_executions" (
    "id" TEXT NOT NULL,
    "visitId" TEXT,
    "agentType" "AgentType" NOT NULL,
    "status" "AgentExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "supervisorVerdict" JSONB,
    "latencyMs" INTEGER,
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_alerts" (
    "id" TEXT NOT NULL,
    "visitId" TEXT,
    "status" "EmergencyAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "severity" "SeverityLevel" NOT NULL DEFAULT 'CRITICAL',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "triggeredRules" TEXT[],
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emergency_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_metrics" (
    "id" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalPatients" INTEGER NOT NULL DEFAULT 0,
    "criticalPatients" INTEGER NOT NULL DEFAULT 0,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "avgTriageSeconds" DOUBLE PRECISION,
    "routingSuccessRate" DOUBLE PRECISION,
    "overrideRate" DOUBLE PRECISION,
    "avgAiConfidence" DOUBLE PRECISION,
    "hospitalOccupancy" DOUBLE PRECISION,
    "dimensions" JSONB,

    CONSTRAINT "system_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerkUserId_key" ON "users"("clerkUserId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_hospitalId_idx" ON "users"("hospitalId");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "patients_mrn_key" ON "patients"("mrn");

-- CreateIndex
CREATE INDEX "patients_phone_idx" ON "patients"("phone");

-- CreateIndex
CREATE INDEX "patients_registeredById_idx" ON "patients"("registeredById");

-- CreateIndex
CREATE INDEX "patients_deletedAt_idx" ON "patients"("deletedAt");

-- CreateIndex
CREATE INDEX "patients_createdAt_idx" ON "patients"("createdAt");

-- CreateIndex
CREATE INDEX "medical_histories_patientId_idx" ON "medical_histories"("patientId");

-- CreateIndex
CREATE INDEX "medical_histories_deletedAt_idx" ON "medical_histories"("deletedAt");

-- CreateIndex
CREATE INDEX "visits_patientId_idx" ON "visits"("patientId");

-- CreateIndex
CREATE INDEX "visits_status_idx" ON "visits"("status");

-- CreateIndex
CREATE INDEX "visits_arrivalAt_idx" ON "visits"("arrivalAt");

-- CreateIndex
CREATE INDEX "visits_deletedAt_idx" ON "visits"("deletedAt");

-- CreateIndex
CREATE INDEX "vital_signs_visitId_idx" ON "vital_signs"("visitId");

-- CreateIndex
CREATE INDEX "vital_signs_recordedAt_idx" ON "vital_signs"("recordedAt");

-- CreateIndex
CREATE INDEX "symptoms_visitId_idx" ON "symptoms"("visitId");

-- CreateIndex
CREATE INDEX "symptoms_isPrimary_idx" ON "symptoms"("isPrimary");

-- CreateIndex
CREATE INDEX "hospitals_emergencyLevel_idx" ON "hospitals"("emergencyLevel");

-- CreateIndex
CREATE INDEX "hospitals_isTraumaCenter_idx" ON "hospitals"("isTraumaCenter");

-- CreateIndex
CREATE INDEX "hospitals_latitude_longitude_idx" ON "hospitals"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "hospitals_deletedAt_idx" ON "hospitals"("deletedAt");

-- CreateIndex
CREATE INDEX "departments_hospitalId_idx" ON "departments"("hospitalId");

-- CreateIndex
CREATE INDEX "departments_deletedAt_idx" ON "departments"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "departments_hospitalId_name_key" ON "departments"("hospitalId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "specialists_userId_key" ON "specialists"("userId");

-- CreateIndex
CREATE INDEX "specialists_hospitalId_idx" ON "specialists"("hospitalId");

-- CreateIndex
CREATE INDEX "specialists_departmentId_idx" ON "specialists"("departmentId");

-- CreateIndex
CREATE INDEX "specialists_specialty_idx" ON "specialists"("specialty");

-- CreateIndex
CREATE INDEX "specialists_deletedAt_idx" ON "specialists"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "hospital_capacities_hospitalId_key" ON "hospital_capacities"("hospitalId");

-- CreateIndex
CREATE INDEX "hospital_capacities_hospitalId_idx" ON "hospital_capacities"("hospitalId");

-- CreateIndex
CREATE INDEX "hospital_resources_hospitalId_idx" ON "hospital_resources"("hospitalId");

-- CreateIndex
CREATE INDEX "hospital_resources_name_idx" ON "hospital_resources"("name");

-- CreateIndex
CREATE UNIQUE INDEX "triage_assessments_visitId_key" ON "triage_assessments"("visitId");

-- CreateIndex
CREATE INDEX "triage_assessments_visitId_idx" ON "triage_assessments"("visitId");

-- CreateIndex
CREATE INDEX "triage_assessments_aiSeverity_idx" ON "triage_assessments"("aiSeverity");

-- CreateIndex
CREATE INDEX "triage_assessments_finalSeverity_idx" ON "triage_assessments"("finalSeverity");

-- CreateIndex
CREATE INDEX "triage_assessments_safetyIsCritical_idx" ON "triage_assessments"("safetyIsCritical");

-- CreateIndex
CREATE UNIQUE INDEX "ai_reasonings_assessmentId_key" ON "ai_reasonings"("assessmentId");

-- CreateIndex
CREATE INDEX "ai_reasonings_assessmentId_idx" ON "ai_reasonings"("assessmentId");

-- CreateIndex
CREATE INDEX "guideline_citations_assessmentId_idx" ON "guideline_citations"("assessmentId");

-- CreateIndex
CREATE INDEX "guideline_citations_guidelineId_idx" ON "guideline_citations"("guidelineId");

-- CreateIndex
CREATE UNIQUE INDEX "triage_decisions_assessmentId_key" ON "triage_decisions"("assessmentId");

-- CreateIndex
CREATE INDEX "triage_decisions_assessmentId_idx" ON "triage_decisions"("assessmentId");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_reviews_assessmentId_key" ON "doctor_reviews"("assessmentId");

-- CreateIndex
CREATE INDEX "doctor_reviews_assessmentId_idx" ON "doctor_reviews"("assessmentId");

-- CreateIndex
CREATE INDEX "doctor_reviews_doctorId_idx" ON "doctor_reviews"("doctorId");

-- CreateIndex
CREATE INDEX "doctor_reviews_action_idx" ON "doctor_reviews"("action");

-- CreateIndex
CREATE UNIQUE INDEX "hospital_routings_visitId_key" ON "hospital_routings"("visitId");

-- CreateIndex
CREATE INDEX "hospital_routings_visitId_idx" ON "hospital_routings"("visitId");

-- CreateIndex
CREATE INDEX "hospital_routings_selectedHospitalId_idx" ON "hospital_routings"("selectedHospitalId");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_visitId_key" ON "referrals"("visitId");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referralCode_key" ON "referrals"("referralCode");

-- CreateIndex
CREATE INDEX "referrals_visitId_idx" ON "referrals"("visitId");

-- CreateIndex
CREATE INDEX "referrals_hospitalId_idx" ON "referrals"("hospitalId");

-- CreateIndex
CREATE INDEX "referrals_status_idx" ON "referrals"("status");

-- CreateIndex
CREATE INDEX "referrals_createdAt_idx" ON "referrals"("createdAt");

-- CreateIndex
CREATE INDEX "referral_documents_referralId_idx" ON "referral_documents"("referralId");

-- CreateIndex
CREATE INDEX "referral_documents_format_idx" ON "referral_documents"("format");

-- CreateIndex
CREATE INDEX "guidelines_source_idx" ON "guidelines"("source");

-- CreateIndex
CREATE INDEX "guidelines_status_idx" ON "guidelines"("status");

-- CreateIndex
CREATE INDEX "guidelines_deletedAt_idx" ON "guidelines"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "guideline_chunks_vectorId_key" ON "guideline_chunks"("vectorId");

-- CreateIndex
CREATE INDEX "guideline_chunks_guidelineId_idx" ON "guideline_chunks"("guidelineId");

-- CreateIndex
CREATE UNIQUE INDEX "guideline_chunks_guidelineId_chunkIndex_key" ON "guideline_chunks"("guidelineId", "chunkIndex");

-- CreateIndex
CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");

-- CreateIndex
CREATE INDEX "notifications_type_idx" ON "notifications"("type");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "agent_executions_visitId_idx" ON "agent_executions"("visitId");

-- CreateIndex
CREATE INDEX "agent_executions_agentType_idx" ON "agent_executions"("agentType");

-- CreateIndex
CREATE INDEX "agent_executions_status_idx" ON "agent_executions"("status");

-- CreateIndex
CREATE INDEX "agent_executions_createdAt_idx" ON "agent_executions"("createdAt");

-- CreateIndex
CREATE INDEX "emergency_alerts_visitId_idx" ON "emergency_alerts"("visitId");

-- CreateIndex
CREATE INDEX "emergency_alerts_status_idx" ON "emergency_alerts"("status");

-- CreateIndex
CREATE INDEX "emergency_alerts_severity_idx" ON "emergency_alerts"("severity");

-- CreateIndex
CREATE INDEX "emergency_alerts_createdAt_idx" ON "emergency_alerts"("createdAt");

-- CreateIndex
CREATE INDEX "system_metrics_capturedAt_idx" ON "system_metrics"("capturedAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_registeredById_fkey" FOREIGN KEY ("registeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_histories" ADD CONSTRAINT "medical_histories_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symptoms" ADD CONSTRAINT "symptoms_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialists" ADD CONSTRAINT "specialists_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialists" ADD CONSTRAINT "specialists_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialists" ADD CONSTRAINT "specialists_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_capacities" ADD CONSTRAINT "hospital_capacities_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_resources" ADD CONSTRAINT "hospital_resources_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triage_assessments" ADD CONSTRAINT "triage_assessments_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reasonings" ADD CONSTRAINT "ai_reasonings_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "triage_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guideline_citations" ADD CONSTRAINT "guideline_citations_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "triage_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guideline_citations" ADD CONSTRAINT "guideline_citations_guidelineId_fkey" FOREIGN KEY ("guidelineId") REFERENCES "guidelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triage_decisions" ADD CONSTRAINT "triage_decisions_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "triage_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_reviews" ADD CONSTRAINT "doctor_reviews_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "triage_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_reviews" ADD CONSTRAINT "doctor_reviews_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_routings" ADD CONSTRAINT "hospital_routings_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_routings" ADD CONSTRAINT "hospital_routings_selectedHospitalId_fkey" FOREIGN KEY ("selectedHospitalId") REFERENCES "hospitals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_documents" ADD CONSTRAINT "referral_documents_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guideline_chunks" ADD CONSTRAINT "guideline_chunks_guidelineId_fkey" FOREIGN KEY ("guidelineId") REFERENCES "guidelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_alerts" ADD CONSTRAINT "emergency_alerts_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
