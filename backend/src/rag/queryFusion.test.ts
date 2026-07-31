import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fuseQueryResults, mergeRewriteFallback } from './queryFusion.js';
import type { RagSource } from './types.js';

function source(id: string, semanticScore: number): RagSource {
  return {
    id,
    file: `${id}.md`,
    title: id,
    content: id,
    startLine: 1,
    endLine: 1,
    score: semanticScore,
    semanticScore
  };
}

test('跨查询 RRF 让多路重复命中排在单路第一之前', () => {
  const fused = fuseQueryResults([
    [source('original-only', 0.7), source('consensus', 0.6)],
    [source('rewrite-only', 0.8), source('consensus', 0.75)]
  ]);

  assert.equal(fused[0]?.id, 'consensus');
  assert.equal(fused[0]?.semanticScore, 0.75);
});

test('同分时优先更高语义分并保持确定性排序', () => {
  const fused = fuseQueryResults([
    [source('b', 0.5)],
    [source('a', 0.6)]
  ]);
  assert.deepEqual(fused.map((item) => item.id), ['a', 'b']);
});

test('保守回退最多提升一个强候选，并保护原始 TopK 的前两个位置', () => {
  const original = [source('original-1', 0.56), source('original-2', 0.54), source('original-3', 0.5)];
  const weakRewrite = source('wrong-rewrite', 0.57);
  const strongRewrite = source('recovered-topic', 0.72);

  assert.deepEqual(
    mergeRewriteFallback(original, [[weakRewrite]], 3).map((item) => item.id),
    original.map((item) => item.id)
  );
  assert.deepEqual(
    mergeRewriteFallback(original, [[strongRewrite]], 3).map((item) => item.id),
    ['original-1', 'original-2', 'recovered-topic']
  );
});

test('同文档强候选不覆盖原始章节', () => {
  const first = source('doc-a-1', 0.53);
  first.file = 'doc-a.md';
  const second = source('doc-b', 0.52);
  second.file = 'doc-b.md';
  const third = source('doc-a-2', 0.48);
  third.file = 'doc-a.md';
  const rewritten = source('doc-a-rewrite', 0.7);
  rewritten.file = 'doc-a.md';

  assert.deepEqual(
    mergeRewriteFallback([first, second, third], [[rewritten]], 3).map((item) => item.id),
    ['doc-a-1', 'doc-b', 'doc-a-2']
  );
});
