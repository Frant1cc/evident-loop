import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import { composeResearchSystemPrompt, createAndStartResearchRun } from '../research/service.js';
import {
  createResearchConversation,
  deleteResearchConversation,
  getResearchRun,
  getResearchRunInput,
  listResearchSteps
} from '../research/store.js';
import { createResearchSkillRegistry } from './registry.js';
import { createResearchSkillRuntime } from './runtime.js';
import type { OfficialResearchSkill } from './contracts.js';
import { toolCatalog } from '../tools/registry.js';
import { createToolRuntime } from '../tools/runtime.js';

initDb();

const toolRuntime = createToolRuntime(toolCatalog);
const skill: OfficialResearchSkill = {
  id: 'technology-comparison',
  version: '1.0.0',
  label: '技术方案对比',
  description: '统一维度比较技术方案。',
  instructions: 'SKILL-BODY-COMPARE-CANDIDATES',
  tools: {
    recommended: ['search_knowledge', 'read_document'],
    required: ['search_knowledge']
  }
};
const skillRuntime = createResearchSkillRuntime(
  createResearchSkillRegistry([skill], {
    knownToolNames: new Set(toolRuntime.getDefinitions().map((tool) => tool.function.name))
  })
);
const BASE = 'BASE-SYSTEM-PROMPT';

test('composeResearchSystemPrompt leaves the base prompt unchanged without a skill', () => {
  assert.equal(composeResearchSystemPrompt(BASE), BASE);
});

test('composeResearchSystemPrompt appends only the selected skill block', () => {
  const composed = composeResearchSystemPrompt(BASE, skill);
  assert.ok(composed.startsWith(BASE));
  assert.match(composed, /<official_research_skill id="technology-comparison" version="1\.0\.0">/);
  assert.ok(composed.includes('SKILL-BODY-COMPARE-CANDIDATES'));
});

test('run input persists the skill snapshot and the first llm step carries only metadata', async () => {
  const conversation = createResearchConversation();
  let scheduled: (() => void) | undefined;
  try {
    const snapshot = skillRuntime.createSnapshot('technology-comparison');
    let observedPrompt: string | undefined;
    const started = createAndStartResearchRun({
      conversationId: conversation.id,
      content: '比较两个方案',
      toolPolicy: { mode: 'all' },
      toolRuntime,
      skill: snapshot,
      skillRuntime,
      apiKey: 'test-only',
      schedule: (callback) => { scheduled = callback; },
      runAgent: async (options) => {
        observedPrompt = options.systemPrompt;
        await options.onEvent?.({ type: 'llm', title: '模型调用', model: options.model, tools: ['search_knowledge'] });
        return { reply: '完成', toolCalls: [], trace: [], sources: [] };
      }
    });

    const runInput = getResearchRunInput(started.run.id);
    assert.deepEqual(runInput?.skill, snapshot);

    assert.ok(scheduled);
    scheduled();
    await waitFor(() => getResearchRun(started.run.id)?.status === 'completed');

    // Composed prompt injects instructions; user content and events do not.
    assert.ok(observedPrompt?.includes('SKILL-BODY-COMPARE-CANDIDATES'));

    const llmStep = listResearchSteps(conversation.id)
      .find((step) => step.messageId === started.assistantMessage.id && step.type === 'llm');
    const input = llmStep?.input as { skill?: unknown };
    assert.deepEqual(input?.skill, snapshot);
    assert.ok(!JSON.stringify(llmStep).includes('SKILL-BODY-COMPARE-CANDIDATES'));
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('a run without a skill produces the exact base prompt and no skill metadata', async () => {
  const conversation = createResearchConversation();
  let scheduled: (() => void) | undefined;
  try {
    let observedPrompt: string | undefined;
    const started = createAndStartResearchRun({
      conversationId: conversation.id,
      content: '普通研究',
      toolPolicy: { mode: 'all' },
      toolRuntime,
      skillRuntime,
      apiKey: 'test-only',
      schedule: (callback) => { scheduled = callback; },
      runAgent: async (options) => {
        observedPrompt = options.systemPrompt;
        await options.onEvent?.({ type: 'llm', title: '模型调用', model: options.model, tools: [] });
        return { reply: '完成', toolCalls: [], trace: [], sources: [] };
      }
    });

    assert.equal(getResearchRunInput(started.run.id)?.skill, undefined);
    assert.ok(scheduled);
    scheduled();
    await waitFor(() => getResearchRun(started.run.id)?.status === 'completed');

    assert.ok(!observedPrompt?.includes('official_research_skill'));
    const llmStep = listResearchSteps(conversation.id)
      .find((step) => step.messageId === started.assistantMessage.id && step.type === 'llm');
    assert.equal((llmStep?.input as { skill?: unknown }).skill, undefined);
  } finally {
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
