import type { StreamEventEnvelope } from '@evident-loop/stream-protocol';

export type { StreamEventEnvelope };

export type StreamConnectionState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'failed'
  | 'completed';
