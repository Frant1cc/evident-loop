import { createHash, randomUUID } from 'node:crypto';

import { runAgentLoop } from '../agent/agentLoop.js';
import type { ApprovalManager, ToolApprovalScope } from '../approvals/contracts.js';
import { redactToolArguments } from '../approvals/manager.js';
import type { LlmProvider } from '../llm/contracts.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { ToolExecutionError, type ToolRuntime, type ToolSnapshot } from '../tools/contracts.js';
import { builtInToolRuntime } from '../tools/runtime.js';
import {
  completeToolExecution,
  failToolExecution,
  getToolExecutionByKey,
  insertToolExecution,
  appendEvent
} from './store.js';
import {
  completeAgentPlanStep,
  failAgentPlanStep,
  getAgentTaskDetail,
  markAgentTaskInProcess,
  saveAgentEvidenceChain,
  saveAgentStepReview,
  startAgentPlanStep,
  transitionAgentTask,
  unmarkAgentTaskInProcess
} from './service.js';
import type { AgentPlanStep, AgentTask, AgentTaskDetail, ToolExecution } from './types.js';
import { createModelStepReviewer, type AgentStepReviewer } from './reviewer.js';
import { createModelEvidenceChainBuilder, type AgentEvidenceChainBuilder } from './evidenceChainBuilder.js';
import { createModelArtifactWriter, saveAgentArtifact, type AgentArtifactWriter } from './writer.js';

const executorSystemPrompt = `You are the Executor in a durable research agent.

Complete only the current plan step. Use allowed tools to collect concrete evidence. Do not invent sources. For search_knowledge, treat verdict as authoritative: sufficient results may be used as evidence; when weak and rewriteTriggered=true, the automatic rewrite budget is already exhausted and the same intent must not be searched again; when weak and rewriteTriggered=false, one reformulated retry is allowed; empty candidates must not be used or cited as evidence, and you must report that the local knowledge base does not cover the point. For retrieve_web_evidence, use only claims with supported=true and cite a URL from that claim's sourceUrls; never fill uncoveredClaims from model memory, especially when verdict is exhausted. Explicitly name every entity in requiredMentions and cite one of that entity's sourceUrls; never paraphrase a required entity as an unnamed new version. If exhausted has no supported claims, distinguish rejected candidates or exhausted control budgets from a provider that returned zero results by using diagnostics. Focused company recovery has already run when diagnostics.recoveryTriggered=true. Stop when the step objective and evidence requirements are satisfied. Return a concise step result with the evidence found and any remaining limitation. Use the same language as the research goal.`;

export type AgentStepRunner = (context: {
  task: AgentTask;
  step: AgentPlanStep;
  completedSteps: AgentPlanStep[];
  signal?: AbortSignal;
}) => Promise<unknown>;

export async function executeAgentTask(options: {
  id: string;
  apiKey?: string;
  llm?: LlmProvider;
  model: string;
  signal?: AbortSignal;
  runStep?: AgentStepRunner;
  buildEvidenceChain?: AgentEvidenceChainBuilder;
  reviewStep?: AgentStepReviewer;
  writeArtifact?: AgentArtifactWriter;
  toolRuntime?: ToolRuntime;
  approvalManager?: ApprovalManager;
}): Promise<AgentTaskDetail | undefined> {
  markAgentTaskInProcess(options.id);
  try {
    return await executeAgentTaskInternal(options);
  } finally {
    unmarkAgentTaskInProcess(options.id);
  }
}

export async function finalizeAgentTask(options: {
  id: string;
  apiKey?: string;
  llm?: LlmProvider;
  model: string;
  signal?: AbortSignal;
  reviewStep?: AgentStepReviewer;
  writeArtifact?: AgentArtifactWriter;
  toolRuntime?: ToolRuntime;
  approvalManager?: ApprovalManager;
}) {
  let detail = getAgentTaskDetail(options.id);
  if (!detail) return undefined;
  if (detail.artifacts.length) return detail;
  if (!detail.steps.length || !detail.steps.every((step) => step.status === 'completed' || step.status === 'skipped')) {
    throw new Error('All plan steps must be completed before creating the final report');
  }

  if (detail.task.status === 'completed') {
    const writeArtifact = options.writeArtifact ?? createModelArtifactWriter(resolveLlmProvider(options), options.model);
    const draft = await writeArtifact({
      task: detail.task,
      steps: detail.steps,
      reviews: detail.reviews,
      evidenceGaps: detail.evidenceGaps,
      sources: detail.sources,
      evidence: detail.evidence,
      claims: detail.claims,
      claimEvidence: detail.claimEvidence,
      signal: options.signal
    });
    saveAgentArtifact(detail.task, draft);
    return getAgentTaskDetail(options.id);
  }

  if (detail.task.status === 'failed') {
    detail = transitionAgentTask(options.id, 'running', 'retry final artifact generation') ?? detail;
  }
  if (detail.task.status !== 'running') throw new Error('Agent task is not ready for final report generation');
  return executeAgentTask({ ...options, runStep: async () => { throw new Error('No plan step should run during finalization'); } });
}

async function executeAgentTaskInternal(options: {
  id: string;
  apiKey?: string;
  llm?: LlmProvider;
  model: string;
  signal?: AbortSignal;
  runStep?: AgentStepRunner;
  buildEvidenceChain?: AgentEvidenceChainBuilder;
  reviewStep?: AgentStepReviewer;
  writeArtifact?: AgentArtifactWriter;
  toolRuntime?: ToolRuntime;
  approvalManager?: ApprovalManager;
}): Promise<AgentTaskDetail | undefined> {
  let detail = getAgentTaskDetail(options.id);
  if (!detail) return undefined;
  if (detail.task.status !== 'running') throw new Error('Agent task must be running before execution');
  if (!detail.steps.length) throw new Error('Agent task has no plan steps');

  while (detail.task.status === 'running') {
    throwIfAborted(options.signal);
    const reviewedStepIds = new Set(detail.reviews.map((review) => review.stepId));
    const unreviewedStep = detail.steps.find(
      (step) => step.status === 'completed' && !reviewedStepIds.has(step.id)
    );
    if (unreviewedStep) {
      const startedAt = new Date().toISOString();
      appendEvent(detail.task.id, 'review_started', { stepId: unreviewedStep.id, sequence: unreviewedStep.sequence }, startedAt);
      try {
        const reviewStep = options.reviewStep ?? createModelStepReviewer(resolveLlmProvider(options), options.model);
        const reviewEvidence = detail.evidence.filter((item) => item.stepId === unreviewedStep.id);
        const reviewClaims = detail.claims.filter((claim) => claim.stepId === unreviewedStep.id);
        const reviewEvidenceIds = new Set(reviewEvidence.map((item) => item.id));
        const reviewClaimIds = new Set(reviewClaims.map((claim) => claim.id));
        const review = await reviewStep({
          task: detail.task,
          step: unreviewedStep,
          toolExecutions: detail.toolExecutions.filter((execution) => execution.stepId === unreviewedStep.id),
          sources: detail.sources.filter((source) => source.stepId === unreviewedStep.id),
          evidence: reviewEvidence,
          claims: reviewClaims,
          claimEvidence: detail.claimEvidence.filter(
            (link) => reviewClaimIds.has(link.claimId) && reviewEvidenceIds.has(link.evidenceId)
          ),
          signal: options.signal
        });
        detail = saveAgentStepReview(detail.task.id, unreviewedStep.id, review);
        continue;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : 'Reviewer failed to evaluate step evidence';
        appendEvent(detail.task.id, 'review_failed', { stepId: unreviewedStep.id, error: message }, new Date().toISOString());
        return transitionAgentTask(detail.task.id, 'failed', message);
      }
    }

    const runningStep = detail.steps.find((step) => step.status === 'running');
    const nextStep = runningStep ?? findNextRunnableStep(detail.steps);

    if (!nextStep) {
      if (detail.steps.every((step) => step.status === 'completed' || step.status === 'skipped')) {
        if (!detail.artifacts.length) {
          try {
            const writeArtifact = options.writeArtifact ?? createModelArtifactWriter(resolveLlmProvider(options), options.model);
            const draft = await writeArtifact({
              task: detail.task,
              steps: detail.steps,
              reviews: detail.reviews,
              evidenceGaps: detail.evidenceGaps,
              sources: detail.sources,
              evidence: detail.evidence,
              claims: detail.claims,
              claimEvidence: detail.claimEvidence,
              signal: options.signal
            });
            saveAgentArtifact(detail.task, draft);
          } catch (error) {
            if (options.signal?.aborted) throw error;
            const message = error instanceof Error ? error.message : 'Writer failed to create final report';
            appendEvent(detail.task.id, 'artifact_failed', { error: message }, new Date().toISOString());
            return transitionAgentTask(detail.task.id, 'failed', message);
          }
        }
        return transitionAgentTask(detail.task.id, 'completed', 'final artifact created');
      }
      throw new Error('Agent task has no runnable plan step');
    }

    if (!runningStep) detail = startAgentPlanStep(detail.task.id, nextStep.id);
    const activeStep = detail.steps.find((step) => step.id === nextStep.id);
    if (!activeStep) throw new Error('Active plan step could not be loaded');

    let phase: 'step_execution' | 'evidence_chain' = 'step_execution';
    try {
      const runStep = options.runStep ?? createDefaultStepRunner(
        resolveLlmProvider(options),
        options.model,
        options.toolRuntime ?? builtInToolRuntime,
        options.approvalManager
      );
      const output = await runStep({
        task: detail.task,
        step: activeStep,
        completedSteps: detail.steps.filter((step) => step.status === 'completed'),
        signal: options.signal
      });
      phase = 'evidence_chain';
      appendEvent(detail.task.id, 'evidence_chain_started', {
        stepId: activeStep.id,
        sequence: activeStep.sequence
      }, new Date().toISOString());
      const refreshed = getAgentTaskDetail(detail.task.id);
      if (!refreshed) throw new Error('Agent task disappeared before evidence extraction');
      const buildEvidenceChain = options.buildEvidenceChain
        ?? createModelEvidenceChainBuilder(resolveLlmProvider(options), options.model);
      const chain = await buildEvidenceChain({
        task: refreshed.task,
        step: activeStep,
        output,
        toolExecutions: refreshed.toolExecutions.filter((execution) => execution.stepId === activeStep.id),
        signal: options.signal
      });
      detail = saveAgentEvidenceChain(detail.task.id, activeStep.id, chain);
      detail = completeAgentPlanStep(detail.task.id, activeStep.id, output);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : 'Agent step execution failed';
      if (phase === 'evidence_chain') {
        appendEvent(detail.task.id, 'evidence_chain_failed', {
          stepId: activeStep.id,
          error: message
        }, new Date().toISOString());
      }
      return failAgentPlanStep(detail.task.id, activeStep.id, message);
    }
  }

  return detail;
}

function createDefaultStepRunner(
  llm: LlmProvider,
  model: string,
  toolRuntime: ToolRuntime,
  approvalManager?: ApprovalManager
): AgentStepRunner {
  return async ({ task, step, completedSteps, signal }) => {
    const result = await runAgentLoop({
      llm,
      model,
      systemPrompt: executorSystemPrompt,
      message: buildStepMessage(task, step, completedSteps),
      toolPolicy: task.toolPolicy,
      toolRuntime,
      signal,
      toolScope: { kind: 'agent_task', taskId: task.id },
      executeTool: (toolCall, context) => executeAuditedTool(
        {
          task,
          step,
          toolCall,
          snapshot: context?.snapshot,
          toolRuntime,
          approvalManager,
          approvalScope: { type: 'agent_task', id: task.id },
          context
        },
        (name, args, executionContext) => {
          const runtimeCall = { id: toolCall.id, name, arguments: args };
          return context?.snapshot
            ? toolRuntime.execute(context.snapshot, runtimeCall, executionContext)
            : toolRuntime.execute(name, args, executionContext);
        }
      )
    });
    return {
      reply: result.reply,
      sources: result.sources,
      toolCalls: result.toolCalls
    };
  };
}

export async function executeAuditedTool(input: {
  task: AgentTask;
  step: AgentPlanStep;
  toolCall: { id: string; name: string; arguments: unknown };
  snapshot?: ToolSnapshot;
  toolRuntime?: ToolRuntime;
  approvalManager?: ApprovalManager;
  approvalScope?: ToolApprovalScope;
  context?: { signal?: AbortSignal; conversationId?: string; toolScope?: import('../tools/contracts.js').ToolScope };
}, execute: (name: string, args: unknown, context?: { signal?: AbortSignal; conversationId?: string; toolScope?: import('../tools/contracts.js').ToolScope }) => Promise<unknown> = (name, args) => builtInToolRuntime.execute(name, args)) {
  // Keep the durable cache key stable across process versions and model call
  // ids: a completed side-effecting execution must be replayed directly. If
  // that semantic execution was rejected/failed, a fresh tool_call_id gets a
  // scoped retry row so it can request approval again without erasing history.
  const baseExecutionKey = createExecutionKey(input.task.id, input.step, input.toolCall.name, input.toolCall.arguments);
  const callScopedKey = `${baseExecutionKey}:${input.toolCall.id}`;
  let executionKey = baseExecutionKey;
  let existing = getToolExecutionByKey(baseExecutionKey);
  if (existing?.status === 'failed') {
    executionKey = callScopedKey;
    existing = getToolExecutionByKey(callScopedKey);
  } else if (!existing) {
    // A scoped retry may already exist when a previous call failed before its
    // base row was committed; otherwise the first call owns the stable key.
    const scoped = getToolExecutionByKey(callScopedKey);
    if (scoped) {
      executionKey = callScopedKey;
      existing = scoped;
    }
  }

  if (existing?.status === 'completed') {
    appendEvent(input.task.id, 'tool_result_reused', {
      stepId: input.step.id,
      executionId: existing.id,
      toolName: existing.toolName,
      executionKey
    }, new Date().toISOString());
    return existing.result;
  }
  if (existing?.status === 'failed') throw new Error(existing.error ?? `${existing.toolName} previously failed`);
  if (existing?.status === 'running') {
    throw new ToolExecutionError({
      code: 'execution_failed',
      message: `Tool execution is incomplete and cannot be replayed: ${existing.toolName}`,
      retryable: true,
      reason: 'The previous process may have reached the remote tool before interruption.'
    });
  }

  const execution = existing ?? createRunningToolExecution(input, executionKey);
  if (!existing) {
    insertToolExecution(execution);
    appendEvent(input.task.id, 'tool_started', {
      stepId: input.step.id,
      executionId: execution.id,
      toolName: execution.toolName,
      arguments: redactToolArguments(execution.arguments)
    }, execution.startedAt);
  }

  try {
    if (input.approvalManager && input.snapshot && input.toolRuntime && input.approvalScope) {
      await input.approvalManager.authorize({
        runtime: input.toolRuntime,
        snapshot: input.snapshot,
        toolCall: input.toolCall,
        scope: input.approvalScope,
        context: input.context,
        onRequested: (approval) => {
          appendEvent(input.task.id, 'tool_approval_requested', { approval }, new Date().toISOString());
        },
        onResolved: (approval) => {
          appendEvent(input.task.id, 'tool_approval_resolved', { approval }, new Date().toISOString());
        }
      });
    }
    const result = await execute(input.toolCall.name, input.toolCall.arguments, input.context);
    const completedAt = new Date().toISOString();
    completeToolExecution(execution.id, result, completedAt);
    appendEvent(input.task.id, 'tool_completed', {
      stepId: input.step.id,
      executionId: execution.id,
      toolName: execution.toolName
    }, completedAt);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution failed';
    const completedAt = new Date().toISOString();
    failToolExecution(execution.id, message, completedAt);
    appendEvent(input.task.id, 'tool_failed', {
      stepId: input.step.id,
      executionId: execution.id,
      toolName: execution.toolName,
      error: message
    }, completedAt);
    throw error;
  }
}

function createRunningToolExecution(
  input: { task: AgentTask; step: AgentPlanStep; toolCall: { name: string; arguments: unknown } },
  executionKey: string
): ToolExecution {
  return {
    id: randomUUID(),
    taskId: input.task.id,
    stepId: input.step.id,
    executionKey,
    toolName: input.toolCall.name,
    status: 'running',
    arguments: input.toolCall.arguments,
    startedAt: new Date().toISOString()
  };
}

function createExecutionKey(taskId: string, step: AgentPlanStep, toolName: string, args: unknown) {
  const hash = createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 16);
  return `${taskId}:${step.id}:${step.attempts}:${toolName}:${hash}`;
}

function findNextRunnableStep(steps: AgentPlanStep[]) {
  const completedIds = new Set(steps.filter((step) => step.status === 'completed').map((step) => step.id));
  return steps.find((step) => step.status === 'pending' && step.dependencies.every((id) => completedIds.has(id)));
}

function buildStepMessage(task: AgentTask, step: AgentPlanStep, completedSteps: AgentPlanStep[]) {
  const priorResults = completedSteps.map((item) => ({ objective: item.objective, output: item.output }));
  return [
    `Overall research goal:\n${task.goal}`,
    `Current step (${step.sequence}):\n${step.objective}`,
    `Required evidence:\n${step.expectedEvidence.map((item) => `- ${item}`).join('\n')}`,
    step.input ? `Focused retrieval instructions:\n${JSON.stringify(step.input)}` : '',
    priorResults.length ? `Previous completed step results:\n${JSON.stringify(priorResults)}` : ''
  ].filter(Boolean).join('\n\n');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Agent task execution was cancelled');
  }
}
