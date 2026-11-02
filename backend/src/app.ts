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
import { createStartDocumentGenerationTool } from './tools/documentGenerationTool.js';
import { createDefaultResearchSkillRuntime, createResearchSkillRuntime } from './skills/runtime.js';
import { createResearchSkillRegistry } from './skills/registry.js';
import type { McpManager } from './mcp/contracts.js';
import { createMcpManager } from './mcp/manager.js';
import { createMcpRouter, mcpSecurityMiddleware } from './mcp/routes.js';
import type { ToolRuntime } from './tools/contracts.js';
import { createApprovalManager, createToolApprovalRouter } from './approvals/index.js';
import type { ApprovalManager } from './approvals/contracts.js';
import { createPublicDemoApplication, createDemoToolRuntime, getDemoConfig, isPublicDemoEnabled, type DemoConfig, type PublicDemoApplication } from './modules/demo/index.js';
import { createDemoRouter, demoErrorHandler, demoVisitor } from './routes/demo.js';
import { builtInToolGroups } from './tools/groups.js';

export type AppDependencies = {
  llm?: LlmProvider;
  model?: string;
  tools?: ToolCatalog;
  toolRuntime?: ToolRuntime;
  mcpManager?: McpManager;
  approvalManager?: ApprovalManager;
  artifactApplication?: ArtifactApplication;
  publicDemo?: false | { config?: DemoConfig; now?: () => number };
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
    createStartDocumentGenerationTool(artifactApplication)
  ]);
  const publicDemoEnabled = dependencies.publicDemo !== false && (Boolean(dependencies.publicDemo) || isPublicDemoEnabled());
  const sourceRuntime = dependencies.toolRuntime ?? createToolRuntime(tools);
  const toolRuntime = publicDemoEnabled ? createDemoToolRuntime(sourceRuntime) : sourceRuntime;
  const demo = publicDemoEnabled ? createPublicDemoApplication({
    config: dependencies.publicDemo ? dependencies.publicDemo.config ?? getDemoConfig() : getDemoConfig(),
    now: dependencies.publicDemo ? dependencies.publicDemo.now : undefined,
    llm,
    tools: toolRuntime
  }) : undefined;
  app.locals.publicDemo = demo;
  if (demo?.config.trustProxy) app.set('trust proxy', demo.config.trustProxy);
  const approvalManager = dependencies.approvalManager ?? createApprovalManager();
  const skillRuntime = demo ? createResearchSkillRuntime(createResearchSkillRegistry([], { knownToolNames: new Set() })) : createDefaultResearchSkillRuntime({
    knownToolNames: new Set(toolRuntime.getDefinitions().map((tool) => tool.function.name))
  });

  // Every browser-facing API shares the same local-deployment trust boundary.
  // Applying the guard here also protects approval decisions and legacy routes,
  // while requests without an Origin header still need a matching local Host.
  app.use('/api', mcpSecurityMiddleware);
  app.use('/api', healthRouter);
  app.use('/api', createDemoRouter(demo));
  if (!demo) app.use(cors());
  app.use(express.json({ limit: demo ? '16kb' : '2mb' }));
  app.use('/api', knowledgeRouter);
  app.use('/api', deepseekRouter);
  app.use('/api', evaluationsRouter);
  // The legacy one-shot chat surface is intentionally isolated from provider
  // tools. Research Workbench and durable Tasks are the only MCP-capable
  // callers and receive the approval interceptor below.
  app.use('/api', createAgentRouter(createLegacyToolRuntime(toolRuntime)));
  app.use('/api', createToolApprovalRouter(approvalManager));
  app.use('/api', createArtifactsRouter(artifactStore, artifactApplication));
  const research = createResearchApplication({
    llm,
    model,
    toolRuntime,
    skillRuntime,
    approvalManager,
    artifactApplication: demo ? undefined : artifactApplication,
    toolGroups: demo ? builtInToolGroups.filter((group) => group.toolNames.every((name) =>
      toolRuntime.getDefinitions().some((tool) => tool.function.name === name))) : undefined
  });
  app.use('/api', createResearchRouter(demo ? (req) => {
    const visitor = demoVisitor(req);
    return demo.scopeResearch(research, visitor.id, visitor.ip);
  } : research));
  app.use('/api', createTasksRouter(createTaskApplication({ llm, model, toolRuntime, approvalManager })));
  app.use('/api', dbTestRouter);
  if (dependencies.mcpManager) app.use('/api/mcp', createMcpRouter(dependencies.mcpManager));
  app.use(demoErrorHandler);
  if (demo) {
    app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) { next(error); return; }
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
      res.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({ code: 0, message: status === 413 ? '请求内容过大。' : '体验请求未能完成，请稍后再试。', data: null });
    });
  }

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
    'start_document_generation',
    createStartDocumentGenerationTool(artifactApplication)
  );
  const runtime = createToolRuntime(runtimeCatalog as ToolCatalog);
  const mcpManager = createMcpManager({ runtime, host: options.host, port: options.port });
  const approvalManager = createApprovalManager({ mcpManager });
  const app = createApp({ toolRuntime: runtime, artifactApplication, mcpManager, approvalManager });
  return {
    app,
    publicDemo: app.locals.publicDemo as PublicDemoApplication | undefined,
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
    'start_document_generation'
  ]);
  const modules = runtime.listModules().filter((module) =>
    module.source !== 'mcp' && !artifactToolNames.has(module.definition.function.name)
  );
  return createToolRuntime(new Map(
    modules.map((module) => [module.definition.function.name, module] as const)
  ));
}
