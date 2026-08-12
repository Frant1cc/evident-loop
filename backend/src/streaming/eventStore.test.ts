import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb, sqlite } from '../db.js';
import { pruneExpiredStreamEvents } from './cleanup.js';
import { appendStreamEvent, getMaxSequence, listStreamEventsAfter } from './eventStore.js';
import { publishStreamEvent, subscribeToStream } from './eventHub.js';

initDb();

function freshStreamId() {
  return `test-stream-${Math.random().toString(36).slice(2)}`;
}

test('assigns monotonic sequences and persists the envelope', () => {
  const streamId = freshStreamId();
  const first = appendStreamEvent(streamId, 'assistant_delta', { content: 'a' });
  const second = appendStreamEvent(streamId, 'assistant_delta', { content: 'b' });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(getMaxSequence(streamId), 2);
  assert.equal(first.protocolVersion, 1);
  assert.deepEqual(second.payload, { content: 'b' });
});

test('lists only events after a cursor in order', () => {
  const streamId = freshStreamId();
  appendStreamEvent(streamId, 'x', { n: 1 });
  appendStreamEvent(streamId, 'x', { n: 2 });
  appendStreamEvent(streamId, 'x', { n: 3 });

  const after = listStreamEventsAfter(streamId, 1);
  assert.deepEqual(after.map((event) => event.sequence), [2, 3]);
  assert.deepEqual(after.map((event) => (event.payload as { n: number }).n), [2, 3]);
});

test('rejects duplicate (streamId, sequence) via primary key', () => {
  const streamId = freshStreamId();
  appendStreamEvent(streamId, 'x', {});
  assert.throws(
    () =>
      sqlite
        .prepare('INSERT INTO stream_events (stream_id, sequence, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)')
        .run(streamId, 1, 'x', '{}', new Date().toISOString()),
    /UNIQUE|PRIMARY/i
  );
});

test('publishes persisted events to online subscribers', () => {
  const streamId = freshStreamId();
  const received: number[] = [];
  const unsubscribe = subscribeToStream(streamId, (envelope) => received.push(envelope.sequence));

  publishStreamEvent(appendStreamEvent(streamId, 'x', {}));
  publishStreamEvent(appendStreamEvent(streamId, 'x', {}));
  unsubscribe();
  publishStreamEvent(appendStreamEvent(streamId, 'x', {}));

  assert.deepEqual(received, [1, 2]);
});

test('prunes events older than the retention window', () => {
  const streamId = freshStreamId();
  appendStreamEvent(streamId, 'x', {});
  sqlite
    .prepare('UPDATE stream_events SET occurred_at = ? WHERE stream_id = ?')
    .run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), streamId);

  const removed = pruneExpiredStreamEvents();
  assert.ok(removed >= 1);
  assert.equal(getMaxSequence(streamId), 0);
});
