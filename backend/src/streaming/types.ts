import type { StreamEventEnvelope } from '@evident-loop/stream-protocol';

export type { StreamEventEnvelope };

/** Row shape for the `stream_events` table. */
export type StreamEventRow = {
  stream_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  occurred_at: string;
};
