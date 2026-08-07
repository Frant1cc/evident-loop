import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { runAgentLoop } from './agentLoop.js';

test('retries once when an explicit artifact request misses its required tool', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    requestCount += 1;

    const message =
      requestCount === 1
        ? { role: 'assistant', content: 'I can describe how to make a document.' }
        : requestCount === 2
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call-word-1',
                  type: 'function',
                  function: {
                    name: 'generate_word_document',
                    arguments: JSON.stringify({
                      title: 'Required tool test',
                      blocks: [{ type: 'paragraph', text: 'content' }]
                    })
                  }
                }
              ]
            }
          : {
              role: 'assistant',
              content: 'The requested content has been organized into the document.'
            };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const previousBaseUrl = process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runAgentLoop({
      apiKey: 'test-key',
      model: 'test-model',
      message: 'Export this as a Word document',
      systemPrompt: 'Use tools when required.',
      allowedToolNames: ['generate_word_document'],
      requiredToolName: 'generate_word_document',
      executeTool: async () => ({
        downloadUrl: '/api/artifacts/test/download'
      })
    });

    assert.equal(requestCount, 3);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]?.name, 'generate_word_document');
    assert.doesNotMatch(result.reply, /\/api\/artifacts\/test\/download/);
    assert.match(JSON.stringify(requestBodies[1]), /Call that tool now/);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test('grants one corrective retry when required document tool arguments are invalid JSON', async () => {
  let requestCount = 0;
  let executionCount = 0;
  const server = createServer(async (_req, res) => {
    requestCount += 1;

    const message =
      requestCount === 1
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-word-invalid',
                type: 'function',
                function: {
                  name: 'generate_word_document',
                  arguments:
                    '{"title":"Broken","blocks":[{"type":"bulletList","items":["one"],["two"]}]}'
                }
              }
            ]
          }
        : requestCount === 2
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call-word-corrected',
                  type: 'function',
                  function: {
                    name: 'generate_word_document',
                    arguments: JSON.stringify({
                      title: 'Corrected',
                      contentMarkdown: '# Result\n\n- one\n- two'
                    })
                  }
                }
              ]
            }
          : {
              role: 'assistant',
              content: 'The requested content has been organized into the document.'
            };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const previousBaseUrl = process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runAgentLoop({
      apiKey: 'test-key',
      model: 'test-model',
      message: 'Export this as a Word document',
      systemPrompt: 'Use tools when required.',
      maxToolRounds: 1,
      allowedToolNames: ['generate_word_document'],
      requiredToolName: 'generate_word_document',
      executeTool: async (toolCall) => {
        executionCount += 1;
        assert.deepEqual(toolCall.arguments, {
          title: 'Corrected',
          contentMarkdown: '# Result\n\n- one\n- two'
        });
        return { downloadUrl: '/api/artifacts/test/download' };
      }
    });

    assert.equal(requestCount, 3);
    assert.equal(executionCount, 1);
    assert.equal(result.toolCalls.length, 2);
    assert.match(result.toolCalls[0]?.error ?? '', /Failed to parse tool arguments/);
    assert.doesNotMatch(result.reply, /\/api\/artifacts\/test\/download/);
    assert.ok(
      result.trace.some(
        (step) => step.type === 'llm_call' && step.label.includes('参数无效')
      )
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test('runs the controlled web quality loop only once even when the model changes arguments', async () => {
  let requestCount = 0;
  let executionCount = 0;
  const server = createServer(async (_req, res) => {
    requestCount += 1;
    const message = requestCount <= 2
      ? {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: `call-web-${requestCount}`,
            type: 'function',
            function: {
              name: 'retrieve_web_evidence',
              arguments: JSON.stringify({ question: `official fact attempt ${requestCount}` })
            }
          }]
        }
      : { role: 'assistant', content: 'The available evidence remains limited.' };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const previousBaseUrl = process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runAgentLoop({
      apiKey: 'test-key',
      model: 'test-model',
      message: 'Find one official fact',
      systemPrompt: 'Use the controlled web tool once.',
      maxToolRounds: 3,
      allowedToolNames: ['retrieve_web_evidence'],
      executeTool: async () => {
        executionCount += 1;
        return { verdict: 'exhausted', sources: [] };
      }
    });

    assert.equal(executionCount, 1);
    assert.equal(result.toolCalls.length, 2);
    assert.match(result.toolCalls[1]?.error ?? '', /already completed its controlled search loop/);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
