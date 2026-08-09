import type { Response } from 'express';

export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

export type SseMessage = {
  event: string;
  data: string;
  id?: string;
};

export type SseStream = {
  readonly closed: boolean;
  send: (event: string, data: unknown, id?: string) => boolean;
  onClose: (cleanup: () => void) => () => void;
  close: () => void;
};

export function createSseStream(
  res: Response,
  options: { heartbeatMs?: number } = {}
): SseStream {
  prepareSseResponse(res);

  let closed = false;
  const cleanups = new Set<() => void>();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
        if (!closed && !res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
      }, heartbeatMs)
    : undefined;

  const finish = (endResponse: boolean) => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
    if (endResponse && !res.writableEnded && !res.destroyed) res.end();
  };

  res.once('close', () => finish(false));

  return {
    get closed() {
      return closed || res.writableEnded || res.destroyed;
    },
    send(event, data, id) {
      if (closed || res.writableEnded || res.destroyed) return false;
      res.write(encodeSseEvent(event, data, id));
      return true;
    },
    onClose(cleanup) {
      if (closed) {
        cleanup();
        return () => undefined;
      }
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    close() {
      finish(true);
    }
  };
}

export function prepareSseResponse(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function encodeSseEvent(event: string, data: unknown, id?: string) {
  assertSingleLine(event, 'event');
  if (id !== undefined) assertSingleLine(id, 'id');
  const serialized = JSON.stringify(data);
  if (serialized === undefined) throw new Error('SSE data must be JSON serializable');

  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${serialized}\n\n`;
}

export function parseSseChunk(buffer: string, onMessage: (message: SseMessage) => void) {
  let rest = buffer;

  while (true) {
    const boundary = findEventBoundary(rest);
    if (!boundary) return rest;
    const frame = rest.slice(0, boundary.index);
    rest = rest.slice(boundary.index + boundary.length);
    const message = parseSseFrame(frame);
    if (message) onMessage(message);
  }
}

function findEventBoundary(buffer: string) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseSseFrame(frame: string): SseMessage | undefined {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];

  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
    if (field === 'id' && !value.includes('\0')) id = value;
  }

  if (!data.length) return undefined;
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
}

function assertSingleLine(value: string, field: string) {
  if (!value || /[\r\n]/.test(value)) throw new Error(`SSE ${field} must be a non-empty single line`);
}
