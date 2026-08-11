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

test('parses LF, CRLF and CR frame boundaries', () => {
  const collect = (input: string) => {
    const messages: SseMessage[] = [];
    parseSseChunk(input, (message) => messages.push(message));
    return messages;
  };

  assert.deepEqual(collect('event: a\ndata: 1\n\n'), [{ event: 'a', data: '1' }]);
  assert.deepEqual(collect('event: b\r\ndata: 2\r\n\r\n'), [{ event: 'b', data: '2' }]);
  assert.deepEqual(collect('event: c\rdata: 3\r\r'), [{ event: 'c', data: '3' }]);
});

test('parses multi-line data, comments, id and retry fields', () => {
  const messages: SseMessage[] = [];
  const rest = parseSseChunk(
    ': keep-alive comment\nid: 42\nretry: 1500\nevent: chunk\ndata: line-one\ndata: line-two\n\n',
    (message) => messages.push(message)
  );

  assert.equal(rest, '');
  assert.deepEqual(messages, [{ event: 'chunk', data: 'line-one\nline-two', id: '42' }]);
});

test('reassembles a frame split across arbitrary chunk boundaries', () => {
  const messages: SseMessage[] = [];
  const chunks = ['id: 5\ne', 'vent: pro', 'gress\nda', 'ta: {"a":', '1}\n', '\n'];
  let buffer = '';
  for (const chunk of chunks) buffer = parseSseChunk(buffer + chunk, (message) => messages.push(message));

  assert.equal(buffer, '');
  assert.deepEqual(messages, [{ event: 'progress', data: '{"a":1}', id: '5' }]);
});
