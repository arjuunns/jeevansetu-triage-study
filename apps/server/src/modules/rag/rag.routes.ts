import { GUIDELINE_SOURCES, type GuidelineSource } from '@jeevansetu/types';
import express, { Router } from 'express';

import { auditContextFrom } from '../../lib/context.js';
import { ValidationError } from '../../lib/errors.js';
import { asyncHandler, sendOk } from '../../lib/http.js';
import { putObject } from '../../lib/storage.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { extractPdfText } from './pdf-extract.js';
import { ingestGuideline, listGuidelines } from './rag.service.js';

/**
 * RAG / guideline routes (Phase 7). PDF is uploaded as the raw request body with
 * Content-Type application/pdf; metadata is passed as query parameters. This
 * keeps the ingestion endpoint dependency-light while still handling real PDFs.
 */
export const ragRouter: Router = Router();

ragRouter.use(requireAuth);

ragRouter.get(
  '/',
  requirePermission('guideline:upload'),
  asyncHandler(async (_req, res) => sendOk(res, await listGuidelines())),
);

ragRouter.post(
  '/upload',
  requirePermission('guideline:upload'),
  express.raw({ type: 'application/pdf', limit: '30mb' }),
  asyncHandler(async (req, res) => {
    const title = String(req.query.title ?? '').trim();
    const source = String(req.query.source ?? '').trim() as GuidelineSource;
    if (!title) throw new ValidationError('title query parameter is required');
    if (!GUIDELINE_SOURCES.includes(source)) {
      throw new ValidationError(`source must be one of ${GUIDELINE_SOURCES.join(', ')}`);
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError('Request body must be a PDF (Content-Type: application/pdf)');
    }

    const pdfBuffer = req.body as Buffer;
    const stored = await putObject('guidelines', `${title}.pdf`, pdfBuffer, 'application/pdf');
    const text = await extractPdfText(pdfBuffer);

    const result = await ingestGuideline({
      title,
      source,
      version: req.query.version ? String(req.query.version) : undefined,
      description: req.query.description ? String(req.query.description) : undefined,
      s3Key: stored.key,
      text,
      context: auditContextFrom(req),
    });
    sendOk(res, result, 201);
  }),
);
