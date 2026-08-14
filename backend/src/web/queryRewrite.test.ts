import assert from 'node:assert/strict';
import test from 'node:test';

import { rewriteWebQuery } from './queryRewrite.js';

test('fallback rewrite targets one uncovered claim and preserves the subject', async () => {
  const query = await rewriteWebQuery({
    question: 'SSE 连接管理、心跳保活、背压控制、压缩与负载均衡',
    previousQueries: ['SSE 最佳实践 官方文档'],
    reason: 'evidence gap',
    uncoveredClaims: ['背压控制', '压缩']
  });

  assert.equal(query, 'SSE 背压控制 官方文档');
});
