import { PROTOCOL_VERSION, type StreamEventEnvelope } from '@evident-loop/stream-protocol';

import { sqlite } from '../db.js';
import type { StreamEventRow } from './types.js';

/**
 * Allocate the next monotonic sequence and persist the event atomically. The
 * sequence read and the insert run inside one transaction so concurrent writers
 * to the same stream can never collide on a sequence number. Prepared inside
 * the transaction so the module never touches the table before `initDb()`.
 */
const appendTransaction = sqlite.transaction(
  (streamId: string, type: string, occurredAt: string, payloadJson: string): number => {
    const row = sqlite
      .prepare('SELECT MAX(sequence) AS maxSequence FROM stream_events WHERE stream_id = ?')
      .get(streamId) as { maxSequence: number | null };
    const sequence = (row.maxSequence ?? 0) + 1;
    sqlite
      .prepare(
        `INSERT INTO stream_events (stream_id, sequence, event_type, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(streamId, sequence, type, payloadJson, occurredAt);
    return sequence;
  }
);

export function appendStreamEvent<TPayload>(
  streamId: string,
  type: string,
  payload: TPayload
): StreamEventEnvelope<string, TPayload> {
  const occurredAt = new Date().toISOString();
  const sequence = appendTransaction(streamId, type, occurredAt, JSON.stringify(payload));
  return { protocolVersion: PROTOCOL_VERSION, streamId, sequence, type, occurredAt, payload };
}

export function getMaxSequence(streamId: string): number {
  const row = sqlite
    .prepare('SELECT MAX(sequence) AS maxSequence FROM stream_events WHERE stream_id = ?')
    .get(streamId) as { maxSequence: number | null };
  return row.maxSequence ?? 0;
}

export function listStreamEventsAfter(streamId: string, cursor: number): StreamEventEnvelope[] {
  return sqlite
    .prepare('SELECT * FROM stream_events WHERE stream_id = ? AND sequence > ? ORDER BY sequence ASC')
    .all(streamId, cursor)
    .map((row) => toEnvelope(row as StreamEventRow));
}

function toEnvelope(row: StreamEventRow): StreamEventEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    streamId: row.stream_id,
    sequence: row.sequence,
    type: row.event_type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as unknown
  };
}
