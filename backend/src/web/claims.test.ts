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

test('normalizes enumeration prefixes and keeps short technical claims', () => {
  const claims = extractWebClaims(
    'SSE 长连接优化，包括心跳机制、消息压缩、缓冲设置、服务端并发控制、鉴权'
  );

  assert.deepEqual(claims.map((claim) => claim.text), [
    'SSE 长连接优化',
    '心跳机制',
    '消息压缩',
    '缓冲设置',
    '服务端并发控制',
    '鉴权'
  ]);
});

test('uses technical synonyms when assessing SSE claim coverage', () => {
  const claims = extractWebClaims('心跳机制、消息压缩、缓冲设置、服务端并发控制、鉴权');
  const coverage = assessClaimCoverage(claims, [{
    url: 'https://nginx.org/en/docs/http/ngx_http_proxy_module.html',
    content: [
      'Send a heartbeat event to keep the connection alive.',
      'Disable gzip compression for low latency.',
      'Set proxy_buffering off and X-Accel-Buffering: no.',
      'Use worker_connections as the connection limit and apply backpressure.',
      'Authentication uses an access token or secure cookie.'
    ].join('\n')
  }]);

  assert.deepEqual(coverage.uncoveredClaims, []);
});

test('recognizes English reconnection and multiplexing evidence for Chinese claims', () => {
  const claims = extractWebClaims('SSE 断线重连、多路复用、客户端优化、鉴权与超时、性能与并发优化最佳实践');
  const coverage = assessClaimCoverage(claims, [{
    url: 'https://developer.mozilla.org/docs/Web/API/Server-sent_events',
    content: [
      'EventSource provides automatic reconnection and sends Last-Event-ID when reconnecting.',
      'HTTP/2 multiplexing avoids the low per-domain connection limit.',
      'Client-side code handles onerror and calls close() when the stream is no longer needed.',
      'Authentication uses secure cookies and the proxy has an idle timeout.',
      'Non-blocking event loops improve throughput and scalability under high concurrency.'
    ].join('\n')
  }]);

  assert.deepEqual(coverage.uncoveredClaims, []);
});

test('rejects WebSocket-only evidence for SSE operational claims', () => {
  const claims = extractWebClaims('SSE 心跳保活、背压控制、压缩、负载均衡、与 WebSocket 对比');
  const coverage = assessClaimCoverage(claims, [{
    url: 'https://example.com/websocket-guide',
    content: 'WebSocket uses heartbeat, connection limits, gzip compression and load balancing.'
  }]);

  assert.deepEqual(coverage.claims.filter((claim) => claim.supported), []);
  assert.equal(coverage.subjectConsistencyRate, 0);
  assert.deepEqual(coverage.subjectMismatchUrls, ['https://example.com/websocket-guide']);
});

test('requires real backpressure semantics near the SSE subject', () => {
  const claims = extractWebClaims('SSE 背压控制');
  const unrelated = assessClaimCoverage(claims, [{
    url: 'https://example.com/limits', content: 'SSE has a maximum connection limit.'
  }]);
  const supported = assessClaimCoverage(claims, [{
    url: 'https://example.com/stream', content: 'An SSE server respects stream backpressure and waits for the drain event when the write buffer reaches highWaterMark.'
  }]);

  assert.equal(unrelated.claims[0]?.supported, false);
  assert.equal(supported.claims[0]?.supported, true);
});

test('does not combine a subject-only chunk with an unrelated fact chunk', () => {
  const claims = extractWebClaims('SSE 压缩');
  const coverage = assessClaimCoverage(claims, [
    { url: 'https://example.com/guide', content: 'SSE uses EventSource for one-way updates.' },
    { url: 'https://example.com/guide', content: 'WebSocket payload compression can use gzip.' }
  ]);

  assert.equal(coverage.claims[0]?.supported, false);
});
