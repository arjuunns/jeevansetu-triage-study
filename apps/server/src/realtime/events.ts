import { logger } from '../config/logger.js';

/**
 * Lightweight realtime event bus (Phase 14). Decouples domain services from the
 * transport: services call `publish(...)`; the WebSocket layer registers a sink
 * via `registerSink(...)`. This avoids a circular dependency between services
 * and the Socket.IO server and keeps services transport-agnostic.
 */
export type RealtimeEvent =
  | 'notification'
  | 'emergency'
  | 'metrics'
  | 'capacity'
  | 'triage'
  | 'referral';

type Sink = (event: RealtimeEvent, payload: unknown) => void;

const sinks = new Set<Sink>();

export function registerSink(sink: Sink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function publish(event: RealtimeEvent, payload: unknown): void {
  for (const sink of sinks) {
    try {
      sink(event, payload);
    } catch (err) {
      logger.error({ err, event }, 'Realtime sink failed');
    }
  }
}
