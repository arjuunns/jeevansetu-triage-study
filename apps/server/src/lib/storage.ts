import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env, features } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Object storage abstraction (Phase 11 / AWS S3). Uploads to S3 when configured;
 * otherwise persists to a local `uploads/` directory and returns a file URL, so
 * referral generation works end-to-end in local development without AWS.
 */
let _s3: S3Client | null = null;

function s3(): S3Client {
  if (!_s3) _s3 = new S3Client({ region: env.AWS_REGION });
  return _s3;
}

export interface StoredObject {
  url: string;
  key: string;
  checksum: string;
  sizeBytes: number;
}

export async function putObject(
  keyPrefix: string,
  filename: string,
  body: Buffer,
  contentType: string,
): Promise<StoredObject> {
  const key = `${keyPrefix}/${randomUUID()}-${filename}`;
  const checksum = createHash('sha256').update(body).digest('hex');

  if (features.storage) {
    await s3().send(
      new PutObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
      }),
    );
    return {
      url: `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`,
      key,
      checksum,
      sizeBytes: body.byteLength,
    };
  }

  // Local fallback.
  const localPath = join(process.cwd(), 'uploads', key);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, body);
  logger.warn({ localPath }, 'S3 not configured — stored object locally');
  return { url: `/uploads/${key}`, key, checksum, sizeBytes: body.byteLength };
}

export async function getSignedDownloadUrl(key: string): Promise<string> {
  if (features.storage) {
    try {
      const command = new GetObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        Key: key,
      });
      // 1 hour expiry
      return await getSignedUrl(s3(), command, { expiresIn: 3600 });
    } catch (err) {
      logger.error({ err, key }, 'Failed to generate pre-signed S3 URL');
    }
  }
  return `/uploads/${key}`;
}

export async function signDocUrl(url: string): Promise<string> {
  if (url.includes('.amazonaws.com/')) {
    const key = url.split('.amazonaws.com/')[1];
    if (key) return getSignedDownloadUrl(key);
  } else if (url.includes('/uploads/')) {
    const key = url.split('/uploads/')[1];
    if (key) return getSignedDownloadUrl(key);
  }
  return url;
}
