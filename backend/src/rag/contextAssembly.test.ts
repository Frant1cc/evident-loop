import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeAdjacentChunks } from './contextAssembly.js';
import type { RagSource } from './types.js';

function source(id: string, file: string, startLine: number, endLine: number, content: string): RagSource {
  return {
    id,
    file,
    title: file,
    heading: id,
    headingPath: ['Parent', id],
    content,
    startLine,
    endLine,
    score: 1 - startLine / 100,
    semanticScore: 1 - startLine / 100
  };
}

test('相邻或 overlap 的命中合并为一个上下文，并保留最高排名分数', () => {
  const first = source('a', 'doc.md', 10, 20, '第一段\n共享段');
  const second = source('b', 'doc.md', 20, 30, '共享段\n第二段');
  const merged = mergeAdjacentChunks([first, second]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, 'a');
  assert.equal(merged[0]?.score, first.score);
  assert.equal(merged[0]?.content, '第一段\n共享段\n\n第二段');
  assert.deepEqual(merged[0]?.mergedChunkIds, ['a', 'b']);
  assert.deepEqual(merged[0]?.contextHeadings, ['Parent', 'a', 'b']);
  assert.equal(merged[0]?.startLine, 10);
  assert.equal(merged[0]?.endLine, 30);
});

test('不同文档或有行号间隔的命中保持独立，原排名不变', () => {
  const results = [
    source('a', 'a.md', 1, 5, 'A'),
    source('b', 'a.md', 7, 10, 'B'),
    source('c', 'b.md', 6, 8, 'C')
  ];
  assert.deepEqual(mergeAdjacentChunks(results).map((item) => item.id), ['a', 'b', 'c']);
});

test('中间块能桥接同一文档的两个相邻组件', () => {
  const merged = mergeAdjacentChunks([
    source('left', 'doc.md', 1, 5, 'left'),
    source('right', 'doc.md', 7, 10, 'right'),
    source('bridge', 'doc.md', 6, 6, 'bridge')
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.mergedChunkIds, ['left', 'bridge', 'right']);
});

test('标题和空行造成行号间隔时，使用 previous/next 元数据识别结构相邻', () => {
  const left = source('left', 'doc.md', 1, 5, 'left');
  const right = source('right', 'doc.md', 9, 12, 'right');
  left.nextChunkId = right.id;
  right.previousChunkId = left.id;
  assert.equal(mergeAdjacentChunks([left, right]).length, 1);
});

test('候选先相邻合并时受 chunk 数量限制，并按原检索排名选择邻居', () => {
  const ranked = [
    source('c', 'doc.md', 30, 39, 'C'),
    source('d', 'doc.md', 40, 49, 'D'),
    source('b', 'doc.md', 20, 29, 'B'),
    source('a', 'doc.md', 10, 19, 'A')
  ];
  ranked[0]!.previousChunkId = 'b';
  ranked[0]!.nextChunkId = 'd';
  ranked[1]!.previousChunkId = 'c';
  ranked[2]!.previousChunkId = 'a';
  ranked[2]!.nextChunkId = 'c';
  ranked[3]!.nextChunkId = 'b';

  const merged = mergeAdjacentChunks(ranked, { maxChunks: 3, maxTokens: 100 });

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0]?.mergedChunkIds, ['b', 'c', 'd']);
  assert.deepEqual(merged[1]?.mergedChunkIds, ['a']);
});

test('合并相邻块时同时合并页码与原始行号范围', () => {
  const first = source('a', 'doc.pdf', 10, 20, '第一段');
  const second = source('b', 'doc.pdf', 21, 30, '第二段');
  first.locator = { normalizedLineStart: 10, normalizedLineEnd: 20, pageStart: 12, pageEnd: 12 };
  second.locator = { normalizedLineStart: 21, normalizedLineEnd: 30, pageStart: 13, pageEnd: 13 };
  first.format = 'pdf';
  second.format = 'pdf';
  const merged = mergeAdjacentChunks([first, second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.locator?.pageStart, 12);
  assert.equal(merged[0]?.locator?.pageEnd, 13);
});
