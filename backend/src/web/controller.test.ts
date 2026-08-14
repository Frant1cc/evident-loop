import assert from 'node:assert/strict';
import test from 'node:test';

import type { FetchPageResult } from '../tools/fetchPageTool.js';
import { retrieveWebEvidence } from './controller.js';

test('rewrites a weak search and stops after high-confidence evidence is found', async () => {
  const queries: string[] = [];
  const fetchedUrls: string[] = [];
  let clock = 1_000;

  const result = await retrieveWebEvidence(
    { question: 'DeepSeek context window', maxQueries: 2, maxPages: 3 },
    {
      dependencies: {
        now: () => (clock += 10),
        rewrite: async () => 'DeepSeek context window official documentation',
        search: async ({ query }) => {
          queries.push(query);
          return query.includes('official')
            ? {
                query,
                results: [
                  {
                    title: 'DeepSeek context window official documentation',
                    url: 'https://docs.deepseek.example/models',
                    snippet: 'Official DeepSeek model context window specification.',
                    score: 0.97
                  }
                ]
              }
            : {
                query,
                results: [
                  {
                    title: 'Unrelated DeepSeek community page',
                    url: 'https://community.example/post',
                    snippet: 'General community discussion.',
                    score: 0.72
                  }
                ]
              };
        },
        fetch: async (args) => {
          const url = String((args as { url: string }).url);
          fetchedUrls.push(url);
          if (url.includes('community')) return page(url, 'Cooking notes and garden plants.'.repeat(30));
          return page(
            url,
            'DeepSeek context window official documentation. The model context window is documented here.'.repeat(20)
          );
        }
      }
    }
  );

  assert.equal(result.verdict, 'sufficient');
  assert.deepEqual(queries, ['DeepSeek context window', 'DeepSeek context window official documentation']);
  assert.equal(fetchedUrls.length, 2);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.file, 'https://docs.deepseek.example/models');
  assert.equal(result.diagnostics.stopReason, 'A high-confidence relevant source was found');
});

test('returns empty after the query budget when no relevant page is found', async () => {
  let rewriteCount = 0;
  const result = await retrieveWebEvidence(
    { question: 'specific missing fact', maxQueries: 2, maxPages: 2 },
    {
      dependencies: {
        rewrite: async () => `specific missing fact rewrite ${++rewriteCount}`,
        search: async ({ query }) => ({
          query,
          results: [
            {
              title: 'Specific topic overview',
              url: `https://example${rewriteCount}.com/page`,
              snippet: 'A generic overview without the requested fact.',
              score: 0.65
            }
          ]
        }),
        fetch: async (args) => page(String((args as { url: string }).url), 'Recipes and gardening advice.'.repeat(30))
      }
    }
  );

  assert.equal(result.verdict, 'empty');
  assert.equal(result.sources.length, 0);
  assert.equal(result.queryAttempts.length, 2);
  assert.match(result.diagnostics.stopReason, /budget exhausted/i);
});

test('expands the default budget for a single explicitly constrained domain', async () => {
  let rewriteCount = 0;
  const result = await retrieveWebEvidence(
    { question: 'official API parameter details', includeDomains: ['docs.example.com'] },
    {
      dependencies: {
        rewrite: async () => `official API parameter details ${++rewriteCount}`,
        search: async ({ query }) => ({
          query,
          results: [{
            title: 'Official API overview',
            url: `https://docs.example.com/page-${rewriteCount}`,
            snippet: 'Official API overview without the requested parameter details.',
            score: 0.7
          }]
        }),
        fetch: async (args) => page(
          String((args as { url: string }).url),
          'General navigation and unrelated release notes.'.repeat(30)
        )
      }
    }
  );

  assert.equal(result.diagnostics.queryBudget, 4);
  assert.equal(result.diagnostics.pageBudget, 8);
  assert.equal(result.diagnostics.queriesUsed, 4);
  assert.equal(result.diagnostics.budgetExhaustedBy, 'queries');
});

test('stops as soon as evaluator-required evidence points are covered', async () => {
  const queries: string[] = [];
  const result = await retrieveWebEvidence(
    {
      question: 'Search depth details', includeDomains: ['docs.example.com'], maxQueries: 4, maxPages: 8,
      requiredEvidence: [
        { id: 'values', label: 'values', groups: [['basic'], ['advanced']] },
        { id: 'cost', label: 'cost', groups: [['advanced'], ['2 credits']] }
      ]
    },
    {
      dependencies: {
        rewrite: async () => 'should never be used',
        search: async ({ query }) => {
          queries.push(query);
          return { query, results: [{ title: 'Search API', url: 'https://docs.example.com/search', snippet: 'basic advanced 2 credits', score: 0.7 }] };
        },
        fetch: async (args) => page(String((args as { url: string }).url), 'Search depth supports basic and advanced. Advanced costs 2 credits.'.repeat(10))
      }
    }
  );
  assert.equal(result.verdict, 'sufficient');
  assert.equal(result.diagnostics.queriesUsed, 1);
  assert.match(result.diagnostics.stopReason, /All required evidence points/i);
  assert.equal(queries.length, 1);
});

test('early-stops an expected-unanswerable question after two empty official searches', async () => {
  let rewrites = 0;
  const result = await retrieveWebEvidence(
    { question: 'missing quantum parameter', includeDomains: ['docs.example.com'], expectNoAnswer: true },
    {
      dependencies: {
        rewrite: async () => `missing quantum parameter ${++rewrites}`,
        search: async ({ query }) => ({ query, results: [{ title: 'Overview', url: `https://docs.example.com/${rewrites}`, snippet: 'Generic documentation', score: 0.6 }] }),
        fetch: async (args) => page(String((args as { url: string }).url), 'Unrelated release notes.'.repeat(30))
      }
    }
  );
  assert.equal(result.verdict, 'empty');
  assert.equal(result.diagnostics.queriesUsed, 2);
  assert.match(result.diagnostics.stopReason, /expected-unanswerable/i);
});

test('directly fetches an explicit URL without calling search', async () => {
  let searchCalls = 0;
  const result = await retrieveWebEvidence(
    { question: '总结 https://example.com/report' },
    {
      dependencies: {
        search: async ({ query }) => {
          searchCalls += 1;
          return { query, results: [] };
        },
        fetch: async (args) => page(
          String((args as { url: string }).url),
          'Revenue increased by twelve percent while operating expenses remained stable.'.repeat(40)
        )
      }
    }
  );

  assert.equal(searchCalls, 0);
  assert.equal(result.queryRoute.strategy, 'direct_fetch');
  assert.equal(result.pageAttempts.length, 1);
  assert.equal(result.sources.length, 1);
});

test('uses inferred freshness window for a current query', async () => {
  const timeRanges: Array<string | undefined> = [];
  await retrieveWebEvidence(
    { question: '今天国内人工智能政策' },
    {
      dependencies: {
        rewrite: async () => undefined,
        search: async ({ query }, _signal, options) => {
          timeRanges.push(options?.timeRange);
          return { query, results: [] };
        }
      }
    }
  );

  assert.equal(timeRanges[0], 'day');
});

test('accepts a focused rewrite result that covers one gap in a broad question', async () => {
  let searchCount = 0;
  const result = await retrieveWebEvidence(
    { question: 'SSE heartbeat, reconnection, backpressure, multiplexing, and proxy buffering', maxQueries: 2 },
    {
      dependencies: {
        rewrite: async () => 'SSE backpressure authoritative documentation',
        search: async ({ query }) => ({
          query,
          results: ++searchCount === 1 ? [] : [{
            title: 'SSE backpressure authoritative documentation',
            url: 'https://docs.example.com/sse-backpressure',
            snippet: 'Backpressure handling for SSE streams.',
            score: 0.96
          }]
        }),
        fetch: async (args) => page(
          String((args as { url: string }).url),
          'SSE backpressure authoritative documentation explains backpressure handling for streaming clients.'.repeat(30)
        )
      }
    }
  );

  assert.equal(result.queryAttempts[1]?.selectedUrls.length, 1);
  assert.equal(result.pageAttempts.length, 1);
});

test('expands budgets for a broad multi-claim research question', async () => {
  let rewriteCount = 0;
  const result = await retrieveWebEvidence(
    { question: 'SSE keep-alive, heartbeat, proxy buffering, compression, reconnection, event ID, backpressure, and multiplexing' },
    {
      dependencies: {
        rewrite: async () => `SSE focused topic ${++rewriteCount}`,
        search: async ({ query }) => ({ query, results: [] })
      }
    }
  );

  assert.equal(result.totalClaimCount >= 5, true);
  assert.equal(result.diagnostics.queryBudget, 5);
  assert.equal(result.diagnostics.pageBudget, 8);
});

test('keeps gap rewrites on inferred official domains', async () => {
  const includeDomains: Array<string[] | undefined> = [];
  let searchCount = 0;
  await retrieveWebEvidence(
    { question: 'SSE heartbeat, EventSource reconnection, Nginx buffering, compression, concurrency, and authentication' },
    {
      dependencies: {
        rewrite: async () => `SSE technical gap ${++searchCount}`,
        search: async ({ query }, _signal, options) => {
          includeDomains.push(options?.includeDomains);
          return { query, results: [] };
        }
      }
    }
  );

  assert.deepEqual(includeDomains[0], [
    'developer.mozilla.org',
    'html.spec.whatwg.org',
    'nginx.org'
  ]);
  assert.deepEqual(includeDomains[1], ['developer.mozilla.org', 'html.spec.whatwg.org', 'nginx.org']);
  assert.deepEqual(includeDomains.slice(2), [
    ['developer.mozilla.org', 'html.spec.whatwg.org'],
    ['developer.mozilla.org', 'html.spec.whatwg.org'],
    ['developer.mozilla.org', 'html.spec.whatwg.org']
  ]);
});

test('preserves a broad open-web overview query before focused rewrites', async () => {
  const queries: string[] = [];
  const includeDomains: Array<string[] | undefined> = [];
  await retrieveWebEvidence(
    { question: 'SSE 连接管理、心跳保活、断线重连、背压控制、Nginx 缓冲、多路复用、客户端优化、鉴权与超时' },
    {
      dependencies: {
        rewrite: async ({ uncoveredClaims }) => `SSE focused ${uncoveredClaims?.[0] ?? 'gap'}`,
        search: async ({ query }, _signal, options) => {
          queries.push(query);
          includeDomains.push(options?.includeDomains);
          return { query, results: [] };
        }
      }
    }
  );

  assert.match(queries[0]!, /官方文档/);
  assert.equal(queries[1], 'SSE 连接管理、心跳保活、断线重连、背压控制、Nginx 缓冲、多路复用、客户端优化、鉴权与超时');
  assert.deepEqual(includeDomains[0], ['developer.mozilla.org', 'html.spec.whatwg.org', 'nginx.org', 'nodejs.org']);
  assert.deepEqual(includeDomains[1], ['developer.mozilla.org', 'html.spec.whatwg.org', 'nginx.org', 'nodejs.org']);
  assert.match(queries[2]!, /^SSE focused /);
});

test('keeps an authoritative page when it supports one claim from a broad question', async () => {
  const result = await retrieveWebEvidence(
    {
      question: 'SSE 连接管理、心跳保活、断线重连、背压控制、Nginx 缓冲、多路复用、客户端优化、鉴权与超时',
      maxQueries: 1
    },
    {
      dependencies: {
        search: async ({ query }) => ({
          query,
          results: [{
            title: 'Using server-sent events - MDN',
            url: 'https://developer.mozilla.org/docs/Web/API/Server-sent_events/Using_server-sent_events',
            snippet: 'EventSource reconnection and event stream usage.',
            score: 0.9
          }]
        }),
        fetch: async (args) => page(
          String((args as { url: string }).url),
          'EventSource automatically reconnects. The server can use Last-Event-ID to resume the event stream.'.repeat(30)
        )
      }
    }
  );

  assert.equal(result.pageAttempts[0]?.verdict === 'irrelevant', false);
  assert.equal(result.sources[0]?.heading, 'developer.mozilla.org');
  assert.equal(result.claims.find((claim) => claim.text === '断线重连')?.supported, true);
});

test('expands the page budget only when broad technical claims remain uncovered', async () => {
  let rewriteCount = 0;
  let resultNumber = 0;
  const result = await retrieveWebEvidence(
    { question: 'SSE heartbeat, reconnection, proxy buffering, compression, connection management, concurrency, authentication, and load balancing' },
    {
      dependencies: {
        rewrite: async () => `SSE uncovered technical topic ${++rewriteCount}`,
        search: async ({ query }) => ({
          query,
          results: Array.from({ length: 2 }, () => {
            resultNumber += 1;
            return {
              title: `SSE technical page ${resultNumber}`,
              url: `https://docs${resultNumber}.example.com/sse`,
              snippet: 'SSE technical overview without concrete implementation evidence.',
              score: 0.9
            };
          })
        }),
        fetch: async (args) => page(
          String((args as { url: string }).url),
          'SSE technical overview and general streaming introduction.'.repeat(30)
        )
      }
    }
  );

  assert.equal(result.diagnostics.pageBudget, 10);
  assert.equal(result.diagnostics.pagesFetched, 10);
  assert.equal(result.diagnostics.budgetExhaustedBy, 'queries-and-pages');
});

test('rejects WebSocket-only pages as evidence for an SSE question', async () => {
  let counter = 0;
  const result = await retrieveWebEvidence(
    { question: 'SSE 心跳保活、背压控制、压缩、负载均衡、与 WebSocket 对比', maxQueries: 2 },
    { dependencies: {
      rewrite: async ({ uncoveredClaims }) => `SSE ${uncoveredClaims?.[0] ?? 'gap'} official documentation`,
      search: async ({ query }) => ({ query, results: [{
        title: 'WebSocket production guide', url: `https://example${++counter}.com/websocket`,
        snippet: 'WebSocket heartbeat compression connection limits and load balancing', score: 0.95
      }] }),
      fetch: async (args) => page(String((args as { url: string }).url), 'WebSocket heartbeat compression connection limits and load balancing.'.repeat(30))
    } }
  );

  assert.notEqual(result.verdict, 'sufficient');
  assert.equal(result.coveredClaimCount, 0);
  assert.equal(result.pageAttempts.every((attempt) => attempt.subjectMismatch), true);
  assert.equal(result.diagnostics.subjectConsistencyRate, 0);
});

function page(url: string, content: string): FetchPageResult {
  return {
    url,
    title: url,
    totalChars: content.length,
    content,
    truncated: true,
    chunks: [{ index: 0, chars: content.length, content }]
  };
}
