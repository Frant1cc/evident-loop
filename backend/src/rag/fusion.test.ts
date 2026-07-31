import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultRrfK, defaultRrfOptions, limitChunksPerFile, rrfFuse } from './fusion.js';
import type { KeywordSearchResult } from './keywordStore.js';
import type { RagSource } from './types.js';

function dense(id: string, file: string, score: number): RagSource {
  return { id, file, title: 't', content: `content-${id}`, startLine: 1, endLine: 5, score, semanticScore: score };
}

function keyword(id: string, file: string, keywordScore: number): KeywordSearchResult {
  return { id, file, title: 't', content: `content-${id}`, startLine: 1, endLine: 5, keywordScore };
}

test('RRF：双路命中的 chunk 排在单路命中之前（弱关键词按基础权重折减）', () => {
  const fused = rrfFuse(
    [dense('both', 'a.md', 0.8), dense('dense-only', 'b.md', 0.9)],
    [keyword('both', 'a.md', 20), keyword('kw-only', 'c.md', 18)]
  );

  assert.equal(fused[0]?.id, 'both');
  const expected = 1 / (defaultRrfK + 1) + defaultRrfOptions.keywordBaseWeight / (defaultRrfK + 1);
  assert.ok(Math.abs(fused[0]!.score - expected) < 1e-12, 'RRF 分数应为 dense 满权 + 弱关键词折减权之和');
  assert.equal(fused.length, 3, '去重后共 3 条');
});

test('RRF：强关键词命中（bm25 >= strongScore）保持满权重', () => {
  const strong = rrfFuse([], [keyword('exact', 'a.md', 54)]);
  const weak = rrfFuse([], [keyword('fuzzy', 'a.md', 20)]);
  assert.ok(Math.abs(strong[0]!.score - 1 / (defaultRrfK + 1)) < 1e-12);
  assert.ok(Math.abs(weak[0]!.score - defaultRrfOptions.keywordBaseWeight / (defaultRrfK + 1)) < 1e-12);
});

test('RRF：关键词 top1 低于 minTopScore 时整路丢弃（纯改述查询保护）', () => {
  // 复现 saga-irreversible-step-ordering 退步：关键词全是低分噪声（top1 = 9.1 < 12）
  const fused = rrfFuse(
    [dense('right', 'saga.md', 0.7), dense('second', 'outbox.md', 0.6)],
    [keyword('noise-1', 'context.md', 9.1), keyword('noise-2', 'redis.md', 8.8)]
  );

  assert.deepEqual(fused.map((item) => item.id), ['right', 'second'], '无信号关键词路不应影响 dense 排序');
  assert.ok(!fused.some((item) => item.file === 'context.md'));
});

test('RRF：保留两路原始分数供解释', () => {
  const fused = rrfFuse([dense('x', 'a.md', 0.72)], [keyword('x', 'a.md', 33.5)]);
  assert.equal(fused[0]?.semanticScore, 0.72);
  assert.equal(fused[0]?.keywordScore, 33.5);
});

test('RRF：仅关键词命中的 chunk 也进入结果（补 dense 盲区）', () => {
  const fused = rrfFuse([dense('d1', 'a.md', 0.9)], [keyword('k1', 'b.md', 40), keyword('k2', 'b.md', 20)]);
  assert.deepEqual(new Set(fused.map((item) => item.id)), new Set(['d1', 'k1', 'k2']));
  const k1 = fused.find((item) => item.id === 'k1');
  assert.equal(k1?.semanticScore, undefined, '未被向量召回的结果不应有语义分数');
});

test('RRF：噪声折减后不再挤占第二文档（复现 md-saga-vs-outbox 退步场景）', () => {
  // dense 正确地把两个期望文档排前两名；关键词 #1 正确但 #2-#4 是弱噪声
  const denseList = [
    dense('saga-right', 'saga.md', 0.71),
    dense('outbox-right', 'outbox.md', 0.66),
    dense('other', 'cache.md', 0.52)
  ];
  const keywordList = [
    keyword('saga-right', 'saga.md', 19.3),
    keyword('cache-noise', 'local-cache.md', 17.5),
    keyword('redis-noise', 'redis.md', 14.7),
    keyword('other', 'cache.md', 13.6)
  ];

  const top3 = rrfFuse(denseList, keywordList).slice(0, 3).map((item) => item.id);
  assert.ok(top3.includes('outbox-right'), '第二期望文档应保住 Top3 位置');
});

test('RRF：同分时按语义分数再按 id 决定性排序', () => {
  const tied = rrfFuse([dense('m', 'x.md', 0.6)], [keyword('n', 'y.md', 54)]);
  assert.equal(tied[0]?.id, 'm', '同 RRF 分时语义分较高者在前');
});

test('RRF：非法参数抛错', () => {
  assert.throws(() => rrfFuse([], [], { k: 0 }));
  assert.throws(() => rrfFuse([], [], { keywordBaseWeight: 1.5 }));
});

test('同文档限流：每篇文档最多保留 N 条且保持顺序', () => {
  const results = [
    dense('a1', 'a.md', 0.9),
    dense('a2', 'a.md', 0.8),
    dense('a3', 'a.md', 0.7),
    dense('b1', 'b.md', 0.6),
    dense('a4', 'a.md', 0.5),
    dense('c1', 'c.md', 0.4)
  ];

  const limited = limitChunksPerFile(results, 2);
  assert.deepEqual(limited.map((item) => item.id), ['a1', 'a2', 'b1', 'c1']);
});

test('同文档限流：baseline 失败场景——单文档挤占 Top3 时第二文档能进入', () => {
  const fused = [
    dense('tail-1', 'portfolio-tail-risk.md', 0.75),
    dense('tail-2', 'portfolio-tail-risk.md', 0.62),
    dense('tail-3', 'portfolio-tail-risk.md', 0.58),
    dense('hb-1', 'financial-markets-handbook.md', 0.55)
  ];

  const top3 = limitChunksPerFile(fused, 2).slice(0, 3);
  assert.deepEqual(top3.map((item) => item.file), [
    'portfolio-tail-risk.md',
    'portfolio-tail-risk.md',
    'financial-markets-handbook.md'
  ]);
});

test('同文档限流：maxPerFile 非法值抛错，1 为合法值', () => {
  assert.throws(() => limitChunksPerFile([], 0));
  const limited = limitChunksPerFile([dense('a1', 'a.md', 0.9), dense('a2', 'a.md', 0.8)], 1);
  assert.deepEqual(limited.map((item) => item.id), ['a1']);
});
