import type { Server as HttpServer } from 'node:http';

import { Server as SocketServer } from 'socket.io';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { registerSink, type RealtimeEvent } from './events.js';

/**
 * Phase 14 — Realtime WebSocket gateway. Bridges the domain event bus to
 * connected dashboard clients. Clients join rooms by topic (e.g. "metrics",
 * "emergency") so each dashboard subscribes only to the streams it renders.
 */
export function attachRealtime(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    path: '/realtime',
  });

  io.on('connection', (socket) => {
    logger.debug({ socketId: socket.id }, 'Realtime client connected');
    socket.on('subscribe', (topic: string) => {
      if (typeof topic === 'string') void socket.join(topic);
    });
    socket.on('unsubscribe', (topic: string) => {
      if (typeof topic === 'string') void socket.leave(topic);
    });
  });

  // Fan domain events out to the matching room.
  const roomFor: Record<RealtimeEvent, string> = {
    notification: 'notifications',
    emergency: 'emergency',
    metrics: 'metrics',
    capacity: 'capacity',
    triage: 'triage',
    referral: 'referral',
  };

  registerSink((event, payload) => {
    io.to(roomFor[event]).emit(event, payload);
  });

  return io;
}
