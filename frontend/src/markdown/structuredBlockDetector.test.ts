import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advance,
  createDetectorState,
  detectFenceOpen,
  finalize,
  isFenceClose,
  isTableSeparator,
  looksLikeTableHeader,
  parseAlignments,
  splitTableRow,
  type CodeSegment,
  type Segment,
  type TableSegment
} from './structuredBlockDetector';

function segmentsOf(...chunks: string[]): Segment[] {
  const state = createDetectorState();
  let content = '';
  for (const chunk of chunks) {
    content += chunk;
    advance(state, content);
  }
  return state.segments;
}

test('detectFenceOpen needs three fence chars', () => {
  assert.equal(detectFenceOpen('`'), null);
  assert.equal(detectFenceOpen('``'), null);
  assert.deepEqual(detectFenceOpen('```'), { fenceChar: '`', fenceLen: 3, language: '' });
  assert.deepEqual(detectFenceOpen('~~~'), { fenceChar: '~', fenceLen: 3, language: '' });
  assert.deepEqual(detectFenceOpen('```ts'), { fenceChar: '`', fenceLen: 3, language: 'ts' });
});

test('isFenceClose matches only a bare run of the same char', () => {
  assert.ok(isFenceClose('```', '`', 3));
  assert.ok(isFenceClose('  ```  ', '`', 3));
  assert.ok(!isFenceClose('```', '~', 3));
  assert.ok(!isFenceClose('``', '`', 3));
  assert.ok(!isFenceClose('``` js', '`', 3));
});

test('a code block appears immediately on the opening fence', () => {
  const segments = segmentsOf('```ts\n');
  assert.equal(segments.length, 1);
  const code = segments[0] as CodeSegment;
  assert.equal(code.kind, 'code');
  assert.equal(code.language, 'ts');
  assert.equal(code.status, 'generating');
  assert.deepEqual(code.lines, []);
});

test('code fills line by line, current line separate from completed', () => {
  const segments = segmentsOf('```ts\nconst a = 1\nconst b = ');
  const code = segments[0] as CodeSegment;
  assert.deepEqual(code.lines, ['const a = 1']);
  assert.equal(code.currentLine, 'const b = ');
  assert.equal(code.status, 'generating');
});

test('closing fence completes the code block', () => {
  const segments = segmentsOf('```ts\nconst a = 1\n```\n');
  const code = segments[0] as CodeSegment;
  assert.equal(code.status, 'complete');
  assert.deepEqual(code.lines, ['const a = 1']);
  assert.equal(code.currentLine, '');
});

test('finalize repairs an unclosed fence and keeps the content', () => {
  const state = createDetectorState();
  advance(state, '```ts\nconst a = 1\nconst b = 2');
  finalize(state);
  const code = state.segments[0] as CodeSegment;
  assert.equal(code.status, 'repaired');
  assert.deepEqual(code.lines, ['const a = 1', 'const b = 2']);
});

test('frozen segment keeps its id as the tail grows', () => {
  const state = createDetectorState();
  advance(state, 'hello\n\n```ts\n');
  const firstId = state.segments[0]!.id;
  advance(state, 'hello\n\n```ts\nconst a = 1\n');
  assert.equal(state.segments[0]!.id, firstId);
});

test('table separator recognition', () => {
  assert.ok(isTableSeparator('| --- | --- |'));
  assert.ok(isTableSeparator('|:--|--:|:-:|'));
  assert.ok(!isTableSeparator('| name | role |'));
  assert.ok(!isTableSeparator('just text'));
});

test('header alone is not yet a table', () => {
  const segments = segmentsOf('| name | role |\n');
  assert.equal(segments[0]!.kind, 'markdown');
});

test('header plus separator confirms a table immediately', () => {
  const segments = segmentsOf('| name | role |\n| --- | --- |\n');
  const table = segments[0] as TableSegment;
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.headerCells, ['name', 'role']);
  assert.deepEqual(table.completedRows, []);
  assert.equal(table.status, 'generating');
});

test('table rows append incrementally with a separate current row', () => {
  const segments = segmentsOf('| a | b |\n| --- | --- |\nSSE | push\n', 'WebSocket | duplex');
  const table = segments[0] as TableSegment;
  assert.deepEqual(table.completedRows, [['SSE', 'push']]);
  assert.deepEqual(table.currentRow, ['WebSocket', 'duplex']);
});

test('a blank line freezes the table as complete', () => {
  const segments = segmentsOf('| a | b |\n| --- | --- |\nSSE | push\n\nafter');
  const table = segments[0] as TableSegment;
  assert.equal(table.status, 'complete');
  assert.deepEqual(table.completedRows, [['SSE', 'push']]);
});

test('parseAlignments and splitTableRow', () => {
  assert.deepEqual(parseAlignments('|:--|--:|:-:|---|'), ['left', 'right', 'center', 'none']);
  assert.deepEqual(splitTableRow('| a | b\\|c | d |'), ['a', 'b|c', 'd']);
});

test('looksLikeTableHeader rejects headings and quotes', () => {
  assert.ok(looksLikeTableHeader('| a | b |'));
  assert.ok(!looksLikeTableHeader('# a | b'));
  assert.ok(!looksLikeTableHeader('> a | b'));
  assert.ok(!looksLikeTableHeader('no pipes here'));
});

test('markdown, code, and table coexist as ordered segments', () => {
  const segments = segmentsOf('intro\n\n```js\nx()\n```\n\n| a | b |\n| --- | --- |\n1 | 2\n');
  assert.deepEqual(
    segments.map((s) => s.kind),
    ['markdown', 'code', 'table']
  );
});
