import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createConfiguredLlm } from './config.js';
import { createMiniMaxProvider } from './minimaxProvider.js';

test('selects MiniMax-M3 from provider configuration', () => {
  const configured = createConfiguredLlm({
    LLM_PROVIDER: 'minimax',
    MINIMAX_API_KEY: 'test-key'
  });
  assert.equal(configured.providerName, 'minimax');
  assert.equal(configured.model, 'MiniMax-M3');
  assert.ok(configured.llm);
});

test('calls MiniMax OpenAI-compatible API and normalizes cumulative stream chunks', async () => {
  const requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body
    });

    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_details":[{"text":"思考"}],"content":"答"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"reasoning_details":[{"text":"思考完成"}],"content":"答案"}}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          reasoning_details: [{ text: '需要调用工具' }],
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_docs', arguments: '{}' } }]
        }
      }]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const provider = createMiniMaxProvider({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxRetries: 0
  });

  try {
    const completion = await provider.complete({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: '查资料' }],
      tools: [{ type: 'function' }]
    });
    assert.equal(completion.choices?.[0]?.message?.tool_calls?.[0]?.function.name, 'search_docs');
    assert.equal(completion.choices?.[0]?.message?.reasoning_details?.[0]?.text, '需要调用工具');

    let reasoning = '';
    let content = '';
    await provider.stream({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: '回答' }],
      reasoning: true
    }, (delta) => {
      reasoning += delta.reasoning ?? '';
      content += delta.content ?? '';
    });
    assert.equal(reasoning, '思考完成');
    assert.equal(content, '答案');
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, '/v1/chat/completions');
    assert.equal(requests[0]?.authorization, 'Bearer test-key');
    assert.equal(requests[0]?.body.reasoning_split, true);
    assert.deepEqual(requests[1]?.body.thinking, { type: 'adaptive' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
