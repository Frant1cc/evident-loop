import {
  SNAPSHOT_EVENT_TYPE,
  assertProtocolVersion,
  isEnvelope,
  isTerminalEventType,
  PROTOCOL_VERSION,
  type StreamEventEnvelope
} from '@evident-loop/stream-protocol';

import { consumeSse, parseSseJson, SseHttpError, type SseMessage } from './sse';
import { getStreamCursor, resetStreamCursor, setStreamCursor } from './streamCursorStore';
import type { StreamConnectionState } from '../types/streaming';

const retryPolicy = {
  initialDelayMs: 500,
  multiplier: 2,
  maxDelayMs: 10_000,
  jitter: 0.2,
  maxConsecutiveFailures: 6,
  idleTimeoutMs: 35_000
};

export type ResumableSseOptions = {
  url: string;
  streamId: string;
  signal: AbortSignal;
  onEvent: (envelope: StreamEventEnvelope) => void;
  onStatus?: (state: StreamConnectionState) => void;
};

/**
 * Resumable SSE consumer: reconnects with exponential backoff, resumes from the
 * last applied sequence via `Last-Event-ID`, drops duplicates, and requests a
 * fresh snapshot when it detects a sequence gap. Terminal events, aborts and
 * 4xx responses stop retrying.
 */
export async function consumeResumableSse(options: ResumableSseOptions): Promise<void> {
  let consecutiveFailures = 0;
  let completed = false;

  options.onStatus?.('connecting');

  while (!completed && !options.signal.aborted) {
    const attempt = { sawEvent: false, completed: false };
    try {
      await connectOnce(options, attempt);
      if (attempt.completed) {
        completed = true;
        options.onStatus?.('completed');
        return;
      }
      // Stream closed without a terminal event: recoverable EOF.
      throw new StreamRetryError('Stream ended before a terminal event');
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof SseHttpError && error.status >= 400 && error.status < 500) {
        options.onStatus?.('failed');
        throw error;
      }
      consecutiveFailures = attempt.sawEvent ? 1 : consecutiveFailures + 1;
      if (consecutiveFailures >= retryPolicy.maxConsecutiveFailures) {
        options.onStatus?.('failed');
        throw error instanceof Error ? error : new Error('Stream failed');
      }
      options.onStatus?.('reconnecting');
      await delay(backoffDelay(consecutiveFailures), options.signal);
      options.onStatus?.('connecting');
    }
  }
}

type AttemptState = { sawEvent: boolean; completed: boolean };

async function connectOnce(options: ResumableSseOptions, attempt: AttemptState): Promise<void> {
  const cursor = getStreamCursor(options.streamId);

  // Per-attempt controller: aborts this connection on idle timeout or when the
  // caller aborts, without disabling the outer reconnect loop.
  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  options.signal.addEventListener('abort', abortOuter, { once: true });

  let idleHandle: ReturnType<typeof setTimeout> | undefined;
  const refreshIdle = () => {
    if (idleHandle) clearTimeout(idleHandle);
    idleHandle = setTimeout(() => controller.abort(new Error('idle-timeout')), retryPolicy.idleTimeoutMs);
  };
  refreshIdle();

  const handleMessage = (message: SseMessage) => {
    if (message.event === SNAPSHOT_EVENT_TYPE) {
      const parsed = parseSseJson<Record<string, unknown> & { lastSequence?: number }>(message);
      resetStreamCursor(options.streamId);
      if (typeof parsed.lastSequence === 'number') setStreamCursor(options.streamId, parsed.lastSequence);
      attempt.sawEvent = true;
      options.onEvent(toSnapshotEnvelope(options.streamId, parsed));
      return;
    }

    const envelope = parseSseJson<unknown>(message);
    if (!isEnvelope(envelope)) return;
    assertProtocolVersion(envelope.protocolVersion);

    const applied = getStreamCursor(options.streamId);
    if (envelope.sequence <= applied) return; // duplicate, already applied
    if (envelope.sequence > applied + 1) {
      // Gap: reset cursor so the next attempt asks for a full snapshot.
      resetStreamCursor(options.streamId);
      controller.abort(new Error('sequence-gap'));
      return;
    }

    setStreamCursor(options.streamId, envelope.sequence);
    attempt.sawEvent = true;
    options.onEvent(envelope);
    if (isTerminalEventType(envelope.type)) attempt.completed = true;
  };

  try {
    await consumeSse({
      url: options.url,
      headers: cursor > 0 ? { 'Last-Event-ID': String(cursor) } : undefined,
      signal: controller.signal,
      onActivity: refreshIdle,
      onMessage: handleMessage
    });
    if (attempt.completed) options.onStatus?.('open');
  } catch (error) {
    // An abort caused by the outer signal is a real cancellation; anything else
    // (idle timeout, gap, network) is recoverable and re-thrown for retry.
    if (options.signal.aborted) return;
    throw error instanceof Error ? error : new StreamRetryError('Stream error');
  } finally {
    if (idleHandle) clearTimeout(idleHandle);
    options.signal.removeEventListener('abort', abortOuter);
  }

  // Reaching here without completion signals EOF; caller decides to retry.
  if (attempt.sawEvent && !attempt.completed) options.onStatus?.('open');
}

function toSnapshotEnvelope(streamId: string, parsed: Record<string, unknown>): StreamEventEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    streamId,
    sequence: typeof parsed.lastSequence === 'number' ? parsed.lastSequence : 0,
    type: SNAPSHOT_EVENT_TYPE,
    occurredAt: new Date().toISOString(),
    payload: parsed
  };
}

class StreamRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamRetryError';
  }
}

function backoffDelay(attempt: number): number {
  const base = Math.min(
    retryPolicy.maxDelayMs,
    retryPolicy.initialDelayMs * retryPolicy.multiplier ** (attempt - 1)
  );
  const jitter = base * retryPolicy.jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
