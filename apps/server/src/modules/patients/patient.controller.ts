import {
  fullIntakeSchema,
  patientIntakeSchema,
  symptomReportSchema,
  vitalSignsSchema,
} from '@jeevansetu/types';
import type { Request, Response } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { sendOk } from '../../lib/http.js';
import * as service from './patient.service.js';
import { parseTranscriptToStructuredData } from './voice.service.js';

export async function parseVoiceTranscript(req: Request, res: Response): Promise<void> {
  const { transcript } = req.body;
  if (typeof transcript !== 'string') {
    throw new Error('Transcript is required and must be a string');
  }
  const result = await parseTranscriptToStructuredData(transcript);
  sendOk(res, result);
}

export async function fullIntake(req: Request, res: Response): Promise<void> {
  const data = fullIntakeSchema.parse(req.body);
  const result = await service.createFullIntake(data, auditContextFrom(req));
  sendOk(res, result, 201);
}

export async function registerPatient(req: Request, res: Response): Promise<void> {
  const data = patientIntakeSchema.parse(req.body);
  const patient = await service.registerPatient(data, auditContextFrom(req));
  sendOk(res, patient, 201);
}

export async function recordVitals(req: Request, res: Response): Promise<void> {
  const data = vitalSignsSchema.parse(req.body);
  const vitals = await service.recordVitals(req.params.visitId!, data, auditContextFrom(req));
  sendOk(res, vitals, 201);
}

export async function recordSymptoms(req: Request, res: Response): Promise<void> {
  const data = symptomReportSchema.parse(req.body);
  const symptoms = await service.recordSymptoms(req.params.visitId!, data, auditContextFrom(req));
  sendOk(res, symptoms, 201);
}

export async function getPatient(req: Request, res: Response): Promise<void> {
  sendOk(res, await service.getPatient(req.params.patientId!));
}

export async function getVisit(req: Request, res: Response): Promise<void> {
  sendOk(res, await service.getVisit(req.params.visitId!));
}

export async function listPatients(req: Request, res: Response): Promise<void> {
  const page = Number(req.query.page ?? 1);
  const pageSize = Math.min(Number(req.query.pageSize ?? 20), 100);
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  sendOk(res, await service.listPatients(page, pageSize, search));
}
