import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { initDb } from '../db.js';
import { createResearchApplication } from '../modules/research/index.js';
import { createResearchRouter } from '../routes/research.js';
import { toolCatalog } from '../tools/registry.js';
import {
  cancelResearchRun,
  createAndStartResearchRun
} from './service.js';
import {
  createResearchConversation,
  deleteResearchConversation,
  getResearchRun,
  listResearchMessages
} from './store.js';

initDb();

test('runs research independently and only stops through explicit cancellation', async () => {
  const conversation = createResearchConversation();
  let scheduled: (() => void) | undefined;
  let observedSignal: AbortSignal | undefined;

  try {
    const started = createAndStartResearchRun({
      conversationId: conversation.id,
      content: '执行一项较长的后台研究',
      apiKey: 'test-only',
      schedule: (callback) => {
        scheduled = callback;
      },
      runAgent: async (options) => {
        observedSignal = options.signal;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
        return { reply: 'unreachable', toolCalls: [], trace: [], sources: [] };
      }
    });

    assert.equal(getResearchRun(started.run.id)?.status, 'queued');
    assert.ok(scheduled);
    scheduled();
    await waitFor(() => getResearchRun(started.run.id)?.status === 'running');

    const cancelled = cancelResearchRun(started.run.id);
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(observedSignal?.aborted, true);
    await waitFor(() => listResearchMessages(conversation.id).some(
      (message) => message.id === started.assistantMessage.id && message.status === 'error'
    ));
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('completes a queued background run and persists its final message', async () => {
  const conversation = createResearchConversation();
  let scheduled: (() => void) | undefined;

  try {
    const started = createAndStartResearchRun({
      conversationId: conversation.id,
      content: '完成后台研究',
      apiKey: 'test-only',
      schedule: (callback) => {
        scheduled = callback;
      },
      runAgent: async (options) => {
        await options.onEvent?.({ type: 'llm', title: '测试模型调用', model: options.model });
        return { reply: '后台研究已完成。', toolCalls: [], trace: [], sources: [] };
      }
    });

    assert.ok(scheduled);
    scheduled();
    await waitFor(() => getResearchRun(started.run.id)?.status === 'completed');
    const assistant = listResearchMessages(conversation.id).find(
      (message) => message.id === started.assistantMessage.id
    );
    assert.equal(assistant?.status, 'complete');
    assert.equal(assistant?.content, '后台研究已完成。');
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('closing an SSE subscription does not cancel its research run', async () => {
  const conversation = createResearchConversation();
  let scheduled: (() => void) | undefined;
  const started = createAndStartResearchRun({
    conversationId: conversation.id,
    content: '保持后台排队',
    apiKey: 'test-only',
    schedule: (callback) => {
      scheduled = callback;
    },
    runAgent: async () => ({ reply: 'unused', toolCalls: [], trace: [], sources: [] })
  });
  assert.ok(scheduled);

  const app = express();
  app.use('/api', createResearchRouter(createResearchApplication({ model: 'test-model', tools: toolCatalog })));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const controller = new AbortController();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/research/runs/${started.run.id}/events`, {
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    const firstChunk = await response.body?.getReader().read();
    assert.match(new TextDecoder().decode(firstChunk?.value), /event: snapshot/);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(getResearchRun(started.run.id)?.status, 'queued');
  } finally {
    controller.abort();
    cancelResearchRun(started.run.id);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    deleteResearchConversation(conversation.id);
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for research state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
