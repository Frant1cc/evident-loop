import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeSseEvent, parseSseChunk, type SseMessage } from './sse.js';

test('encodes and incrementally parses SSE events', () => {
  const messages: SseMessage[] = [];
  let buffer = '';

  buffer = parseSseChunk(`${buffer}id: 7\r\nevent: progress\r\ndata: {"done":`, (message) => messages.push(message));
  assert.equal(messages.length, 0);

  buffer = parseSseChunk(`${buffer}true}\r\n\r\n: heartbeat\n\ndata: first\ndata: second\n\n`, (message) => messages.push(message));

  assert.equal(buffer, '');
  assert.deepEqual(messages, [
    { event: 'progress', data: '{"done":true}', id: '7' },
    { event: 'message', data: 'first\nsecond' }
  ]);
});

test('encodes one complete JSON SSE frame', () => {
  assert.equal(
    encodeSseEvent('done', { ok: true }, '9'),
    'id: 9\nevent: done\ndata: {"ok":true}\n\n'
  );
  assert.throws(() => encodeSseEvent('bad\nevent', {}), /single line/);
});
