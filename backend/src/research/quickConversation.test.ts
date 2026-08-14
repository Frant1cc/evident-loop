import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import type { ChatCompletionRequest, LlmProvider } from '../llm/contracts.js';
import { createAndStartResearchRun, subscribeToResearchRun } from './service.js';
import {
  createResearchConversation,
  deleteResearchConversation,
  getResearchRun,
  getResearchRunInput,
  listResearchMessages,
  listResearchSteps
} from './store.js';
import { toolCatalog } from '../tools/registry.js';
import { createToolRuntime } from '../tools/runtime.js';

initDb();

const toolRuntime = createToolRuntime(toolCatalog);

function streamingLlm(reply: string): LlmProvider {
  return {
    complete: async () => ({ choices: [{ message: { role: 'assistant', content: reply } }] }),
    stream: async (_request, onDelta) => {
      for (const char of reply) onDelta({ content: char });
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for research state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('no skill + none policy runs a quick conversation without the agent loop', async () => {
  const conversation = createResearchConversation();
  let scheduled: (() => void) | undefined;
  let agentCalled = false;
  let observedRequest: ChatCompletionRequest | undefined;
  const events: string[] = [];
  const llm: LlmProvider = {
    complete: async () => ({ choices: [] }),
    stream: async (request, onDelta) => {
      observedRequest = request;
      onDelta({ content: '你好，我是 EvidentLoop。' });
    }
  };
  try {
    const started = createAndStartResearchRun({
      conversationId: conversation.id,
      content: '你好',
      toolPolicy: { mode: 'none' },
      toolRuntime,
      llm,
      schedule: (callback) => { scheduled = callback; },
      runAgent: async () => {
        agentCalled = true;
        return { reply: '', toolCalls: [], trace: [], sources: [] };
      }
    });

    assert.equal(getResearchRunInput(started.run.id)?.executionMode, 'quick');
    const unsubscribe = subscribeToResearchRun(started.run.id, (envelope) => events.push(envelope.type));
    assert.ok(scheduled);
    scheduled();
    await waitFor(() => getResearchRun(started.run.id)?.status === 'completed');
    unsubscribe();

    assert.equal(agentCalled, false);
    // Quick mode writes no research steps.
    const steps = listResearchSteps(conversation.id)
      .filter((step) => step.messageId === started.assistantMessage.id);
    assert.equal(steps.length, 0);

    const messages = listResearchMessages(conversation.id);
    const assistant = messages.find((message) => message.id === started.assistantMessage.id);
    assert.equal(assistant?.status, 'complete');
    assert.equal(assistant?.content, '你好，我是 EvidentLoop。');
    assert.ok(observedRequest);
    assert.equal(observedRequest.tools, undefined);
    assert.match(observedRequest.messages[0]?.content ?? '', /clear and helpful AI assistant/);
    assert.doesNotMatch(observedRequest.messages[0]?.content ?? '', /official_research_skill/);
    assert.deepEqual(observedRequest.messages.at(-1), { role: 'user', content: '你好' });
    assert.deepEqual(events, [
      'run_updated',
      'assistant_delta',
      'research_message_completed',
      'run_updated',
      'done'
    ]);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('no skill + selected tools runs the research agent', async () => {
  const conversation = createResearchConversation();
  let scheduled: (() => void) | undefined;
  let agentCalled = false;
  try {
    const started = createAndStartResearchRun({
      conversationId: conversation.id,
      content: '研究一下',
      toolPolicy: { mode: 'selected', names: ['search_knowledge'] },
      toolRuntime,
      llm: streamingLlm('unused'),
      schedule: (callback) => { scheduled = callback; },
      runAgent: async () => {
        agentCalled = true;
        return { reply: '研究完成', toolCalls: [], trace: [], sources: [] };
      }
    });

    assert.equal(getResearchRunInput(started.run.id)?.executionMode, 'research');
    assert.ok(scheduled);
    scheduled();
    await waitFor(() => getResearchRun(started.run.id)?.status === 'completed');
    assert.equal(agentCalled, true);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('quick conversation fails cleanly when the stream throws', async () => {
  const conversation = createResearchConversation();
  let scheduled: (() => void) | undefined;
  const failingLlm: LlmProvider = {
    complete: async () => ({ choices: [] }),
    stream: async () => { throw new Error('boom'); }
  };
  try {
    const started = createAndStartResearchRun({
      conversationId: conversation.id,
      content: '你好',
      toolPolicy: { mode: 'none' },
      toolRuntime,
      llm: failingLlm,
      schedule: (callback) => { scheduled = callback; },
      runAgent: async () => ({ reply: '', toolCalls: [], trace: [], sources: [] })
    });

    assert.ok(scheduled);
    scheduled();
    await waitFor(() => getResearchRun(started.run.id)?.status === 'failed');
    const assistant = listResearchMessages(conversation.id)
      .find((message) => message.id === started.assistantMessage.id);
    assert.equal(assistant?.status, 'error');
  } finally {
    deleteResearchConversation(conversation.id);
  }
});
