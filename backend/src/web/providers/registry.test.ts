import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { detectRetrievalIntent } from '../intent.js';
import type { ProviderCandidate } from '../types.js';
import { fetchWithProviderFallback, searchWithProviderFallback } from './registry.js';

test('falls back from an empty Zhipu search to Tavily in the same capability', async () => {
  const server = createServer(async (req, res) => {
    if (req.url === '/zhipu/web_search') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ search_result: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Result', url: 'https://example.com', content: 'useful evidence', score: 0.9 }] }));
  });
  await listen(server);
  const port = boundPort(server);
  await withEnv({
    ZHIPU_API_KEY: 'test-zhipu',
    ZHIPU_BASE_URL: `http://127.0.0.1:${port}/zhipu`,
    TAVILY_API_KEY: 'test-tavily',
    TAVILY_BASE_URL: `http://127.0.0.1:${port}`,
    FIRECRAWL_API_KEY: undefined
  }, async () => {
    const result = await searchWithProviderFallback({
      capability: 'web_search',
      candidates: candidates('zhipu', 'tavily', 'firecrawl-search'),
      query: '测试查询',
      limit: 5,
      options: {},
    });
    assert.equal(result.provider, 'tavily');
    assert.deepEqual(result.attempts.map((item) => [item.provider, item.status]), [
      ['zhipu', 'empty'],
      ['tavily', 'success']
    ]);
    assert.equal(result.value?.[0]?.provider, 'tavily');
  });
  await close(server);
});

test('uses Jina after native fetch fails', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/reader/')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Readable SSE documentation from Jina Reader. '.repeat(20));
      return;
    }
    res.writeHead(403);
    res.end('blocked');
  });
  await listen(server);
  const port = boundPort(server);
  await withEnv({
    WEB_TOOLS_ALLOW_PRIVATE_HOSTS: 'true',
    JINA_API_KEY: 'test-jina',
    JINA_READER_BASE_URL: `http://127.0.0.1:${port}/reader`,
    FIRECRAWL_API_KEY: undefined
  }, async () => {
    const result = await fetchWithProviderFallback({
      candidates: candidates('native-fetch', 'jina', 'firecrawl-fetch'),
      intent: detectRetrievalIntent('读取网页'),
      url: `http://127.0.0.1:${port}/blocked`,
      query: 'SSE documentation',
      maxChunks: 6
    });
    assert.equal(result.provider, 'jina');
    assert.deepEqual(result.attempts.map((item) => [item.provider, item.status]), [
      ['native-fetch', 'auth_error'],
      ['jina', 'success']
    ]);
    assert.match(result.value?.content ?? '', /Jina Reader/);
  });
  await close(server);
});

test('falls back when a search provider returns low-quality results', async () => {
  const server = createServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/zhipu/web_search') {
      res.end(JSON.stringify({ search_result: [{ title: 'Cooking', link: 'https://cooking.example', content: 'garden recipes' }] }));
      return;
    }
    res.end(JSON.stringify({ results: [{ title: 'SSE heartbeat guide', url: 'https://docs.example/sse', content: 'SSE heartbeat and reconnection', score: 0.9 }] }));
  });
  await listen(server);
  const port = boundPort(server);
  await withEnv({
    ZHIPU_API_KEY: 'test-zhipu', ZHIPU_BASE_URL: `http://127.0.0.1:${port}/zhipu`,
    TAVILY_API_KEY: 'test-tavily', TAVILY_BASE_URL: `http://127.0.0.1:${port}`,
    FIRECRAWL_API_KEY: undefined
  }, async () => {
    const result = await searchWithProviderFallback({
      capability: 'web_search', candidates: candidates('zhipu', 'tavily'),
      query: 'SSE heartbeat reconnection', limit: 5, options: {}
    });
    assert.equal(result.provider, 'tavily');
    assert.deepEqual(result.attempts.map((item) => item.status), ['low_quality', 'success']);
  });
  await close(server);
});

function candidates(...providers: string[]): ProviderCandidate[] {
  return providers.map((provider, index) => ({ provider, score: 100 - index, configured: true, reasons: [] }));
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function boundPort(server: ReturnType<typeof createServer>) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return address.port;
}
