import { EventEmitter } from 'node:events';

import type { StreamEventEnvelope } from '@evident-loop/stream-protocol';

/**
 * In-memory fan-out for persisted stream events. Producers call `publish` after
 * the event has been durably appended; online subscribers receive the same
 * envelope. Reconnecting clients recover missed events from the event store,
 * not from this hub.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function channel(streamId: string) {
  return `stream:${streamId}`;
}

export function publishStreamEvent(envelope: StreamEventEnvelope) {
  emitter.emit(channel(envelope.streamId), envelope);
}

export function subscribeToStream(
  streamId: string,
  listener: (envelope: StreamEventEnvelope) => void
): () => void {
  const name = channel(streamId);
  emitter.on(name, listener);
  return () => emitter.off(name, listener);
}
