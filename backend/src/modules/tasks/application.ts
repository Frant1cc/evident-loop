import type { LlmProvider } from '../../llm/contracts.js';
import { LlmNotConfiguredError } from '../../llm/errors.js';
import type { ToolRuntime } from '../../tools/contracts.js';
import type { ApprovalManager } from '../../approvals/contracts.js';
import { normalizeToolPolicy } from '../../tools/policy.js';
import { executeAgentTask, finalizeAgentTask } from '../../runtime/executor.js';
import {
  createAgentTask,
  deleteAgentTask,
  getAgentTaskDetail,
  listAllAgentArtifacts,
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
  approvalManager?: ApprovalManager;
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
  const withApprovals = <T extends { task: { id: string } } | undefined>(detail: T): T => {
    if (!detail || !dependencies.approvalManager) return detail;
    return {
      ...detail,
      approvals: dependencies.approvalManager.list({ type: 'agent_task', id: detail.task.id })
    } as T;
  };

  return {
    list: listAgentTasks,
    listArtifacts: listAllAgentArtifacts,
    get: (id: string) => {
      const detail = getAgentTaskDetail(id);
      return withApprovals(detail);
    },
    events: listAgentTaskEvents,
    create,
    delete: deleteAgentTask,
    updatePlan: (id: string, steps: PlanStepDraft[]) => updateAgentTaskPlan(id, steps),
    approve: (id: string) => transitionAgentTask(id, 'running', 'plan approved'),
    transition: (id: string, status: AgentTaskStatus, reason?: string) => {
      if (status === 'cancelled') dependencies.approvalManager?.cancelScope({ type: 'agent_task', id });
      return transitionAgentTask(id, status, reason);
    },
    retryStep: (taskId: string, stepId: string) => retryAgentPlanStep(taskId, stepId),
    saveEvidenceChain: (taskId: string, stepId: string, draft: EvidenceChainDraft) =>
      saveAgentEvidenceChain(taskId, stepId, draft),
    plan: (id: string, signal?: AbortSignal) => planAgentTask({
      id,
      llm: requireLlm(),
      model: dependencies.model,
      signal
    }),
    run: async (id: string, signal?: AbortSignal) => withApprovals(await executeAgentTask({
      id,
      llm: requireLlm(),
      model: dependencies.model,
      toolRuntime: dependencies.toolRuntime,
      approvalManager: dependencies.approvalManager,
      signal
    })),
    finalize: async (id: string, signal?: AbortSignal) => withApprovals(await finalizeAgentTask({
      id,
      llm: requireLlm(),
      model: dependencies.model,
      toolRuntime: dependencies.toolRuntime,
      approvalManager: dependencies.approvalManager,
      signal
    }))
  };
}

export type TaskApplication = ReturnType<typeof createTaskApplication>;
