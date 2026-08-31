import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import type { LlmProvider } from '../llm/contracts.js';
import { createToolCatalog } from '../tools/registry.js';
import { createToolRuntime } from '../tools/runtime.js';
import { runAgentLoop } from './agentLoop.js';

test('sanitizes leaked tool markup before emitting model-response events', async () => {
  let calls = 0;
  const eventMessages: unknown[] = [];
  const llm: LlmProvider = {
    complete: async () => {
      calls += 1;
      return { choices: [{ message: {
        role: 'assistant',
        content: '我来查询。\n<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="fake_tool">'
      } }] };
    },
    stream: async () => undefined
  };

  const result = await runAgentLoop({
    llm,
    model: 'test-model',
    message: '查询 React',
    systemPrompt: 'Use tools only through function calling.',
    toolPolicy: { mode: 'none' },
    onEvent: (event) => {
      if (event.type === 'llm_response') eventMessages.push(event.assistantMessage);
    }
  });

  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(eventMessages), /DSML|fake_tool|<｜/);
  assert.doesNotMatch(result.reply, /DSML|fake_tool|<｜/);
});

test('uses one injected tool runtime for both model definitions and execution', async () => {
  const observedToolLists: unknown[] = [];
  let calls = 0;
  const llm: LlmProvider = {
    complete: async (request) => {
      observedToolLists.push(request.tools ?? []);
      calls += 1;
      return calls === 1
        ? { choices: [{ message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'custom-call',
              type: 'function',
              function: { name: 'custom_tool', arguments: '{"value":7}' }
            }]
          } }] }
        : { choices: [{ message: { role: 'assistant', content: 'custom result received' } }] };
    },
    stream: async () => undefined
  };
  let executed = 0;
  const toolRuntime = createToolRuntime(createToolCatalog([{
    label: 'Custom tool',
    definition: {
      type: 'function',
      function: {
        name: 'custom_tool',
        description: 'A tool available only through dependency injection.',
        parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }
      }
    },
    execute: async (args) => {
      executed += 1;
      return { echoed: args };
    }
  }]));

  const result = await runAgentLoop({
    llm,
    model: 'test-model',
    message: 'Use the custom tool',
    systemPrompt: 'Use tools.',
    toolRuntime,
    toolPolicy: { mode: 'selected', names: ['custom_tool'] }
  });

  assert.equal(executed, 1);
  assert.equal(result.toolCalls[0]?.name, 'custom_tool');
  assert.match(JSON.stringify(observedToolLists[0]), /custom_tool/);
});

test('none tool policy exposes no definitions to the model', async () => {
  let observedTools: unknown;
  const llm: LlmProvider = {
    complete: async (request) => {
      observedTools = request.tools;
      return { choices: [{ message: { role: 'assistant', content: 'No tools needed.' } }] };
    },
    stream: async () => undefined
  };

  await runAgentLoop({
    llm,
    model: 'test-model',
    message: 'Answer directly',
    systemPrompt: 'Do not use tools.',
    toolPolicy: { mode: 'none' }
  });

  assert.equal(observedTools, undefined);
});

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
      toolPolicy: { mode: 'selected', names: ['generate_word_document'] },
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
      toolPolicy: { mode: 'selected', names: ['generate_word_document'] },
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
  const observedToolNames: string[][] = [];
  const server = createServer(async (_req, res) => {
    requestCount += 1;
    // The test server receives OpenAI-compatible requests from the default client;
    // the runtime assertion below uses the injected LLM wrapper instead.
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
      llm: {
        complete: async (request) => {
          observedToolNames.push(
            ((request.tools ?? []) as Array<{ function?: { name?: string } }>)
              .map((tool) => tool.function?.name ?? '')
          );
          const response = await fetch(`http://127.0.0.1:${address.port}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          return response.json() as Promise<never>;
        },
        stream: async () => undefined
      },
      model: 'test-model',
      message: 'Find one official fact',
      systemPrompt: 'Use the controlled web tool once.',
      maxToolRounds: 3,
      toolPolicy: { mode: 'selected', names: ['retrieve_web_evidence'] },
      executeTool: async () => {
        executionCount += 1;
        return { verdict: 'exhausted', sources: [] };
      }
    });

    assert.equal(executionCount, 1);
    assert.equal(result.toolCalls.length, 2);
    assert.match(result.toolCalls[1]?.error ?? '', /already completed its controlled search loop/);
    assert.ok(observedToolNames.length >= 2);
    assert.ok(observedToolNames.every((names) => names.includes('retrieve_web_evidence')));
  } finally {
    if (previousBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
