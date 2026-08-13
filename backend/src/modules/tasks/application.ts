import type { LlmProvider } from '../../llm/contracts.js';
import { LlmNotConfiguredError } from '../../llm/errors.js';
import type { ToolRuntime } from '../../tools/contracts.js';
import { normalizeToolPolicy } from '../../tools/policy.js';
import { executeAgentTask, finalizeAgentTask } from '../../runtime/executor.js';
import {
  createAgentTask,
  deleteAgentTask,
  getAgentTaskDetail,
  listAgentTaskEvents,
  listAgentTasks,
  planAgentTask,
  retryAgentPlanStep,
  saveAgentEvidenceChain,
  transitionAgentTask,
  updateAgentTaskPlan
} from '../../runtime/service.js';
import type {
  AgentTaskStatus,
  EvidenceChainDraft,
  PlanStepDraft
} from '../../runtime/types.js';

export type TaskApplicationDependencies = {
  llm?: LlmProvider;
  model: string;
  toolRuntime: ToolRuntime;
};

/** Use-case boundary for the durable task module. HTTP and provider configuration stay outside it. */
export function createTaskApplication(dependencies: TaskApplicationDependencies) {
  const requireLlm = () => {
    if (!dependencies.llm) throw new LlmNotConfiguredError();
    return dependencies.llm;
  };
  const create = (input: Parameters<typeof createAgentTask>[0]) => {
    const toolPolicy = normalizeToolPolicy(input.toolPolicy ?? input.allowedTools);
    if (toolPolicy.mode === 'selected') {
      const registered = new Set(
        dependencies.toolRuntime.getDefinitions().map((tool) => tool.function.name)
      );
      const unknown = toolPolicy.names.filter((name) => !registered.has(name));
      if (unknown.length) throw new Error(`Unknown tools in toolPolicy: ${unknown.join(', ')}`);
    }
    return createAgentTask({ ...input, toolPolicy, allowedTools: undefined });
  };

  return {
    list: listAgentTasks,
    get: getAgentTaskDetail,
    events: listAgentTaskEvents,
    create,
    delete: deleteAgentTask,
    updatePlan: (id: string, steps: PlanStepDraft[]) => updateAgentTaskPlan(id, steps),
    approve: (id: string) => transitionAgentTask(id, 'running', 'plan approved'),
    transition: (id: string, status: AgentTaskStatus, reason?: string) => transitionAgentTask(id, status, reason),
    retryStep: (taskId: string, stepId: string) => retryAgentPlanStep(taskId, stepId),
    saveEvidenceChain: (taskId: string, stepId: string, draft: EvidenceChainDraft) =>
      saveAgentEvidenceChain(taskId, stepId, draft),
    plan: (id: string, signal?: AbortSignal) => planAgentTask({
      id,
      llm: requireLlm(),
      model: dependencies.model,
      signal
    }),
    run: (id: string, signal?: AbortSignal) => executeAgentTask({
      id,
      llm: requireLlm(),
      model: dependencies.model,
      toolRuntime: dependencies.toolRuntime,
      signal
    }),
    finalize: (id: string, signal?: AbortSignal) => finalizeAgentTask({
      id,
      llm: requireLlm(),
      model: dependencies.model,
      toolRuntime: dependencies.toolRuntime,
      signal
    })
  };
}

export type TaskApplication = ReturnType<typeof createTaskApplication>;
