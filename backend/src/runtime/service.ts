import { randomUUID } from 'node:crypto';

import type { ToolPolicy } from '../tools/contracts.js';
import { normalizeToolPolicy } from '../tools/policy.js';
import type { LlmProvider } from '../llm/contracts.js';
import { assertTaskTransition } from './stateMachine.js';
import {
  appendEvent,
  deleteTask,
  getPlanStep,
  getReviewForStep,
  getLatestCheckpoint,
  getTask,
  getClaimByKey,
  getEvidenceByKey,
  getSourceByKey,
  insertCheckpoint,
  insertPlanSteps,
  insertReview,
  insertEvidenceGaps,
  insertSupplementalPlanStep,
  insertTask,
  listArtifacts,
  listEvents,
  listPlanSteps,
  listReviews,
  listEvidenceGaps,
  listAgentEvidence,
  listClaims,
  listClaimEvidence,
  listSources,
  listTasks,
  listToolExecutions,
  markPlanStepCompleted,
  markPlanStepFailed,
  markPlanStepRunning,
  replacePlanSteps,
  resetPlanStepForRetry,
  scheduleEvidenceGaps,
  markEvidenceGapsUnresolved,
  settleEvidenceGapsForSupplementalStep,
  runInTransaction,
  updateTaskExecutionState,
  updateTaskStatus,
  upsertClaim,
  upsertClaimEvidence,
  upsertEvidence,
  upsertSource
} from './store.js';
import { generatePlanWithModel } from './planner.js';
import type {
  AgentReview,
  AgentReviewDraft,
  AgentClaim,
  AgentEvidence,
  AgentSource,
  AgentTask,
  AgentTaskDetail,
  AgentTaskStatus,
  EvidenceGap,
  EvidenceChainDraft,
  PlanStepDraft
} from './types.js';

const defaultMaxSteps = 8;
const defaultMaxTokens = 40_000;

export type CreateAgentTaskInput = {
  goal: string;
  maxSteps?: number;
  maxTokens?: number;
  toolPolicy?: ToolPolicy;
  /** @deprecated Compatibility with the previous task API. */
  allowedTools?: string[];
};

export function createAgentTask(input: CreateAgentTaskInput): AgentTaskDetail {
  const goal = input.goal.trim();
  if (!goal) throw new Error('goal is required');

  const now = new Date().toISOString();
  const task: AgentTask = {
    id: randomUUID(),
    goal,
    status: 'created',
    maxSteps: parsePositiveInteger(input.maxSteps, defaultMaxSteps, 'maxSteps'),
    maxTokens: parsePositiveInteger(input.maxTokens, defaultMaxTokens, 'maxTokens'),
    toolPolicy: normalizeToolPolicy(input.toolPolicy ?? input.allowedTools),
    checkpointVersion: 1,
    createdAt: now,
    updatedAt: now
  };

  return runInTransaction(() => {
    insertTask(task);
    appendEvent(task.id, 'task_created', { goal: task.goal, constraints: getConstraints(task) }, now);
    const state = {
      task,
      steps: [],
      reviews: [],
      evidenceGaps: [],
      sources: [],
      evidence: [],
      claims: [],
      claimEvidence: []
    };
    const latestCheckpoint = insertCheckpoint(task.id, task.checkpointVersion, state, now);
    return { ...state, toolExecutions: [], artifacts: [], latestCheckpoint };
  })();
}

export function getAgentTaskDetail(id: string): AgentTaskDetail | undefined {
  const task = getTask(id);
  if (!task) return undefined;
  return buildTaskDetail(task, getLatestCheckpoint(id));
}

const inProcessTaskIds = new Set<string>();
const ORPHAN_INTERRUPTED = '任务在进程退出后中断';

export function markAgentTaskInProcess(id: string) {
  if (inProcessTaskIds.has(id)) throw new Error('Agent task is already executing in this process');
  inProcessTaskIds.add(id);
}

export function unmarkAgentTaskInProcess(id: string) {
  inProcessTaskIds.delete(id);
}

export function isAgentTaskInProcess(id: string) {
  return inProcessTaskIds.has(id);
}

export function failOrphanedAgentTasks() {
  for (const task of listTasks()) {
    if (task.status !== 'planning' && task.status !== 'running') continue;
    if (inProcessTaskIds.has(task.id)) continue;
    transitionAgentTask(task.id, 'failed', ORPHAN_INTERRUPTED);
  }
}

export function listAgentTasks() {
  return listTasks();
}

export function deleteAgentTask(id: string) {
  return runInTransaction(() => {
    const task = getTask(id);
    if (!task) return undefined;
    if ((task.status === 'planning' || task.status === 'running') && inProcessTaskIds.has(id)) {
      throw new Error('正在规划或执行的任务不能删除');
    }
    if (!deleteTask(id)) throw new Error('Agent task disappeared while deleting');
    return task;
  })();
}

export function listAgentTaskEvents(id: string) {
  if (!getTask(id)) return undefined;
  return listEvents(id);
}

export function transitionAgentTask(id: string, nextStatus: AgentTaskStatus, reason?: string): AgentTaskDetail | undefined {
  return runInTransaction(() => {
    const current = getTask(id);
    if (!current) return undefined;
    assertTaskTransition(current.status, nextStatus);

    const now = new Date().toISOString();
    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskStatus(id, nextStatus, checkpointVersion, now);
    const task = getTask(id);
    if (!task) throw new Error('Agent task disappeared during transition');

    const steps = listPlanSteps(id);
    appendEvent(id, 'task_status_changed', {
      from: current.status,
      to: nextStatus,
      ...(reason?.trim() ? { reason: reason.trim() } : {})
    }, now);
    const latestCheckpoint = insertCheckpoint(id, checkpointVersion, buildCheckpointState(task, steps), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export function saveAgentTaskPlan(id: string, drafts: PlanStepDraft[]): AgentTaskDetail | undefined {
  return runInTransaction(() => {
    const current = getTask(id);
    if (!current) return undefined;
    assertTaskTransition(current.status, 'awaiting_approval');
    if (listPlanSteps(id).length) throw new Error('Agent task already has a plan');
    if (!drafts.length || drafts.length > current.maxSteps) throw new Error(`plan must contain 1-${current.maxSteps} steps`);

    const now = new Date().toISOString();
    const steps = insertPlanSteps(id, drafts, now);
    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskStatus(id, 'awaiting_approval', checkpointVersion, now);
    const task = getTask(id);
    if (!task) throw new Error('Agent task disappeared while saving plan');

    appendEvent(id, 'plan_created', {
      steps: steps.map((step) => ({ id: step.id, sequence: step.sequence, objective: step.objective }))
    }, now);
    appendEvent(id, 'task_status_changed', { from: current.status, to: 'awaiting_approval' }, now);
    const latestCheckpoint = insertCheckpoint(id, checkpointVersion, buildCheckpointState(task, steps), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export function updateAgentTaskPlan(id: string, drafts: PlanStepDraft[]): AgentTaskDetail | undefined {
  return runInTransaction(() => {
    const current = getTask(id);
    if (!current) return undefined;
    if (current.status !== 'awaiting_approval') {
      throw new Error('Only a task awaiting approval can edit its plan');
    }
    const previousSteps = listPlanSteps(id);
    if (previousSteps.some((step) => step.status !== 'pending')) {
      throw new Error('Only a fully pending plan can be edited');
    }
    const normalizedDrafts = normalizePlanDrafts(drafts, current.maxSteps, current.goal);
    const now = new Date().toISOString();
    const steps = replacePlanSteps(id, normalizedDrafts, now);
    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskStatus(id, 'awaiting_approval', checkpointVersion, now);
    const task = getTask(id);
    if (!task) throw new Error('Agent task disappeared while updating plan');

    appendEvent(id, 'plan_updated', {
      previousStepCount: previousSteps.length,
      steps: steps.map((step) => ({ id: step.id, sequence: step.sequence, objective: step.objective }))
    }, now);
    const latestCheckpoint = insertCheckpoint(id, checkpointVersion, buildCheckpointState(task, steps), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export function startAgentPlanStep(taskId: string, stepId: string): AgentTaskDetail {
  return runInTransaction(() => {
    const current = requireTask(taskId);
    if (current.status !== 'running') throw new Error('Agent task must be running to start a step');
    const currentStep = getPlanStep(stepId);
    if (!currentStep || currentStep.taskId !== taskId) throw new Error('Plan step not found');

    const stepsBefore = listPlanSteps(taskId);
    const completedIds = new Set(stepsBefore.filter((step) => step.status === 'completed').map((step) => step.id));
    if (currentStep.dependencies.some((dependency) => !completedIds.has(dependency))) {
      throw new Error('Plan step dependencies are not completed');
    }

    const now = new Date().toISOString();
    const step = markPlanStepRunning(stepId, now);
    if (!step) throw new Error('Plan step disappeared while starting');
    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskExecutionState({ id: taskId, status: 'running', currentStepId: stepId, checkpointVersion, updatedAt: now });
    const task = requireTask(taskId);
    const steps = listPlanSteps(taskId);
    appendEvent(taskId, 'step_started', { stepId, sequence: step.sequence, attempt: step.attempts }, now);
    const latestCheckpoint = insertCheckpoint(taskId, checkpointVersion, buildCheckpointState(task, steps), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export function completeAgentPlanStep(taskId: string, stepId: string, output: unknown): AgentTaskDetail {
  return runInTransaction(() => {
    const current = requireTask(taskId);
    if (current.status !== 'running' || current.currentStepId !== stepId) throw new Error('Plan step is not the active task step');
    const now = new Date().toISOString();
    const step = markPlanStepCompleted(stepId, output, now);
    if (!step) throw new Error('Plan step disappeared while completing');
    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskExecutionState({ id: taskId, status: 'running', checkpointVersion, updatedAt: now });
    const task = requireTask(taskId);
    const steps = listPlanSteps(taskId);
    appendEvent(taskId, 'step_completed', { stepId, sequence: step.sequence, attempt: step.attempts }, now);
    const latestCheckpoint = insertCheckpoint(taskId, checkpointVersion, buildCheckpointState(task, steps), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export function saveAgentStepReview(taskId: string, stepId: string, draft: AgentReviewDraft): AgentTaskDetail {
  return runInTransaction(() => {
    const current = requireTask(taskId);
    if (current.status !== 'running') throw new Error('Agent task must be running to save a review');
    const step = getPlanStep(stepId);
    if (!step || step.taskId !== taskId || step.status !== 'completed') {
      throw new Error('Only a completed task step can be reviewed');
    }

    const existing = getReviewForStep(stepId);
    if (existing) return buildTaskDetail(current, getLatestCheckpoint(taskId));

    const now = new Date().toISOString();
    const review: AgentReview = {
      id: randomUUID(),
      taskId,
      stepId,
      verdict: draft.verdict,
      summary: draft.summary.trim(),
      supportedClaims: normalizeReviewStrings(draft.supportedClaims),
      unsupportedClaims: normalizeReviewStrings(draft.unsupportedClaims),
      limitations: normalizeReviewStrings(draft.limitations),
      createdAt: now
    };
    if (!review.summary) throw new Error('Review summary is required');

    const existingGaps = listEvidenceGaps(taskId);
    const isSupplementalStep = existingGaps.some((gap) => gap.supplementalStepId === stepId);
    const gapDrafts = draft.verdict === 'needs_more_evidence' ? draft.evidenceGaps : [];
    if (draft.verdict === 'needs_more_evidence' && !gapDrafts.length) {
      throw new Error('Evidence gaps are required when evidence is insufficient');
    }

    const gaps = gapDrafts.map<EvidenceGap>((gap) => ({
      id: randomUUID(),
      reviewId: review.id,
      taskId,
      stepId,
      description: gap.description.trim(),
      requiredEvidence: gap.requiredEvidence.trim(),
      suggestedQuery: gap.suggestedQuery.trim(),
      status: 'open',
      createdAt: now
    })).filter((gap) => gap.description && gap.requiredEvidence && gap.suggestedQuery);
    if (draft.verdict === 'needs_more_evidence' && !gaps.length) {
      throw new Error('Reviewer returned invalid evidence gaps');
    }

    insertReview(review);
    insertEvidenceGaps(gaps);
    appendEvent(taskId, 'review_completed', {
      reviewId: review.id,
      stepId,
      verdict: review.verdict,
      evidenceGapCount: gaps.length
    }, now);
    if (gaps.length) {
      appendEvent(taskId, 'evidence_gap_detected', {
        reviewId: review.id,
        stepId,
        gaps: gaps.map((gap) => ({ id: gap.id, description: gap.description }))
      }, now);
    }

    if (isSupplementalStep) {
      const resolution = review.verdict === 'pass' ? 'resolved' : 'unresolved';
      settleEvidenceGapsForSupplementalStep(stepId, resolution, now);
      if (gaps.length) markEvidenceGapsUnresolved(gaps.map((gap) => gap.id), now);
      appendEvent(taskId, resolution === 'resolved' ? 'evidence_gap_resolved' : 'evidence_gap_unresolved', {
        stepId,
        reason: resolution === 'unresolved' ? '补充检索后证据仍不足，已达到最多一次补充检索限制' : undefined
      }, now);
    } else if (gaps.length) {
      const steps = listPlanSteps(taskId);
      const expansionUsed = existingGaps.some((gap) => Boolean(gap.supplementalStepId));
      const canSchedule = !expansionUsed && steps.length < current.maxSteps && hasRetrievalTool(current.toolPolicy);
      if (canSchedule) {
        const supplemental = insertSupplementalPlanStep({
          taskId,
          objective: `补充检索：${gaps.map((gap) => gap.description).join('；')}`,
          expectedEvidence: [...new Set(gaps.map((gap) => gap.requiredEvidence))],
          dependencies: steps.map((item) => item.id),
          stepInput: {
            reviewId: review.id,
            evidenceGapIds: gaps.map((gap) => gap.id),
            suggestedQueries: gaps.map((gap) => gap.suggestedQuery),
            expansionRound: 1
          },
          createdAt: now
        });
        scheduleEvidenceGaps(gaps.map((gap) => gap.id), supplemental.id);
        appendEvent(taskId, 'supplemental_step_added', {
          reviewId: review.id,
          stepId: supplemental.id,
          sequence: supplemental.sequence,
          evidenceGapIds: gaps.map((gap) => gap.id),
          expansionRound: 1
        }, now);
      } else {
        markEvidenceGapsUnresolved(gaps.map((gap) => gap.id), now);
        const reason = expansionUsed
          ? '已达到最多一次补充检索限制'
          : steps.length >= current.maxSteps
            ? '已达到任务最大步骤数'
            : '任务未开放可用的检索工具';
        appendEvent(taskId, 'evidence_gap_unresolved', { stepId, evidenceGapIds: gaps.map((gap) => gap.id), reason }, now);
      }
    }

    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskExecutionState({ id: taskId, status: 'running', checkpointVersion, updatedAt: now });
    const task = requireTask(taskId);
    const steps = listPlanSteps(taskId);
    const latestCheckpoint = insertCheckpoint(taskId, checkpointVersion, buildCheckpointState(task, steps), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export function saveAgentEvidenceChain(taskId: string, stepId: string, draft: EvidenceChainDraft): AgentTaskDetail {
  return runInTransaction(() => {
    const current = requireTask(taskId);
    const step = getPlanStep(stepId);
    if (!step || step.taskId !== taskId) throw new Error('Plan step not found');
    if (step.status !== 'running' && step.status !== 'completed') {
      throw new Error('Evidence chain can only be saved for a running or completed step');
    }
    validateEvidenceChainDraft(draft);

    const now = new Date().toISOString();
    const toolExecutionIds = new Set(listToolExecutions(taskId).map((execution) => execution.id));
    const sources = draft.sources.map((source) => {
      const sourceKey = source.sourceKey.trim();
      if (source.toolExecutionId && !toolExecutionIds.has(source.toolExecutionId)) {
        throw new Error(`Tool execution ${source.toolExecutionId} does not belong to this task`);
      }
      const existing = getSourceByKey(taskId, sourceKey);
      const entity: AgentSource = {
        id: existing?.id ?? randomUUID(),
        taskId,
        stepId,
        ...(source.toolExecutionId ? { toolExecutionId: source.toolExecutionId } : {}),
        sourceKey,
        type: source.type,
        title: source.title.trim(),
        ...(source.uri?.trim() ? { uri: source.uri.trim() } : {}),
        ...(source.metadata === undefined ? {} : { metadata: source.metadata }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      return upsertSource(entity);
    });

    const evidence = draft.evidence.map((item) => {
      const evidenceKey = item.evidenceKey.trim();
      const sourceKey = item.sourceKey.trim();
      const source = sources.find((candidate) => candidate.sourceKey === sourceKey)
        ?? getSourceByKey(taskId, sourceKey);
      if (!source) throw new Error(`Evidence source ${sourceKey} was not found`);
      const existing = getEvidenceByKey(taskId, evidenceKey);
      const entity: AgentEvidence = {
        id: existing?.id ?? randomUUID(),
        taskId,
        stepId,
        sourceId: source.id,
        evidenceKey,
        content: item.content.trim(),
        ...(item.context?.trim() ? { context: item.context.trim() } : {}),
        ...(item.locator === undefined ? {} : { locator: item.locator }),
        ...(item.relevanceScore === undefined ? {} : { relevanceScore: item.relevanceScore }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      return upsertEvidence(entity);
    });

    const claims = draft.claims.map((item) => {
      const claimKey = item.claimKey.trim();
      const existing = getClaimByKey(taskId, claimKey);
      const entity: AgentClaim = {
        id: existing?.id ?? randomUUID(),
        taskId,
        stepId,
        claimKey,
        text: item.text.trim(),
        status: item.status,
        ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      return upsertClaim(entity);
    });

    const links = draft.links.map((item) => {
      const claimKey = item.claimKey.trim();
      const evidenceKey = item.evidenceKey.trim();
      const claim = claims.find((candidate) => candidate.claimKey === claimKey)
        ?? getClaimByKey(taskId, claimKey);
      const evidenceItem = evidence.find((candidate) => candidate.evidenceKey === evidenceKey)
        ?? getEvidenceByKey(taskId, evidenceKey);
      if (!claim) throw new Error(`Claim ${claimKey} was not found`);
      if (!evidenceItem) throw new Error(`Evidence ${evidenceKey} was not found`);
      return upsertClaimEvidence({
        taskId,
        claimId: claim.id,
        evidenceId: evidenceItem.id,
        relation: item.relation,
        ...(item.rationale?.trim() ? { rationale: item.rationale.trim() } : {}),
        createdAt: now,
        updatedAt: now
      });
    });

    appendEvent(taskId, 'evidence_chain_saved', {
      stepId,
      sources: sources.map((source) => source.id),
      evidence: evidence.map((item) => item.id),
      claims: claims.map((claim) => claim.id),
      links: links.length
    }, now);
    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskExecutionState({
      id: taskId,
      status: current.status,
      currentStepId: current.currentStepId,
      checkpointVersion,
      updatedAt: now
    });
    const task = requireTask(taskId);
    const latestCheckpoint = insertCheckpoint(taskId, checkpointVersion, buildCheckpointState(task), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export function failAgentPlanStep(taskId: string, stepId: string, error: string): AgentTaskDetail {
  return runInTransaction(() => {
    const current = requireTask(taskId);
    if (current.status !== 'running' || current.currentStepId !== stepId) throw new Error('Plan step is not the active task step');
    const now = new Date().toISOString();
    const step = markPlanStepFailed(stepId, error, now);
    if (!step) throw new Error('Plan step disappeared while failing');
    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskExecutionState({ id: taskId, status: 'failed', checkpointVersion, updatedAt: now });
    const task = requireTask(taskId);
    const steps = listPlanSteps(taskId);
    appendEvent(taskId, 'step_failed', { stepId, sequence: step.sequence, attempt: step.attempts, error }, now);
    appendEvent(taskId, 'task_status_changed', { from: 'running', to: 'failed', reason: error }, now);
    const latestCheckpoint = insertCheckpoint(taskId, checkpointVersion, buildCheckpointState(task, steps), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export function retryAgentPlanStep(taskId: string, stepId: string): AgentTaskDetail {
  return runInTransaction(() => {
    const current = requireTask(taskId);
    if (current.status !== 'failed') throw new Error('Agent task must be failed before retrying a step');
    const currentStep = getPlanStep(stepId);
    if (!currentStep || currentStep.taskId !== taskId) throw new Error('Plan step not found');
    const now = new Date().toISOString();
    const step = resetPlanStepForRetry(stepId, now);
    if (!step) throw new Error('Plan step disappeared while resetting');
    const checkpointVersion = current.checkpointVersion + 1;
    updateTaskExecutionState({ id: taskId, status: 'running', checkpointVersion, updatedAt: now });
    const task = requireTask(taskId);
    const steps = listPlanSteps(taskId);
    appendEvent(taskId, 'step_retry_requested', { stepId, previousAttempts: currentStep.attempts }, now);
    appendEvent(taskId, 'task_status_changed', { from: 'failed', to: 'running', reason: 'step retry' }, now);
    const latestCheckpoint = insertCheckpoint(taskId, checkpointVersion, buildCheckpointState(task, steps), now);
    return buildTaskDetail(task, latestCheckpoint);
  })();
}

export async function planAgentTask(options: {
  id: string;
  apiKey?: string;
  llm?: LlmProvider;
  model: string;
  signal?: AbortSignal;
}) {
  const initial = getTask(options.id);
  if (!initial) return undefined;
  if (initial.status !== 'created') throw new Error('Only created tasks can be planned');

  markAgentTaskInProcess(options.id);
  try {
    const planning = transitionAgentTask(options.id, 'planning');
    if (!planning) return undefined;

    try {
      const drafts = await generatePlanWithModel({ task: planning.task, ...options });
      return saveAgentTaskPlan(options.id, drafts);
    } catch (error) {
      const current = getTask(options.id);
      if (current?.status === 'planning') {
        transitionAgentTask(options.id, 'failed', error instanceof Error ? error.message : 'Planner failed');
      }
      throw error;
    }
  } finally {
    unmarkAgentTaskInProcess(options.id);
  }
}

function getConstraints(task: AgentTask) {
  return { maxSteps: task.maxSteps, maxTokens: task.maxTokens, toolPolicy: task.toolPolicy };
}

function parsePositiveInteger(value: number | undefined, fallback: number, field: string) {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function buildCheckpointState(task: AgentTask, steps = listPlanSteps(task.id)) {
  return {
    task,
    steps,
    reviews: listReviews(task.id),
    evidenceGaps: listEvidenceGaps(task.id),
    sources: listSources(task.id),
    evidence: listAgentEvidence(task.id),
    claims: listClaims(task.id),
    claimEvidence: listClaimEvidence(task.id)
  };
}

function buildTaskDetail(task: AgentTask, latestCheckpoint = getLatestCheckpoint(task.id)): AgentTaskDetail {
  const state = buildCheckpointState(task);
  return {
    ...state,
    toolExecutions: listToolExecutions(task.id),
    artifacts: listArtifacts(task.id),
    ...(latestCheckpoint ? { latestCheckpoint } : {})
  };
}

function normalizeReviewStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizePlanDrafts(drafts: PlanStepDraft[], maxSteps: number, goal: string): PlanStepDraft[] {
  if (!Array.isArray(drafts) || !drafts.length || drafts.length > maxSteps) {
    throw new Error(`plan must contain 1-${maxSteps} steps`);
  }
  const normalized = drafts.map((draft, index) => {
    const objective = typeof draft?.objective === 'string' ? draft.objective.trim() : '';
    const evidence = Array.isArray(draft?.expectedEvidence) ? draft.expectedEvidence : [];
    const expectedEvidence = [
      ...new Set(evidence.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))
    ];
    if (!objective) throw new Error(`Plan step ${index + 1} objective is required`);
    if (!expectedEvidence.length) {
      throw new Error(`Plan step ${index + 1} expectedEvidence must be a non-empty string array`);
    }
    return { objective, expectedEvidence };
  });
  if (/\p{Script=Han}/u.test(goal) && normalized.some(
    (draft) =>
      !/\p{Script=Han}/u.test(draft.objective)
      || draft.expectedEvidence.some((item) => !/\p{Script=Han}/u.test(item))
  )) {
    throw new Error('中文任务的计划目标和证据要求必须包含中文');
  }
  return normalized;
}

function hasRetrievalTool(policy: ToolPolicy) {
  if (policy.mode === 'all') return true;
  if (policy.mode === 'none') return false;
  return policy.names.some((tool) =>
    ['search_knowledge', 'search_docs', 'read_document', 'retrieve_web_evidence', 'web_search', 'fetch_page'].includes(tool)
  );
}

function validateEvidenceChainDraft(draft: EvidenceChainDraft) {
  if (!draft || !Array.isArray(draft.sources) || !Array.isArray(draft.evidence)
    || !Array.isArray(draft.claims) || !Array.isArray(draft.links)) {
    throw new Error('Evidence chain must contain sources, evidence, claims and links arrays');
  }
  assertUniqueKeys(draft.sources.map((item) => requiredValue(item.sourceKey, 'sourceKey')), 'sourceKey');
  assertUniqueKeys(draft.evidence.map((item) => requiredValue(item.evidenceKey, 'evidenceKey')), 'evidenceKey');
  assertUniqueKeys(draft.claims.map((item) => requiredValue(item.claimKey, 'claimKey')), 'claimKey');
  for (const source of draft.sources) {
    requiredValue(source.title, 'source title');
    if (!['knowledge_document', 'document', 'web', 'tool_result', 'other'].includes(source.type)) {
      throw new Error(`Invalid source type: ${String(source.type)}`);
    }
    assertJsonSerializable(source.metadata, 'source metadata');
  }
  for (const item of draft.evidence) {
    requiredValue(item.sourceKey, 'evidence sourceKey');
    requiredValue(item.content, 'evidence content');
    assertScore(item.relevanceScore, 'relevanceScore');
    assertJsonSerializable(item.locator, 'evidence locator');
  }
  for (const claim of draft.claims) {
    requiredValue(claim.text, 'claim text');
    if (!['proposed', 'supported', 'unsupported', 'conflicted'].includes(claim.status)) {
      throw new Error(`Invalid claim status: ${String(claim.status)}`);
    }
    assertScore(claim.confidence, 'confidence');
  }
  const linkKeys = draft.links.map((link) => {
    const claimKey = requiredValue(link.claimKey, 'link claimKey');
    const evidenceKey = requiredValue(link.evidenceKey, 'link evidenceKey');
    if (!['supports', 'contradicts', 'context'].includes(link.relation)) {
      throw new Error(`Invalid claim-evidence relation: ${String(link.relation)}`);
    }
    return `${claimKey}\u0000${evidenceKey}`;
  });
  assertUniqueKeys(linkKeys, 'claim-evidence link');
}

function requiredValue(value: string, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function assertUniqueKeys(keys: string[], field: string) {
  if (new Set(keys).size !== keys.length) throw new Error(`${field} values must be unique within a batch`);
}

function assertScore(value: number | undefined, field: string) {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error(`${field} must be between 0 and 1`);
  }
}

function assertJsonSerializable(value: unknown, field: string) {
  if (value === undefined) return;
  try {
    JSON.stringify(value);
  } catch {
    throw new Error(`${field} must be JSON serializable`);
  }
}

function requireTask(id: string) {
  const task = getTask(id);
  if (!task) throw new Error('Agent task not found');
  return task;
}
