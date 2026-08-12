/**
 * In-memory per-stream cursor tracking the highest applied sequence. Used to
 * resume via `Last-Event-ID` and to deduplicate replayed events after a
 * reconnect. Cursors live for the page session only.
 */
const cursors = new Map<string, number>();

export function getStreamCursor(streamId: string): number {
  return cursors.get(streamId) ?? 0;
}

export function setStreamCursor(streamId: string, sequence: number): void {
  const current = cursors.get(streamId) ?? 0;
  if (sequence > current) cursors.set(streamId, sequence);
}

export function resetStreamCursor(streamId: string): void {
  cursors.delete(streamId);
}
