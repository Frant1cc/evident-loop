import assert from 'node:assert/strict';
import test from 'node:test';

import { assessClaimCoverage, extractWebClaims } from './claims.js';

test('extracts answerable claims and ignores citation instructions', () => {
  const claims = extractWebClaims(
    '请联网查询 search_depth 的可选值、每种模式的定位和价格差异，只根据官方文档回答并给出来源。'
  );

  assert.deepEqual(claims.map((claim) => claim.text), [
    'search_depth 的可选值',
    '每种模式的定位和价格差异'
  ]);
});

test('reports partial coverage and the unsupported claim', () => {
  const claims = extractWebClaims('查询 basic 模式的定位、advanced 模式的价格');
  const coverage = assessClaimCoverage(claims, [
    { url: 'https://docs.example.com/search', content: 'basic 模式的定位是控制搜索成本。' }
  ]);

  assert.equal(coverage.claims.length, 2);
  assert.equal(coverage.supportedClaimRatio, 0.5);
  assert.deepEqual(coverage.uncoveredClaims, ['advanced 模式的价格']);
});

test('does not treat an unrelated pricing article as evidence for API depth pricing', () => {
  const claims = extractWebClaims(
    'Tavily搜索API中search_depth参数有哪些可选值？"basic"和"advanced"两种搜索深度分别有什么作用？依据Tavily官方文档，二者在计费/定价上有什么区别？'
  );
  const coverage = assessClaimCoverage(claims, [
    {
      url: 'https://www.tavily.com/blog/tavily-on-x402',
      content: 'Tavily advanced search through x402 costs 0.01 dollars per call.'
    },
    {
      url: 'https://docs.tavily.com/documentation/api-credits',
      content: 'API credits: basic search costs 1 credit and advanced search costs 2 credits.'
    }
  ]);

  assert.deepEqual(coverage.claims.map((claim) => claim.text), [
    'Tavily搜索API中search_depth参数有哪些可选值',
    '"basic"和"advanced"两种搜索深度分别有什么作用',
    'basic 和 advanced 在计费/定价上有什么区别'
  ]);
  assert.equal(coverage.claims[2]?.supported, true);
  assert.deepEqual(coverage.claims[2]?.sourceUrls, ['https://docs.tavily.com/documentation/api-credits']);
});
