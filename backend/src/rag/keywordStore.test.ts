import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFtsQuery, createKeywordStore, segmentForFts, type SqliteLike } from './keywordStore.js';
import type { DocumentChunk } from './types.js';

// 测试环境自适应：本机（已安装依赖）用 better-sqlite3，无原生依赖的环境退回 node:sqlite（Node >= 22.5）。
async function openMemoryDb(): Promise<SqliteLike> {
  try {
    const { default: Database } = await import('better-sqlite3');
    return new Database(':memory:') as unknown as SqliteLike;
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(':memory:') as unknown as SqliteLike;
  }
}

function chunk(partial: Partial<DocumentChunk> & Pick<DocumentChunk, 'id' | 'file' | 'content'>): DocumentChunk {
  return {
    title: partial.title ?? '测试文档',
    heading: partial.heading,
    startLine: partial.startLine ?? 1,
    endLine: partial.endLine ?? 10,
    ...partial
  };
}

test('segmentForFts 在 CJK 字符间插入空格且保留 ASCII 整词', () => {
  assert.equal(segmentForFts('修正久期'), '修 正 久 期');
  assert.equal(segmentForFts('Kafka 分区内有序'), 'Kafka 分 区 内 有 序');
  assert.equal(segmentForFts('enable.idempotence 配置'), 'enable.idempotence 配 置');
  assert.equal(segmentForFts('  多   个空 格  '), '多 个 空 格');
  assert.equal(segmentForFts('DV01'), 'DV01');
});

test('buildFtsQuery 把 CJK 段构造成重叠二元组短语、ASCII 保持词条', () => {
  assert.equal(buildFtsQuery('修正久期'), '"修 正" OR "正 久" OR "久 期"');
  assert.equal(buildFtsQuery('Kafka 的 offset 提交'), '"Kafka" OR "的" OR "offset" OR "提 交"');
  assert.equal(buildFtsQuery('enable.idempotence'), '"enable.idempotence"');
  assert.equal(buildFtsQuery('a "quoted" term'), '"a" OR "quoted" OR "term"');
  assert.equal(buildFtsQuery('！？。'), undefined);
  assert.equal(buildFtsQuery(''), undefined);
});

test('FTS5 端到端：中文短语命中目标 chunk 且按 BM25 排序', async () => {
  const store = createKeywordStore(await openMemoryDb());
  store.replaceFileChunks('main', 'bond.md', [
    chunk({
      id: 'bond.md:17-25',
      file: 'bond.md',
      title: '债券久期',
      heading: 'Modified Duration',
      content: '修正久期把 Macaulay Duration 调整为价格对收益率小幅变化的一阶敏感度。'
    }),
    chunk({
      id: 'bond.md:27-35',
      file: 'bond.md',
      heading: 'DV01',
      content: 'DV01 表示收益率变化 1 个基点时价格变化的金额。'
    })
  ]);
  store.replaceFileChunks('main', 'cache.md', [
    chunk({
      id: 'cache.md:5-9',
      file: 'cache.md',
      heading: '缓存穿透',
      content: '缓存穿透指请求持续查询本来就不存在的数据。'
    })
  ]);

  const results = store.searchKeyword('修正久期的定义', 5, 'main');
  assert.ok(results.length >= 1);
  assert.equal(results[0]?.id, 'bond.md:17-25');
  assert.ok(results[0]!.keywordScore > 0);

  const dv01 = store.searchKeyword('DV01', 5, 'main');
  assert.equal(dv01[0]?.id, 'bond.md:27-35');
});

test('FTS5 端到端：章节标题权重高于正文', async () => {
  const store = createKeywordStore(await openMemoryDb());
  store.replaceFileChunks('main', 'doc.md', [
    chunk({ id: 'a', file: 'doc.md', heading: '缓存击穿', content: '本节讲互斥重建与逻辑过期。' }),
    chunk({ id: 'b', file: 'doc.md', heading: '监控', content: '缓存击穿相关的告警在这里只是顺带提到，缓存击穿一词出现两次。' })
  ]);

  const results = store.searchKeyword('缓存击穿', 5, 'main');
  assert.equal(results[0]?.id, 'a', '标题命中应排在正文命中之前');
});

test('collection 隔离：rag_eval 与生产互不可见', async () => {
  const store = createKeywordStore(await openMemoryDb());
  store.replaceFileChunks('knowledge_chunks', 'a.md', [chunk({ id: 'prod', file: 'a.md', content: '生产环境的库存扣减' })]);
  store.replaceFileChunks('rag_eval', 'a.md', [chunk({ id: 'eval', file: 'a.md', content: '评测环境的库存扣减' })]);

  const prod = store.searchKeyword('库存扣减', 5, 'knowledge_chunks');
  const evalHits = store.searchKeyword('库存扣减', 5, 'rag_eval');
  assert.deepEqual(prod.map((item) => item.id), ['prod']);
  assert.deepEqual(evalHits.map((item) => item.id), ['eval']);
});

test('replaceFileChunks 幂等替换，deleteFilesNotIn 清理陈旧文档', async () => {
  const store = createKeywordStore(await openMemoryDb());
  store.replaceFileChunks('main', 'a.md', [chunk({ id: 'a1', file: 'a.md', content: '旧版本内容 alpha' })]);
  store.replaceFileChunks('main', 'a.md', [chunk({ id: 'a2', file: 'a.md', content: '新版本内容 beta' })]);
  store.replaceFileChunks('main', 'b.md', [chunk({ id: 'b1', file: 'b.md', content: '另一篇 gamma' })]);

  assert.equal(store.countChunks('main'), 2);
  assert.equal(store.searchKeyword('alpha', 5, 'main').length, 0, '旧 chunk 应被替换删除');
  assert.equal(store.searchKeyword('beta', 5, 'main')[0]?.id, 'a2');

  store.deleteFilesNotIn('main', ['b.md']);
  assert.equal(store.countChunks('main'), 1);
  assert.equal(store.searchKeyword('gamma', 5, 'main')[0]?.id, 'b1');

  store.deleteFilesNotIn('main', []);
  assert.equal(store.countChunks('main'), 0);
});

test('deleteFileChunks 只删除指定文档', async () => {
  const store = createKeywordStore(await openMemoryDb());
  store.replaceFileChunks('main', 'a.md', [chunk({ id: 'a1', file: 'a.md', content: '甲文档' })]);
  store.replaceFileChunks('main', 'b.md', [chunk({ id: 'b1', file: 'b.md', content: '乙文档' })]);

  store.deleteFileChunks('main', 'a.md');
  assert.equal(store.countChunks('main'), 1);
  assert.equal(store.searchKeyword('乙文档', 5, 'main')[0]?.id, 'b1');
});

test('特殊字符查询不会导致 FTS 语法错误', async () => {
  const store = createKeywordStore(await openMemoryDb());
  store.replaceFileChunks('main', 'a.md', [chunk({ id: 'a1', file: 'a.md', content: 'WHERE id = ? AND version = ? 的条件更新' })]);

  assert.doesNotThrow(() => store.searchKeyword('version = ?" OR "', 5, 'main'));
  assert.doesNotThrow(() => store.searchKeyword('NOT AND OR (grouping)', 5, 'main'));
  assert.equal(store.searchKeyword('！？。', 5, 'main').length, 0);
});
