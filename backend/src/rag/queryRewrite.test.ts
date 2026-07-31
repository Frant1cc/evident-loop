import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRewriteQueries } from './queryRewrite.js';

test('解析 JSON 或 fenced JSON，并去重、过滤原查询、限制为两条', () => {
  assert.deepEqual(
    parseRewriteQueries(
      '```json\n{"queries":["原问题","CQRS 最终一致性 读后写","CQRS 最终一致性 读后写","读模型同步延迟"]}\n```',
      '原问题'
    ),
    ['CQRS 最终一致性 读后写', '读模型同步延迟']
  );
});

test('非法或非结构化输出不猜测改写内容', () => {
  assert.deepEqual(parseRewriteQueries('建议搜索 CQRS', '原问题'), []);
  assert.deepEqual(parseRewriteQueries('{"queries":"CQRS"}', '原问题'), []);
});
