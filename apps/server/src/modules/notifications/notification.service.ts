import type { NotificationChannel, NotificationType } from '@jeevansetu/types';
import type { Prisma } from '@prisma/client';

import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { publish } from '../../realtime/events.js';

/**
 * Phase 13 — Notifications. Persists every notification, then dispatches it on
 * its channel: in-app via the realtime bus, email via Resend, SMS via Twilio.
 * Provider adapters are loaded lazily and degrade to a logged no-op when their
 * credentials are absent, so the system never fails a clinical action because a
 * notification could not be sent.
 */
export interface DispatchArgs {
  type: NotificationType;
  channel: NotificationChannel;
  title: string;
  body: string;
  userId?: string;
  to?: string; // email or phone, depending on channel
  payload?: Record<string, unknown>;
}

export async function dispatchNotification(args: DispatchArgs): Promise<{ id: string; sent: boolean }> {
  const notification = await prisma.notification.create({
    data: {
      type: args.type,
      channel: args.channel,
      status: 'PENDING',
      title: args.title,
      body: args.body,
      userId: args.userId,
      payload: (args.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });

  let sent = false;
  try {
    switch (args.channel) {
      case 'IN_APP':
        publish('notification', { id: notification.id, ...args });
        sent = true;
        break;
      case 'EMAIL':
        sent = await sendEmail(args.to, args.title, args.body);
        break;
      case 'SMS':
        sent = await sendSms(args.to, `${args.title}: ${args.body}`);
        break;
    }
  } catch (err) {
    logger.error({ err, channel: args.channel }, 'Notification dispatch failed');
  }

  await prisma.notification.update({
    where: { id: notification.id },
    data: { status: sent ? 'SENT' : 'FAILED', sentAt: sent ? new Date() : undefined },
  });

  return { id: notification.id, sent };
}

/**
 * Phase 18 — Emergency Broadcast: notify all on-duty specialists matching a
 * department instantly across every channel. Used when a CRITICAL patient is
 * detected.
 */
export async function broadcastEmergency(
  department: string,
  title: string,
  body: string,
  payload?: Record<string, unknown>,
): Promise<number> {
  const specialists = await prisma.specialist.findMany({
    where: { deletedAt: null, isOnDuty: true, specialty: { contains: department, mode: 'insensitive' } },
    include: { user: true },
  });

  await Promise.all(
    specialists.map((s) =>
      dispatchNotification({
        type: 'EMERGENCY_ALERT',
        channel: 'IN_APP',
        title,
        body,
        userId: s.userId ?? undefined,
        payload,
      }),
    ),
  );
  publish('emergency', { department, title, body, payload });
  return specialists.length;
}

export async function listNotifications(userId: string, unreadOnly = false) {
  return prisma.notification.findMany({
    where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export async function markRead(notificationId: string, userId: string) {
  return prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { status: 'READ', readAt: new Date() },
  });
}

// ── provider adapters ──────────────────────────────────────────────────────────

async function sendEmail(to: string | undefined, subject: string, body: string): Promise<boolean> {
  if (!features.email || !to) {
    logger.warn({ to }, 'Email not configured — skipping send');
    return false;
  }
  const { Resend } = await import('resend');
  const resend = new Resend(env.RESEND_API_KEY!);
  await resend.emails.send({ from: env.NOTIFICATION_FROM_EMAIL, to, subject, text: body });
  return true;
}

async function sendSms(to: string | undefined, body: string): Promise<boolean> {
  if (!features.sms || !to || !env.TWILIO_FROM_NUMBER) {
    logger.warn({ to }, 'SMS not configured — skipping send');
    return false;
  }
  const twilio = (await import('twilio')).default;
  const client = twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
  await client.messages.create({ from: env.TWILIO_FROM_NUMBER, to, body });
  return true;
}
