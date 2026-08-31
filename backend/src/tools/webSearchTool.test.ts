import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { webSearch } from './webSearchTool.js';

test('passes progressive search depth, freshness and domain filters to Tavily', async () => {
  let observedBody: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    observedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      results: [
        { title: 'Official docs', url: 'https://docs.example.com', content: 'relevant content', score: 0.9 }
      ]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const previousKey = process.env.TAVILY_API_KEY;
  const previousBaseUrl = process.env.TAVILY_BASE_URL;
  process.env.TAVILY_API_KEY = 'test-key';
  process.env.TAVILY_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const result = await webSearch(
      { query: 'latest release', limit: 5 },
      undefined,
      {
        searchDepth: 'advanced',
        timeRange: 'month',
        includeDomains: ['docs.example.com'],
        excludeDomains: ['spam.example.com']
      }
    );

    assert.equal(result.results.length, 1);
    assert.deepEqual(observedBody, {
      query: 'latest release',
      max_results: 5,
      search_depth: 'advanced',
      chunks_per_source: 3,
      time_range: 'month',
      include_domains: ['docs.example.com'],
      exclude_domains: ['spam.example.com']
    });
  } finally {
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.TAVILY_BASE_URL;
    else process.env.TAVILY_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

