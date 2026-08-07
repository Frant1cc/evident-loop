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
