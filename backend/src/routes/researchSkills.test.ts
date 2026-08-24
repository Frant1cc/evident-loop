import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { initDb } from '../db.js';
import type { LlmProvider } from '../llm/contracts.js';
import { createResearchApplication } from '../modules/research/index.js';
import { createResearchConversation, deleteResearchConversation } from '../research/store.js';
import { createResearchSkillRegistry } from '../skills/registry.js';
import { createResearchSkillRuntime } from '../skills/runtime.js';
import type { OfficialResearchSkill } from '../skills/contracts.js';
import { toolCatalog } from '../tools/registry.js';
import { createToolRuntime } from '../tools/runtime.js';
import { createResearchRouter } from './research.js';

initDb();

const toolRuntime = createToolRuntime(toolCatalog);
const skill: OfficialResearchSkill = {
  id: 'technology-comparison',
  version: '1.0.0',
  label: '技术方案对比',
  description: '统一维度比较技术方案。',
  instructions: 'SECRET-INSTRUCTIONS-DO-NOT-LEAK',
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

// A no-op LLM so the use case passes requireLlm() and the background run is harmless.
const fakeLlm: LlmProvider = {
  complete: async () => ({ choices: [{ message: { role: 'assistant', content: '' } }] }),
  stream: async () => undefined
};

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createResearchRouter(createResearchApplication({
    llm: fakeLlm,
    model: 'test-model',
    toolRuntime,
    skillRuntime
  })));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function postMessage(baseUrl: string, conversationId: string, body: unknown) {
  return fetch(`${baseUrl}/api/research/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('GET /research/skills returns metadata without instructions', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/research/skills`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.code, 1);
    const [info] = payload.data.skills;
    assert.equal(info.id, 'technology-comparison');
    assert.equal(info.instructions, undefined);
    assert.deepEqual(info.requiredTools, ['search_knowledge']);
    assert.ok(!JSON.stringify(payload).includes('SECRET-INSTRUCTIONS-DO-NOT-LEAK'));
  });
});

test('GET /research/tools returns model tools and user-visible groups separately', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/research/tools`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const names = payload.data.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes('search_knowledge'));
    assert.ok(names.includes('read_document'));
    assert.ok(!names.includes('search_docs'));
    assert.ok(!names.includes('knowledge'));
    assert.equal(payload.data.tools.find((tool: { name: string }) => tool.name === 'search_knowledge')?.source, 'builtin');
    assert.equal(payload.data.tools.find((tool: { name: string }) => tool.name === 'search_knowledge')?.status, 'available');
    assert.deepEqual(payload.data.groups, [{
      id: 'knowledge',
      label: '知识库',
      description: '检索知识库，并在需要时阅读相关文档。',
      toolNames: ['search_knowledge', 'read_document']
    }]);
  });
});

test('runs without a skillId', async () => {
  const conversation = createResearchConversation();
  try {
    await withServer(async (baseUrl) => {
      const response = await postMessage(baseUrl, conversation.id, {
        content: '普通研究',
        toolPolicy: { mode: 'all' }
      });
      assert.equal(response.status, 202);
    });
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('unknown skillId returns 400', async () => {
  const conversation = createResearchConversation();
  try {
    await withServer(async (baseUrl) => {
      const response = await postMessage(baseUrl, conversation.id, {
        content: '研究',
        skillId: 'does-not-exist',
        toolPolicy: { mode: 'all' }
      });
      assert.equal(response.status, 400);
    });
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('none policy cannot run a skill with required tools', async () => {
  const conversation = createResearchConversation();
  try {
    await withServer(async (baseUrl) => {
      const response = await postMessage(baseUrl, conversation.id, {
        content: '研究',
        skillId: 'technology-comparison',
        toolPolicy: { mode: 'none' }
      });
      assert.equal(response.status, 409);
      const payload = await response.json();
      assert.match(payload.message, /需要启用工具/);
    });
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('selected policy missing a required tool is rejected', async () => {
  const conversation = createResearchConversation();
  try {
    await withServer(async (baseUrl) => {
      const response = await postMessage(baseUrl, conversation.id, {
        content: '研究',
        skillId: 'technology-comparison',
        toolPolicy: { mode: 'selected', names: ['retrieve_web_evidence'] }
      });
      assert.equal(response.status, 409);
    });
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

test('all policy can run a skill', async () => {
  const conversation = createResearchConversation();
  try {
    await withServer(async (baseUrl) => {
      const response = await postMessage(baseUrl, conversation.id, {
        content: '研究',
        skillId: 'technology-comparison',
        toolPolicy: { mode: 'all' }
      });
      assert.equal(response.status, 202);
    });
  } finally {
    deleteResearchConversation(conversation.id);
  }
});
