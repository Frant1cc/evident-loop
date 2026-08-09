import type { LlmProvider } from '../../llm/contracts.js';
import { LlmNotConfiguredError } from '../../llm/errors.js';
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
};

/** Use-case boundary for the durable task module. HTTP and provider configuration stay outside it. */
export function createTaskApplication(dependencies: TaskApplicationDependencies) {
  const requireLlm = () => {
    if (!dependencies.llm) throw new LlmNotConfiguredError();
    return dependencies.llm;
  };

  return {
    list: listAgentTasks,
    get: getAgentTaskDetail,
    events: listAgentTaskEvents,
    create: createAgentTask,
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
      signal
    }),
    finalize: (id: string, signal?: AbortSignal) => finalizeAgentTask({
      id,
      llm: requireLlm(),
      model: dependencies.model,
      signal
    })
  };
}

export type TaskApplication = ReturnType<typeof createTaskApplication>;
