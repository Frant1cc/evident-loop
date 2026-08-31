import assert from 'node:assert/strict';
import test from 'node:test';

import { detectRetrievalIntent } from './intent.js';
import { buildRetrievalQueryRoute } from './routing.js';

test('separates Chinese language from China-domestic intent', () => {
  const explanatory = detectRetrievalIntent('请用中文解释 React useEffect');
  assert.equal(explanatory.chineseLanguage.matched, true);
  assert.equal(explanatory.chinaDomestic.matched, false);

  const domestic = detectRetrievalIntent('查找今天国内人工智能监管政策');
  assert.equal(domestic.freshness.matched, true);
  assert.equal(domestic.chinaDomestic.matched, true);
  assert.equal(buildRetrievalQueryRoute(domestic, { question: '查找今天国内人工智能监管政策' }).strategy, 'china_current_first');
});

test('routes a PDF URL to direct fetch and prioritizes Jina', () => {
  const question = '总结 https://arxiv.org/pdf/2401.01234.pdf';
  const intent = detectRetrievalIntent(question);
  const route = buildRetrievalQueryRoute(intent, { question });

  assert.equal(intent.knownUrl.confidence, 1);
  assert.equal(intent.pdf.matched, true);
  assert.deepEqual(intent.requiredCapabilities, ['web_fetch']);
  assert.equal(route.strategy, 'direct_fetch');
  assert.equal(route.searchRequired, false);
  assert.equal(route.providerRoutes[0]?.candidates[0]?.provider, 'jina');
});

test('keeps search enabled when an explicit URL must be verified', () => {
  const question = '核验 https://example.com/report 的说法，并找其他来源';
  const intent = detectRetrievalIntent(question);
  const route = buildRetrievalQueryRoute(intent, { question });

  assert.equal(route.strategy, 'fetch_then_verify');
  assert.equal(route.searchRequired, true);
  assert.deepEqual(intent.requiredCapabilities, ['web_fetch', 'web_search']);
  assert.equal(route.initialQueries[0]?.includes('https://'), false);
});

test('requires a strong vertical signal before enabling vertical search', () => {
  const weak = detectRetrievalIntent('帮我解释这段代码');
  assert.equal(weak.requiredCapabilities.includes('vertical_search'), false);

  const strong = detectRetrievalIntent('查询 CVE-2026-12345 的 CVSS 和漏洞影响');
  assert.equal(strong.vertical.domains.includes('security'), true);
  assert.equal(strong.requiredCapabilities.includes('vertical_search'), true);
});

test('detects official current docs without treating them as domestic', () => {
  const question = '查找最新 OpenAI Responses API 官方文档';
  const intent = detectRetrievalIntent(question);
  const route = buildRetrievalQueryRoute(intent, { question });

  assert.equal(intent.officialDocs.matched, true);
  assert.equal(intent.freshness.matched, true);
  assert.equal(intent.chinaDomestic.matched, false);
  assert.equal(route.strategy, 'official_docs_first');
  assert.equal(route.inferredTimeRange, 'month');
});

test('does not confuse keep-alive with the freshness word live', () => {
  const question = 'Server-Sent Events keep-alive heartbeat and reconnection best practices';
  const intent = detectRetrievalIntent(question);
  const route = buildRetrievalQueryRoute(intent, { question });

  assert.equal(intent.freshness.matched, false);
  assert.equal(route.strategy, 'official_docs_first');
  assert.equal(route.inferredTimeRange, undefined);
});

test('treats upcoming release language as a freshness request', () => {
  const intent = detectRetrievalIntent('OpenAI 准备发布什么模型？');
  const route = buildRetrievalQueryRoute(intent, { question: 'OpenAI 准备发布什么模型？' });
  assert.equal(intent.freshness.matched, true);
  assert.equal(route.strategy, 'current_web_first');
  assert.equal(route.inferredTimeRange, 'month');
});

test('treats multi-signal technical standards questions as official-docs-first', () => {
  const question = 'SSE 长连接的心跳、EventSource 重连和 Nginx proxy_buffering 最佳实践';
  const intent = detectRetrievalIntent(question);
  const route = buildRetrievalQueryRoute(intent, {
    question,
    plannedPreferredDomains: ['developer.mozilla.org', 'html.spec.whatwg.org', 'nginx.org']
  });

  assert.equal(intent.officialDocs.matched, true);
  assert.equal(route.strategy, 'official_docs_first');
  assert.deepEqual(route.preferredDomains, [
    'developer.mozilla.org',
    'html.spec.whatwg.org',
    'nginx.org'
  ]);
});
