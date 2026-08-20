import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import { createArtifactApplication } from '../modules/artifacts/index.js';
import { createResearchConversation, createResearchMessage } from '../research/store.js';
import { createStartArtifactGenerationTool } from '../tools/artifactGenerationTool.js';
import { ToolExecutionError } from '../tools/contracts.js';
import { createArtifactAgent } from './generation/agent.js';
import { createArtifactGenerationService } from './generation/service.js';

initDb();

test('natural-language artifact tool is bound to ToolContext conversation scope', async () => {
  const first = createResearchConversation();
  const second = createResearchConversation();
  createResearchMessage({ conversationId: first.id, role: 'user', content: '工具作用域', status: 'complete' });
  const application = createArtifactApplication({
    model: 'test',
    generationService: createArtifactGenerationService({ model: 'test', agent: createArtifactAgent({ model: 'test' }) })
  });
  const tool = createStartArtifactGenerationTool(application);
  await assert.rejects(
    async () => await tool.execute({}, { conversationId: undefined }),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'unauthorized'
  );
  await assert.rejects(async () => await tool.execute({ conversationId: first.id }, { conversationId: first.id }), /Unrecognized key/);
  const result = await tool.execute({}, { conversationId: first.id }) as { generationId: string; requiresConfirmation: boolean };
  assert.match(result.generationId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.requiresConfirmation, true);
});
