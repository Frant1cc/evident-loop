import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { runAgentLoop } from '../agent/agentLoop.js';
import { getRagSourcesFromToolTraces } from '../rag/index.js';
import { getToolDefinitions } from '../tools/definitions.js';

test('exposes only the controlled web retrieval tool to the model', () => {
  const names = getToolDefinitions().map((definition) => definition.function.name);

  assert.ok(names.includes('retrieve_web_evidence'));
  assert.ok(!names.includes('web_search'));
  assert.ok(!names.includes('fetch_page'));
});

test('promotes controlled web evidence into research sources', () => {
  const sources = getRagSourcesFromToolTraces([
    {
      id: 'tool-call-1',
      name: 'retrieve_web_evidence',
      arguments: { question: 'example' },
      result: {
        verdict: 'sufficient',
        sources: [
          {
            id: 'web-source-1',
            file: 'https://docs.example.com/page',
            title: 'Official documentation',
            heading: 'docs.example.com',
            content: 'Supported external evidence.',
            startLine: 1,
            endLine: 1,
            score: 0.9
          }
        ]
      }
    }
  ]);

  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.file, 'https://docs.example.com/page');
});

test('maps persisted legacy web permissions to the controlled tool', async () => {
  let requestBody: { tools?: Array<{ function?: { name?: string } }> } | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof requestBody;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const previousBaseUrl = process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    await runAgentLoop({
      apiKey: 'test-key',
      model: 'test-model',
      message: 'external fact',
      systemPrompt: 'Use controlled tools.',
      allowedToolNames: ['web_search', 'fetch_page']
    });
    assert.deepEqual(
      requestBody?.tools?.map((tool) => tool.function?.name),
      ['retrieve_web_evidence']
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
