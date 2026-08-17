import cors from 'cors';
import express from 'express';

import { createConfiguredLlm } from './llm/config.js';
import type { LlmProvider } from './llm/contracts.js';
import { createResearchApplication } from './modules/research/index.js';
import { createTaskApplication } from './modules/tasks/index.js';
import { createAgentRouter } from './routes/agent.js';
import { artifactsRouter } from './routes/artifacts.js';
import { dbTestRouter } from './routes/dbTest.js';
import { deepseekRouter } from './routes/deepseek.js';
import { evaluationsRouter } from './routes/evaluations.js';
import { healthRouter } from './routes/health.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { createResearchRouter } from './routes/research.js';
import { createTasksRouter } from './routes/tasks.js';
import type { ToolCatalog } from './tools/contracts.js';
import { toolCatalog } from './tools/registry.js';
import { createToolRuntime } from './tools/runtime.js';
import { createDefaultResearchSkillRuntime } from './skills/runtime.js';

export type AppDependencies = {
  llm?: LlmProvider;
  model?: string;
  tools?: ToolCatalog;
};

export function createApp(dependencies: AppDependencies = {}) {
  const app = express();
  const configuredLlm = createConfiguredLlm();
  const model = dependencies.model ?? configuredLlm.model;
  const tools = dependencies.tools ?? toolCatalog;
  const toolRuntime = createToolRuntime(tools);
  const skillRuntime = createDefaultResearchSkillRuntime({
    knownToolNames: new Set(toolRuntime.getDefinitions().map((tool) => tool.function.name))
  });
  const llm = dependencies.llm ?? configuredLlm.llm;

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', healthRouter);
  app.use('/api', knowledgeRouter);
  app.use('/api', deepseekRouter);
  app.use('/api', evaluationsRouter);
  app.use('/api', createAgentRouter(toolRuntime));
  app.use('/api', artifactsRouter);
  app.use('/api', createResearchRouter(createResearchApplication({ llm, model, toolRuntime, skillRuntime })));
  app.use('/api', createTasksRouter(createTaskApplication({ llm, model, toolRuntime })));
  app.use('/api', dbTestRouter);

  return app;
}

export const app = createApp();
