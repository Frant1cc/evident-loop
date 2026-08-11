import { sqlite } from '../db.js';

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let deleteStatement: ReturnType<typeof sqlite.prepare> | undefined;

/** Delete persisted events older than the retention window. */
export function deleteStreamEventsBefore(isoTime: string): number {
  deleteStatement ??= sqlite.prepare('DELETE FROM stream_events WHERE occurred_at < ?');
  return deleteStatement.run(isoTime).changes;
}

export function pruneExpiredStreamEvents(retentionMs = DEFAULT_RETENTION_MS): number {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  return deleteStreamEventsBefore(cutoff);
}

/** Start a periodic cleanup timer. Returns a stop function. */
export function startStreamEventCleanup(
  options: { retentionMs?: number; intervalMs?: number } = {}
): () => void {
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const intervalMs = options.intervalMs ?? CLEANUP_INTERVAL_MS;
  pruneExpiredStreamEvents(retentionMs);
  const timer = setInterval(() => pruneExpiredStreamEvents(retentionMs), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
