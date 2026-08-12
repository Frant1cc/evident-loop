export const PROTOCOL_VERSION = 1 as const;

/**
 * Uniform envelope for every resumable stream event. The envelope carries the
 * ordering and identity metadata (streamId + monotonic sequence) that the
 * client uses for deduplication, gap detection and reconnection. The concrete
 * business shape lives in `payload`.
 */
export type StreamEventEnvelope<TType extends string = string, TPayload = unknown> = {
  protocolVersion: typeof PROTOCOL_VERSION;
  streamId: string;
  sequence: number;
  type: TType;
  occurredAt: string;
  payload: TPayload;
};
