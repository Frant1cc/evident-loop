import cors from 'cors';
import express from 'express';

import { createConfiguredLlm } from './llm/config.js';
import type { LlmProvider } from './llm/contracts.js';
import { createArtifactApplication, type ArtifactApplication } from './modules/artifacts/index.js';
import { createResearchApplication, getActiveResearchRun } from './modules/research/index.js';
import { createTaskApplication } from './modules/tasks/index.js';
import { createAgentRouter } from './routes/agent.js';
import { artifactStore } from './artifacts/store.js';
import { createArtifactsRouter } from './routes/artifacts.js';
import { dbTestRouter } from './routes/dbTest.js';
import { deepseekRouter } from './routes/deepseek.js';
import { evaluationsRouter } from './routes/evaluations.js';
import { healthRouter } from './routes/health.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { createResearchRouter } from './routes/research.js';
import { createTasksRouter } from './routes/tasks.js';
import type { ToolCatalog } from './tools/contracts.js';
import { createToolCatalog, toolCatalog } from './tools/registry.js';
import { createToolRuntime } from './tools/runtime.js';
import { createStartArtifactGenerationTool } from './tools/artifactGenerationTool.js';
import { createArtifactImageTools } from './tools/artifactImageTools.js';
import { createDefaultResearchSkillRuntime } from './skills/runtime.js';
import type { McpManager } from './mcp/contracts.js';
import { createMcpManager } from './mcp/manager.js';
import { createMcpRouter, mcpSecurityMiddleware } from './mcp/routes.js';
import type { ToolRuntime } from './tools/contracts.js';
import { createApprovalManager, createToolApprovalRouter } from './approvals/index.js';
import type { ApprovalManager } from './approvals/contracts.js';

export type AppDependencies = {
  llm?: LlmProvider;
  model?: string;
  tools?: ToolCatalog;
  toolRuntime?: ToolRuntime;
  mcpManager?: McpManager;
  approvalManager?: ApprovalManager;
  artifactApplication?: ArtifactApplication;
};

export function createApp(dependencies: AppDependencies = {}) {
  const app = express();
  const configuredLlm = createConfiguredLlm();
  const model = dependencies.model ?? configuredLlm.model;
  const llm = dependencies.llm ?? configuredLlm.llm;
  const artifactApplication = dependencies.artifactApplication ?? createArtifactApplication({
    llm,
    model,
    artifactModel: process.env.ARTIFACT_MODEL?.trim() || undefined,
    isResearchConversationActive: (conversationId) => Boolean(getActiveResearchRun(conversationId))
  });
  const tools = dependencies.tools ?? createToolCatalog([
    ...toolCatalog.values(),
    createStartArtifactGenerationTool(artifactApplication),
    ...createArtifactImageTools(artifactApplication)
  ]);
  const toolRuntime = dependencies.toolRuntime ?? createToolRuntime(tools);
  const approvalManager = dependencies.approvalManager ?? createApprovalManager();
  const skillRuntime = createDefaultResearchSkillRuntime({
    knownToolNames: new Set(toolRuntime.getDefinitions().map((tool) => tool.function.name))
  });

  // Every browser-facing API shares the same local-deployment trust boundary.
  // Applying the guard here also protects approval decisions and legacy routes,
  // while requests without an Origin header still need a matching local Host.
  app.use('/api', mcpSecurityMiddleware);
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', healthRouter);
  app.use('/api', knowledgeRouter);
  app.use('/api', deepseekRouter);
  app.use('/api', evaluationsRouter);
  // The legacy one-shot chat surface is intentionally isolated from provider
  // tools. Research Workbench and durable Tasks are the only MCP-capable
  // callers and receive the approval interceptor below.
  app.use('/api', createAgentRouter(createLegacyToolRuntime(toolRuntime)));
  app.use('/api', createToolApprovalRouter(approvalManager));
  app.use('/api', createArtifactsRouter(artifactStore, artifactApplication));
  app.use('/api', createResearchRouter(createResearchApplication({
    llm,
    model,
    toolRuntime,
    skillRuntime,
    approvalManager,
    artifactApplication
  })));
  app.use('/api', createTasksRouter(createTaskApplication({ llm, model, toolRuntime, approvalManager })));
  app.use('/api', dbTestRouter);
  if (dependencies.mcpManager) app.use('/api/mcp', createMcpRouter(dependencies.mcpManager));

  return app;
}

/** Production composition root. Call after initDb() so persistent MCP schemas
 * and tools are loaded before the HTTP server starts accepting requests. */
export function createProductionApp(options: { host?: string; port?: number } = {}) {
  // Keep the production dynamic catalog independent from the compatibility
  // `app` export so MCP upserts cannot leak into a second runtime instance.
  const runtimeCatalog = new Map(toolCatalog);
  const configuredLlm = createConfiguredLlm();
  const artifactApplication = createArtifactApplication({
    llm: configuredLlm.llm,
    model: configuredLlm.model,
    artifactModel: process.env.ARTIFACT_MODEL?.trim() || undefined,
    isResearchConversationActive: (conversationId) => Boolean(getActiveResearchRun(conversationId))
  });
  // A process restart cannot safely resume an in-flight planning LLM call.
  // Mark that request terminal and leave queued requests bound to their
  // originating research run for explicit completion/failure handling.
  artifactApplication.recoverPendingDrafts();
  runtimeCatalog.set(
    'start_artifact_generation',
    createStartArtifactGenerationTool(artifactApplication)
  );
  for (const module of createArtifactImageTools(artifactApplication)) runtimeCatalog.set(module.definition.function.name, module);
  const runtime = createToolRuntime(runtimeCatalog as ToolCatalog);
  const mcpManager = createMcpManager({ runtime, host: options.host, port: options.port });
  const approvalManager = createApprovalManager();
  return {
    app: createApp({ toolRuntime: runtime, artifactApplication, mcpManager, approvalManager }),
    toolRuntime: runtime,
    mcpManager,
    approvalManager,
    artifactApplication
  };
}

// Kept for callers that import the conventional app export (tests and small
// local scripts). Production creates the MCP manager after initDb() via
// createProductionApp(); this export intentionally has no MCP side effects.
export const app = createApp();

function createLegacyToolRuntime(runtime: ToolRuntime): ToolRuntime {
  const artifactToolNames = new Set([
    'start_artifact_generation',
    'fetch_source_image',
    'generate_image'
  ]);
  const modules = runtime.listModules().filter((module) =>
    module.source !== 'mcp' && !artifactToolNames.has(module.definition.function.name)
  );
  return createToolRuntime(new Map(
    modules.map((module) => [module.definition.function.name, module] as const)
  ));
}
