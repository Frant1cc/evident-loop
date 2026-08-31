import assert from 'node:assert/strict';
import test from 'node:test';

import type { FetchPageResult } from '../tools/fetchPageTool.js';
import { retrieveWebEvidence } from './controller.js';

test('reports planning, search, fetch, judge and coverage progress', async () => {
  const stages: string[] = [];
  const kinds: string[] = [];
  const discoveredSources: string[] = [];
  await retrieveWebEvidence(
    { question: 'DeepSeek evaluation harness', maxQueries: 1, maxPages: 1 },
    {
      onProgress: (progress) => {
        stages.push(progress.stage);
        if (progress.kind) kinds.push(progress.kind);
      },
      onSource: (source) => { discoveredSources.push(source.file); },
      dependencies: {
        planner: async () => ({
          subject: 'DeepSeek',
          planningMethod: 'llm',
          preferredDomains: [],
          claims: [{
            id: 'harness',
            text: 'Which evaluation harness is used?',
            searchQueries: ['DeepSeek evaluation harness'],
            preferredDomains: [],
            sourceTypes: ['research_paper'],
            subjectTerms: ['DeepSeek']
          }]
        }),
        search: async () => ({
          query: 'DeepSeek evaluation harness',
          results: [{
            title: 'DeepSeek evaluation',
            url: 'https://example.com/deepseek-eval',
            snippet: 'DeepSeek uses this evaluation harness and benchmark suite.'
          }]
        }),
        fetch: async () => ({
          url: 'https://example.com/deepseek-eval',
          title: 'DeepSeek evaluation',
          totalChars: 500,
          content: 'DeepSeek uses this evaluation harness and benchmark suite. '.repeat(10),
          truncated: false,
          chunks: [{
            index: 0,
            chars: 500,
            content: 'DeepSeek uses this evaluation harness and benchmark suite. '.repeat(10)
          }]
        }),
        judge: async ({ claims }) => claims.map((claim) => ({
          claimId: claim.id,
          relation: 'supports' as const,
          confidence: 0.95,
          chunkIndex: 0,
          evidenceQuote: 'DeepSeek uses this evaluation harness and benchmark suite.',
          reason: 'Direct support',
          subjectMatched: true,
          method: 'llm' as const
        }))
      }
    }
  );

  assert.ok(stages.includes('planning'));
  assert.ok(stages.includes('searching'));
  assert.ok(stages.includes('fetching'));
  assert.ok(stages.includes('judging'));
  assert.ok(stages.includes('coverage'));
  assert.ok(kinds.includes('search'));
  assert.ok(kinds.includes('page'));
  assert.ok(kinds.includes('evidence'));
  assert.deepEqual(discoveredSources, ['https://example.com/deepseek-eval']);
});

test('keeps official announcement evidence and rejects a third-party aggregator', async () => {
  const result = await retrieveWebEvidence(
    { question: 'What upcoming models is OpenAI preparing to release?', maxQueries: 1, maxPages: 2 },
    { dependencies: {
      planner: async () => ({
        subject: 'OpenAI', planningMethod: 'llm', preferredDomains: ['aggregator.example'],
        claims: [{
          id: 'openai-release', text: 'What upcoming models has OpenAI officially announced?',
          searchQueries: ['OpenAI upcoming model official announcement'],
          preferredDomains: ['aggregator.example'], sourceTypes: ['official_announcement'], subjectTerms: ['OpenAI']
        }]
      }),
      search: async ({ query }) => ({ query, results: [
        { title: 'OpenAI announcement', url: 'https://openai.com/news/model-update', snippet: 'OpenAI officially announced its upcoming model.' },
        { title: 'AI release roundup', url: 'https://aggregator.example/openai', snippet: 'OpenAI officially announced its upcoming model.' }
      ] }),
      fetch: async (args) => {
        const url = (args as { url: string }).url;
        return {
          url, title: 'OpenAI model announcement', totalChars: 600,
          content: 'OpenAI officially announced its upcoming model. '.repeat(15), truncated: false,
          chunks: [{ index: 0, chars: 600, content: 'OpenAI officially announced its upcoming model. '.repeat(15) }]
        };
      },
      judge: async ({ claims }) => claims.map((claim) => ({
        claimId: claim.id, relation: 'supports' as const, confidence: 0.95, chunkIndex: 0,
        evidenceQuote: 'OpenAI officially announced its upcoming model.', reason: 'Direct support',
        subjectMatched: true, method: 'llm' as const
      }))
    } }
  );

  assert.deepEqual(result.evidencePlan.claims[0]?.preferredDomains, ['openai.com']);
  assert.deepEqual(result.sources.map((source) => source.file), ['https://openai.com/news/model-update']);
  assert.equal(result.pageAttempts.find((page) => page.domain === 'aggregator.example')?.authority, 'third_party');
});

test('rejects stale pages after fetch even when the search provider returns them for a month query', async () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  const result = await retrieveWebEvidence(
    { question: 'What changed in the AI market?', timeRange: 'month', maxQueries: 1, maxPages: 2 },
    { dependencies: {
      now: () => now,
      planner: async () => ({
        subject: 'AI market', planningMethod: 'llm', preferredDomains: [],
        claims: [{
          id: 'market-change', text: 'What changed in the AI market?', searchQueries: ['AI market changes'],
          preferredDomains: [], sourceTypes: ['news'], subjectTerms: ['AI']
        }]
      }),
      search: async ({ query }) => ({ query, results: [
        { title: 'Current report', url: 'https://news.example/current', snippet: 'AI market changed this month.', publishedAt: '2026-08-10T00:00:00Z' },
        { title: 'Old report', url: 'https://archive.example/old', snippet: 'AI market changed last year.', publishedAt: '2025-07-22T00:00:00Z' }
      ] }),
      fetch: async (args) => {
        const url = (args as { url: string }).url;
        return {
          url, title: 'AI market report', totalChars: 500,
          content: 'AI market changed according to this report. '.repeat(15), truncated: false,
          chunks: [{ index: 0, chars: 500, content: 'AI market changed according to this report. '.repeat(15) }]
        };
      },
      judge: async ({ claims }) => claims.map((claim) => ({
        claimId: claim.id, relation: 'supports' as const, confidence: 0.9, chunkIndex: 0,
        evidenceQuote: 'AI market changed according to this report.', reason: 'Direct support',
        subjectMatched: true, method: 'llm' as const
      }))
    } }
  );

  assert.deepEqual(result.sources.map((source) => source.file), ['https://news.example/current']);
  assert.equal(result.pageAttempts.find((page) => page.domain === 'archive.example')?.freshnessStatus, 'outside_window');
  assert.equal(result.queryRoute.strategy, 'current_web_first');
});

test('rewrites a weak search and stops after high-confidence evidence is found', async () => {
  const queries: string[] = [];
  const fetchedUrls: string[] = [];
  let clock = 1_000;

  const result = await retrieveWebEvidence(
    { question: 'DeepSeek context window', maxQueries: 2, maxPages: 3 },
    {
      dependencies: {
        planner: async () => ({
          subject: 'DeepSeek', planningMethod: 'llm', preferredDomains: ['deepseek.com'],
          claims: [{
            id: 'context-window', text: 'What is the DeepSeek context window?',
            searchQueries: ['DeepSeek context window official documentation'],
            preferredDomains: ['deepseek.com'], sourceTypes: ['official_docs'], subjectTerms: ['DeepSeek']
          }]
        }),
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
                    url: 'https://docs.deepseek.com/models',
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
  assert.equal(result.sources[0]?.file, 'https://docs.deepseek.com/models');
  assert.equal(result.diagnostics.stopReason, 'A high-confidence relevant source was found');
});

test('returns exhausted after the query budget when candidates were found but rejected', async () => {
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

  assert.equal(result.verdict, 'exhausted');
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

  assert.equal(result.diagnostics.queryBudget, 5);
  assert.equal(result.diagnostics.pageBudget, 8);
  assert.equal(result.diagnostics.queriesUsed, 5);
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
  assert.equal(result.diagnostics.queryBudget, 8);
  assert.equal(result.diagnostics.pageBudget, 12);
});

test('uses LLM-planned authoritative domains for each evidence query', async () => {
  const includeDomains: Array<string[] | undefined> = [];
  await retrieveWebEvidence(
    { question: 'How should a stream reconnect and handle proxy buffering?', maxQueries: 3 },
    {
      dependencies: {
        planner: async () => ({
          subject: 'event stream', planningMethod: 'llm',
          preferredDomains: ['standard.example', 'proxy.example'],
          claims: [
            { id: 'reconnect', text: 'How does reconnection work?', searchQueries: ['event stream reconnection standard'], preferredDomains: ['standard.example'], sourceTypes: ['standard'], subjectTerms: ['event stream'] },
            { id: 'buffering', text: 'How is proxy buffering disabled?', searchQueries: ['event stream proxy buffering'], preferredDomains: ['proxy.example'], sourceTypes: ['official_docs'], subjectTerms: ['event stream'] }
          ]
        }),
        search: async ({ query }, _signal, options) => {
          includeDomains.push(options?.includeDomains);
          return { query, results: [] };
        }
      }
    }
  );

  assert.deepEqual(includeDomains[0], ['standard.example', 'proxy.example']);
  assert.deepEqual(includeDomains[1], ['standard.example']);
  assert.deepEqual(includeDomains[2], ['proxy.example']);
});

test('runs the broad route query before LLM-planned claim queries', async () => {
  const queries: string[] = [];
  await retrieveWebEvidence(
    { question: '比较数据库连接管理与故障恢复', maxQueries: 2 },
    {
      dependencies: {
        planner: async () => ({
          subject: '数据库', planningMethod: 'llm', preferredDomains: [],
          claims: [{ id: 'lifecycle', text: '连接生命周期如何管理？', searchQueries: ['database connection lifecycle official'], preferredDomains: [], sourceTypes: ['official_docs'], subjectTerms: ['database'] }]
        }),
        search: async ({ query }) => {
          queries.push(query);
          return { query, results: [] };
        }
      }
    }
  );

  assert.equal(queries[0], '比较数据库连接管理与故障恢复');
  assert.equal(queries[1], 'database connection lifecycle official');
});

test('scales the default budget with the LLM evidence plan', async () => {
  const claims = Array.from({ length: 6 }, (_, index) => ({
    id: `claim-${index + 1}`,
    text: `需要核验的事实 ${index + 1}`,
    searchQueries: [`focused evidence query ${index + 1}`],
    preferredDomains: [],
    sourceTypes: ['official_docs'],
    subjectTerms: ['ExampleSubject']
  }));
  const result = await retrieveWebEvidence(
    { question: '核验六个相互独立的事实' },
    { dependencies: {
      planner: async () => ({ subject: 'ExampleSubject', claims, preferredDomains: [], planningMethod: 'llm' }),
      search: async ({ query }) => ({ query, results: [] })
    } }
  );

  assert.equal(result.diagnostics.queryBudget, 7);
  assert.equal(result.diagnostics.pageBudget, 14);
  assert.equal(result.queryAttempts.length, 7);
});

test('gives broad seven-company research enough default query and page budget', async () => {
  const claims = Array.from({ length: 7 }, (_, index) => ({
    id: `company-${index + 1}`,
    text: `Company ${index + 1} model announcements`,
    searchQueries: [
      `Company ${index + 1} official model announcement`,
      `Company ${index + 1} official model release notes`
    ],
    preferredDomains: [`company${index + 1}.example`],
    sourceTypes: ['official_announcement'],
    subjectTerms: [`Company ${index + 1}`]
  }));
  const result = await retrieveWebEvidence(
    { question: 'Recent model announcements from mainstream AI companies' },
    { dependencies: {
      planner: async () => ({ subject: 'AI models', claims, preferredDomains: [], planningMethod: 'llm' }),
      search: async ({ query }) => ({ query, results: [] })
    } }
  );

  assert.equal(result.diagnostics.queryBudget, 12);
  assert.equal(result.diagnostics.pageBudget, 16);
  assert.equal(result.queryAttempts.length, 16);
  assert.equal(result.diagnostics.recoveryTriggered, true);
  assert.equal(result.diagnostics.recoveryQueriesUsed, 4);
});

test('keeps a page when the structured judge supports one planned claim', async () => {
  const result = await retrieveWebEvidence(
    {
      question: '事件流如何断线恢复？',
      maxQueries: 1
    },
    {
      dependencies: {
        planner: async () => ({
          subject: 'EventSource', planningMethod: 'llm', preferredDomains: ['developer.mozilla.org'],
          claims: [{ id: 'reconnect', text: '事件流如何断线恢复？', searchQueries: ['EventSource reconnection Last-Event-ID'], preferredDomains: ['developer.mozilla.org'], sourceTypes: ['official_docs'], subjectTerms: ['EventSource'] }]
        }),
        judge: async () => [{
          claimId: 'reconnect', relation: 'supports', confidence: 0.95, chunkIndex: 0,
          evidenceQuote: 'Last-Event-ID', reason: 'Direct support', subjectMatched: true, method: 'llm'
        }],
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
  assert.equal(result.claims.find((claim) => claim.id === 'reconnect')?.supported, true);
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

  assert.equal(result.diagnostics.pageBudget, 12);
  assert.equal(result.diagnostics.pagesFetched, 16);
  assert.equal(result.diagnostics.fetchAttemptBudget, 24);
  assert.equal(result.diagnostics.budgetExhaustedBy, 'queries');
});

test('rejected pages do not consume the accepted-evidence page budget', async () => {
  let searches = 0;
  const result = await retrieveWebEvidence(
    { question: 'OpenAI latest officially released model', maxQueries: 2, maxPages: 1 },
    { dependencies: {
      planner: async () => ({
        subject: 'OpenAI', planningMethod: 'llm', preferredDomains: ['openai.com'],
        claims: [{
          id: 'release', text: 'Which model did OpenAI most recently release?',
          searchQueries: ['OpenAI latest model official announcement'],
          preferredDomains: ['openai.com'], sourceTypes: ['official_announcement'], subjectTerms: ['OpenAI']
        }]
      }),
      search: async ({ query }) => ({
        query,
        results: ++searches === 1
          ? [{ title: 'Undated roundup', url: 'https://roundup.example/openai', snippet: 'OpenAI model roundup', score: 0.9 }]
          : [{ title: 'OpenAI model launch', url: 'https://openai.com/index/model-launch', snippet: 'OpenAI launched its latest model.', score: 0.95 }]
      }),
      fetch: async (args) => page(
        String((args as { url: string }).url),
        'OpenAI launched its latest model in this official announcement.'.repeat(30)
      ),
      judge: async ({ claims }) => claims.map((claim) => ({
        claimId: claim.id, relation: 'supports' as const, confidence: 0.98, chunkIndex: 0,
        evidenceQuote: 'launched its latest model', reason: 'Direct announcement',
        subjectMatched: true, method: 'llm' as const
      }))
    } }
  );

  assert.equal(result.verdict, 'sufficient');
  assert.equal(result.diagnostics.pagesFetched, 2);
  assert.equal(result.diagnostics.acceptedPages, 1);
  assert.equal(result.diagnostics.rejectedPages, 1);
  assert.equal(result.diagnostics.pageBudget, 1);
});

test('runs focused official-company recovery after the primary budget is exhausted', async () => {
  const searchQueries: string[] = [];
  const companies = [
    { id: 'openai', name: 'OpenAI', domain: 'openai.com' },
    { id: 'anthropic', name: 'Anthropic', domain: 'anthropic.com' }
  ];
  const result = await retrieveWebEvidence(
    { question: 'Recent model announcements from OpenAI and Anthropic' },
    { dependencies: {
      planner: async () => ({
        subject: 'AI model releases', planningMethod: 'llm',
        preferredDomains: companies.map((company) => company.domain),
        claims: companies.map((company) => ({
          id: company.id,
          text: `${company.name} recent model announcement`,
          searchQueries: [`${company.name} latest official model release`],
          preferredDomains: [company.domain],
          sourceTypes: ['official_announcement'],
          subjectTerms: [company.name]
        }))
      }),
      search: async ({ query }, _signal, searchOptions) => {
        searchQueries.push(query);
        const domain = searchOptions?.includeDomains?.[0];
        const company = companies.find((item) => item.domain === domain);
        if (!query.includes('official newsroom') || !company) return { query, results: [] };
        return { query, results: [{
          title: `${company.name} model launch`,
          url: `https://${company.domain}/news/model-launch`,
          snippet: `${company.name} officially launched a new model.`,
          score: 0.98
        }] };
      },
      fetch: async (args) => {
        const url = String((args as { url: string }).url);
        const company = url.includes('anthropic') ? 'Anthropic' : 'OpenAI';
        return page(url, `${company} officially launched a new model in 2026.`.repeat(30));
      },
      judge: async ({ claims, url }) => claims.map((claim) => ({
        claimId: claim.id,
        relation: url.includes(claim.preferredDomains[0]!) ? 'supports' as const : 'irrelevant' as const,
        confidence: 0.98, chunkIndex: 0, evidenceQuote: 'officially launched a new model',
        reason: 'Direct official announcement', subjectMatched: url.includes(claim.preferredDomains[0]!), method: 'llm' as const
      }))
    } }
  );

  assert.equal(result.verdict, 'sufficient');
  assert.equal(result.diagnostics.recoveryTriggered, true);
  assert.equal(result.diagnostics.recoveryQueriesUsed, 2);
  assert.equal(result.coveredClaimCount, 2);
  assert.equal(searchQueries.filter((query) => query.includes('official newsroom')).length, 2);
});

test('does not stop after the first company and preserves multiple model price blocks for answering', async () => {
  const searched: string[] = [];
  const result = await retrieveWebEvidence(
    { question: 'OpenAI公司和Anthropic公司的模型八月份的价钱分别是多少' },
    { dependencies: {
      planner: async () => ({
        subject: 'OpenAI and Anthropic pricing', planningMethod: 'llm',
        preferredDomains: ['openai.com', 'anthropic.com'],
        claims: [
          {
            id: 'openai-price', text: 'OpenAI模型API价格是多少？',
            searchQueries: ['OpenAI official API pricing'], preferredDomains: ['openai.com'],
            sourceTypes: ['official_docs'], subjectTerms: ['OpenAI'], priority: 'core', blocking: true
          },
          {
            id: 'anthropic-price', text: 'Anthropic模型API价格是多少？',
            searchQueries: ['Anthropic official API pricing'], preferredDomains: ['anthropic.com'],
            sourceTypes: ['official_docs'], subjectTerms: ['Anthropic'], priority: 'core', blocking: true
          }
        ]
      }),
      search: async ({ query }) => {
        searched.push(query);
        if (query.includes('OpenAI official')) return { query, results: [{
          title: 'OpenAI API Pricing', url: 'https://openai.com/api/pricing',
          snippet: 'OpenAI GPT-A and GPT-B official API pricing per million tokens.', score: 0.99
        }] };
        if (query.includes('Anthropic official')) return { query, results: [{
          title: 'Anthropic API Pricing', url: 'https://www.anthropic.com/pricing',
          snippet: 'Anthropic Claude-A and Claude-B official API pricing per million tokens.', score: 0.99
        }] };
        return { query, results: [] };
      },
      fetch: async (args) => {
        const url = String((args as { url: string }).url);
        const content = url.includes('anthropic')
          ? '# Claude-A 4\nPricing Per 1M tokens\nInput $3\nOutput $15\n\n# Claude-B 4\nPricing Per 1M tokens\nInput $1\nOutput $5\nAnthropic official API pricing details.'
          : '# GPT-A 6\nPricing Per 1M tokens\nInput $5\nOutput $30\n\n# GPT-B 6\nPricing Per 1M tokens\nInput $2\nOutput $12\nOpenAI official API pricing details.';
        return page(url, content.repeat(6));
      },
      judge: async ({ claims, url }) => claims.map((claim) => ({
        claimId: claim.id,
        relation: url.includes(claim.preferredDomains[0]!) ? 'supports' as const : 'irrelevant' as const,
        confidence: 0.95, chunkIndex: 0,
        evidenceQuote: url.includes('anthropic') ? 'Claude-A 4' : 'GPT-A 6',
        reason: 'Direct official pricing.', subjectMatched: url.includes(claim.preferredDomains[0]!), method: 'llm' as const
      }))
    } }
  );

  assert.equal(result.coveredClaimCount, 2);
  assert.ok(searched.some((query) => query.includes('OpenAI official')));
  assert.ok(searched.some((query) => query.includes('Anthropic official')));
  assert.match(JSON.stringify(result.claims.find((claim) => claim.id === 'openai-price')?.supportingEvidence), /GPT-B 6/);
  assert.match(JSON.stringify(result.claims.find((claim) => claim.id === 'anthropic-price')?.supportingEvidence), /Claude-B 4/);
});

test('rejects WebSocket-only pages as evidence for an SSE question', async () => {
  let counter = 0;
  const result = await retrieveWebEvidence(
    { question: 'SSE 心跳保活、背压控制、压缩、负载均衡、与 WebSocket 对比', maxQueries: 2 },
    { dependencies: {
      planner: async () => ({
        subject: 'SSE', planningMethod: 'llm', preferredDomains: [],
        claims: [{ id: 'heartbeat', text: 'SSE 如何心跳保活？', searchQueries: ['SSE heartbeat'], preferredDomains: [], sourceTypes: ['official_docs'], subjectTerms: ['SSE', 'EventSource'] }]
      }),
      judge: async () => [{
        claimId: 'heartbeat', relation: 'irrelevant', confidence: 0.95, chunkIndex: 0,
        evidenceQuote: '', reason: 'The page is about WebSocket.', subjectMatched: false, method: 'llm'
      }],
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
  assert.equal(result.pageAttempts.every((attempt) => attempt.subjectMismatch || attempt.verdict === 'irrelevant'), true);
  assert.equal(result.sources.length, 0);
});

test('keeps an exact official model release, emits required mentions, and stops before optional claims', async () => {
  const searched: string[] = [];
  const result = await retrieveWebEvidence(
    { question: '搜索 Anthropic 最新的模型有哪些', maxQueries: 4 },
    { dependencies: {
      planner: async () => ({
        subject: 'Anthropic latest models', planningMethod: 'llm', preferredDomains: ['anthropic.com'],
        claims: [
          {
            id: 'latest-models', text: 'Anthropic 最新发布的模型有哪些？',
            searchQueries: ['Anthropic latest model official release'], preferredDomains: ['anthropic.com'],
            sourceTypes: ['official_announcement'], subjectTerms: ['Anthropic'], priority: 'core', blocking: true
          },
          {
            id: 'model-ids', text: 'Anthropic API model IDs 有哪些？',
            searchQueries: ['Anthropic API model IDs'], preferredDomains: ['anthropic.com'],
            sourceTypes: ['official_docs'], subjectTerms: ['Anthropic'], priority: 'optional', blocking: false
          }
        ]
      }),
      search: async ({ query }) => {
        searched.push(query);
        return { query, results: [{
          title: 'Introducing Claude Nova 7 \\ Anthropic',
          url: 'https://www.anthropic.com/news/claude-nova-7',
          snippet: 'Claude Nova 7 is the latest Anthropic reasoning model release.',
          score: 0.99
        }] };
      },
      fetch: async () => {
        const content = 'Introducing Claude Nova 7. Anthropic launched Claude Nova 7 as its latest reasoning model. '.repeat(30);
        return {
          url: 'https://www.anthropic.com/news/claude-nova-7',
          title: 'Introducing Claude Nova 7 \\ Anthropic',
          totalChars: content.length,
          content,
          truncated: true,
          chunks: [{ index: 0, chars: content.length, content }]
        };
      },
      judge: async ({ claims }) => claims.map((claim) => ({
        claimId: claim.id,
        relation: claim.id === 'latest-models' ? 'supports' as const : 'irrelevant' as const,
        confidence: 0.98,
        chunkIndex: 0,
        evidenceQuote: 'Introducing Claude Nova 7',
        reason: 'Direct model release.',
        // Regression: a low semantic subject score must not override the exact title + URL match.
        subjectMatched: false,
        method: 'llm' as const
      }))
    } }
  );

  assert.equal(result.verdict, 'sufficient');
  assert.equal(result.pageAttempts[0]?.subjectMismatch, false);
  assert.equal(result.pageAttempts[0]?.exactEntityMatch, true);
  assert.equal(result.requiredMentions[0]?.entity, 'Claude Nova 7');
  assert.deepEqual(result.uncoveredBlockingClaims, []);
  assert.deepEqual(result.uncoveredClaims, ['Anthropic API model IDs 有哪些？']);
  assert.equal(searched.length, 1);
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
