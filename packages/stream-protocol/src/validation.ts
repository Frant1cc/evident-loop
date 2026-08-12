import { PROTOCOL_VERSION, type StreamEventEnvelope } from './envelope.js';

export class ProtocolVersionError extends Error {
  constructor(readonly received: unknown) {
    super(`Unsupported stream protocol version: ${String(received)} (expected ${PROTOCOL_VERSION})`);
    this.name = 'ProtocolVersionError';
  }
}

/** Fail loudly on an incompatible protocol version instead of silently ignoring. */
export function assertProtocolVersion(version: unknown): asserts version is typeof PROTOCOL_VERSION {
  if (version !== PROTOCOL_VERSION) throw new ProtocolVersionError(version);
}

/** Minimal runtime shape check for an envelope decoded from an SSE frame. */
export function isEnvelope(value: unknown): value is StreamEventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocolVersion === PROTOCOL_VERSION &&
    typeof candidate.streamId === 'string' &&
    typeof candidate.sequence === 'number' &&
    Number.isInteger(candidate.sequence) &&
    typeof candidate.type === 'string' &&
    typeof candidate.occurredAt === 'string' &&
    'payload' in candidate
  );
}
