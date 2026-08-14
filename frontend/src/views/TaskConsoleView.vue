<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  PhArrowClockwise,
  PhArrowDown,
  PhArrowUp,
  PhCheck,
  PhCircleNotch,
  PhClockCounterClockwise,
  PhFileText,
  PhListChecks,
  PhMagnifyingGlass,
  PhPlus,
  PhShieldCheck,
  PhTrash,
  PhWrench
} from '@phosphor-icons/vue';

import {
  approveAgentTask,
  createAgentTask,
  deleteAgentTask,
  finalizeAgentTask,
  getAgentTask,
  getAgentTaskEvents,
  listAgentTasks,
  planAgentTask,
  retryAgentTaskStep,
  runAgentTask,
  updateAgentTaskPlan
} from '../api/tasks';
import type {
  AgentEvent,
  AgentClaim,
  AgentPlanStep,
  AgentReview,
  AgentTask,
  AgentTaskDetail,
  AgentTaskStatus,
  PlanStepDraft,
  ToolExecution
} from '../types/tasks';
import { listResearchTools } from '../api/research';
import MarkdownMessage from '../components/chat/MarkdownMessage.vue';
import PanelResizeHandle from '../components/common/PanelResizeHandle.vue';
import TaskCreateForm from '../components/tasks/TaskCreateForm.vue';
import TaskHistorySidebar from '../components/tasks/TaskHistorySidebar.vue';
import TaskInspector, { type TaskInspectorTab } from '../components/tasks/TaskInspector.vue';
import TaskRuntimeHeader from '../components/tasks/TaskRuntimeHeader.vue';
import TaskStatusBadge from '../components/tasks/TaskStatusBadge.vue';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { useCollapsiblePanel, useResizablePanel, type PanelWidthBounds } from '../composables/useResizablePanel';

defineOptions({ name: 'TaskConsoleView' });

const sidebarBounds: PanelWidthBounds = { defaultWidth: 252, min: 60, max: 440 };
const inspectorBounds: PanelWidthBounds = { defaultWidth: 400, min: 300, max: 680 };
const sidebarWidth = useResizablePanel('tasks:sidebar-width', sidebarBounds);
const inspectorWidth = useResizablePanel('tasks:inspector-width', inspectorBounds);
const sidebarCollapsed = useCollapsiblePanel('tasks:sidebar-collapsed');
const inspectorCollapsed = useCollapsiblePanel('tasks:inspector-collapsed');
const sidebarCompact = computed(() => sidebarCollapsed.value || sidebarWidth.value < 128);
const sidebarTrack = computed(() => (sidebarCollapsed.value ? '60px' : `${sidebarWidth.value}px`));
const inspectorTrack = computed(() => (inspectorCollapsed.value ? '48px' : `${inspectorWidth.value}px`));

const tasks = ref<AgentTask[]>([]);
const activeTaskId = ref<string>();
const runningTaskId = ref<string>();
const detail = ref<AgentTaskDetail>();
const events = ref<AgentEvent[]>([]);
const inspectorTab = ref<TaskInspectorTab>('events');
const mobileInspectorOpen = ref(false);
const mobileTasksOpen = ref(false);
const creating = ref(false);
const initialLoading = ref(true);
const busyAction = ref<'create' | 'plan' | 'save-plan' | 'approve' | 'run' | 'retry' | 'finalize' | 'delete'>();
const deleteTarget = ref<AgentTask>();
const deleteTargetSummary = computed(() => {
  const normalizedGoal = deleteTarget.value?.goal.replace(/\s+/g, ' ').trim() ?? '';
  const characters = Array.from(normalizedGoal);
  return characters.length > 72 ? `${characters.slice(0, 72).join('')}…` : normalizedGoal;
});
const error = ref('');
const goal = ref('');
const maxSteps = ref(5);
const maxTokens = ref(24000);
const selectedTools = ref(['search_knowledge', 'search_docs', 'read_document', 'retrieve_web_evidence']);
type EditablePlanDraft = PlanStepDraft & { key: string };
const planDrafts = ref<EditablePlanDraft[]>([]);
let pollTimer: ReturnType<typeof window.setInterval> | undefined;
let elapsedTimer: ReturnType<typeof window.setInterval> | undefined;
const now = ref(Date.now());
let runController: AbortController | undefined;
let viewSequence = 0;
let runSequence = 0;

// Fallback list; replaced on mount by the live registry so new tools show up automatically.
const availableTools = ref<Array<{ name: string; label: string }>>([
  { name: 'search_knowledge', label: '知识库检索' },
  { name: 'search_docs', label: '文档关键词搜索' },
  { name: 'read_document', label: '文档全文阅读' },
  { name: 'retrieve_web_evidence', label: '受控联网检索' }
]);

async function loadAvailableTools() {
  try {
    const { tools } = await listResearchTools();
    availableTools.value = tools.map((tool) => ({ name: tool.name, label: tool.label || tool.name }));
    // Default to everything the registry currently offers; the user deselects per task as needed.
    selectedTools.value = availableTools.value.map((tool) => tool.name);
  } catch {
    // Keep the fallback list when the registry endpoint is unavailable.
  }
}

const activeTask = computed(() => detail.value?.task);
const isViewingRunningTask = computed(() =>
  activeTask.value?.status === 'running' || activeTaskId.value === runningTaskId.value
);
const completedStepCount = computed(() => detail.value?.steps.filter((step) => step.status === 'completed').length ?? 0);
const progress = computed(() => {
  const total = detail.value?.steps.length ?? 0;
  return total ? Math.round((completedStepCount.value / total) * 100) : 0;
});
const finalArtifact = computed(() => detail.value?.artifacts[0]);
const allStepsCompleted = computed(() => Boolean(
  detail.value?.steps.length && detail.value.steps.every((step) => step.status === 'completed' || step.status === 'skipped')
));
const supportedClaimCount = computed(() => detail.value?.claims.filter((claim) => claim.status === 'supported').length ?? 0);
const claimCoverage = computed(() => {
  const claims = detail.value?.claims ?? [];
  if (!claims.length) return 0;
  const directlySupported = claims.filter((claim) => detail.value?.claimEvidence.some(
    (link) => link.claimId === claim.id && link.relation === 'supports'
  )).length;
  return Math.round((directlySupported / claims.length) * 100);
});
const unlinkedEvidence = computed(() => {
  const linkedIds = new Set(detail.value?.claimEvidence.map((link) => link.evidenceId) ?? []);
  return detail.value?.evidence.filter((item) => !linkedIds.has(item.id)) ?? [];
});
const planValid = computed(() =>
  planDrafts.value.length > 0
  && planDrafts.value.every(
    (draft) => draft.objective.trim() && draft.expectedEvidence.some((evidence) => evidence.trim())
  )
);
const planDirty = computed(() => {
  const drafts = planDrafts.value.map((draft) => ({
    objective: draft.objective.trim(),
    expectedEvidence: draft.expectedEvidence.map((item) => item.trim()).filter(Boolean)
  }));
  const persisted = (detail.value?.steps ?? []).map((step) => ({
    objective: step.objective,
    expectedEvidence: step.expectedEvidence
  }));
  return JSON.stringify(drafts) !== JSON.stringify(persisted);
});

onMounted(async () => {
  elapsedTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
  try {
    await Promise.all([loadTasks(), loadAvailableTools()]);
    if (tasks.value[0]) await selectTask(tasks.value[0].id);
    else creating.value = true;
  } catch (err) {
    error.value = getErrorMessage(err);
    if (!tasks.value.length) creating.value = true;
  } finally {
    initialLoading.value = false;
  }
});

onBeforeUnmount(() => {
  viewSequence += 1;
  runSequence += 1;
  stopPolling();
  if (elapsedTimer) window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  runController?.abort();
  runController = undefined;
  runningTaskId.value = undefined;
});

async function loadTasks() {
  const data = await listAgentTasks();
  tasks.value = data.tasks;
  adoptServerRunningTask();
}

function adoptServerRunningTask() {
  const running = tasks.value.find((task) => task.status === 'running');
  if (!running) return;
  if (runningTaskId.value === running.id && pollTimer) return;
  runningTaskId.value = running.id;
  if (busyAction.value !== 'run') busyAction.value = 'run';
  startPolling(running.id, runSequence);
}

async function selectTask(id: string) {
  if ((busyAction.value && busyAction.value !== 'run') || id === activeTaskId.value) return;
  const sequence = ++viewSequence;
  error.value = '';
  creating.value = false;
  activeTaskId.value = id;
  detail.value = undefined;
  planDrafts.value = [];
  events.value = [];
  try {
    const [taskDetail, taskEvents] = await Promise.all([getAgentTask(id), getAgentTaskEvents(id)]);
    if (!isCurrentView(id, sequence)) return;
    applyVisibleDetail(id, taskDetail);
    applyVisibleEvents(id, taskEvents.events);
  } catch (err) {
    if (isCurrentView(id, sequence)) error.value = getErrorMessage(err);
  }
}

function openCreate() {
  if (busyAction.value) return;
  viewSequence += 1;
  creating.value = true;
  activeTaskId.value = undefined;
  detail.value = undefined;
  planDrafts.value = [];
  events.value = [];
  error.value = '';
}

function toggleTaskSidebar() {
  if (sidebarCollapsed.value) {
    sidebarCollapsed.value = false;
    if (sidebarWidth.value < 128) sidebarWidth.value = sidebarBounds.defaultWidth;
    return;
  }
  if (sidebarWidth.value < 128) {
    sidebarWidth.value = sidebarBounds.defaultWidth;
    return;
  }
  sidebarCollapsed.value = true;
}

function requestTaskDelete(task: AgentTask) {
  if (busyAction.value || (task.status === 'running' && runningTaskId.value === task.id)) return;
  deleteTarget.value = task;
}

async function confirmTaskDelete() {
  const target = deleteTarget.value;
  if (!target || busyAction.value) return;
  busyAction.value = 'delete';
  error.value = '';
  const wasActive = activeTaskId.value === target.id;

  try {
    await deleteAgentTask(target.id);
    tasks.value = tasks.value.filter((task) => task.id !== target.id);
    deleteTarget.value = undefined;

    if (wasActive) {
      activeTaskId.value = undefined;
      detail.value = undefined;
      planDrafts.value = [];
      events.value = [];
      creating.value = !tasks.value.length;
    }

    busyAction.value = undefined;
    if (wasActive && tasks.value[0]) await selectTask(tasks.value[0].id);
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    if (busyAction.value === 'delete') busyAction.value = undefined;
  }
}

async function submitTask() {
  const normalizedGoal = goal.value.trim();
  if (!normalizedGoal || busyAction.value) return;
  busyAction.value = 'create';
  error.value = '';
  try {
    const created = await createAgentTask({
      goal: normalizedGoal,
      maxSteps: maxSteps.value,
      maxTokens: maxTokens.value,
      toolPolicy: selectedTools.value.length === availableTools.value.length
        ? { mode: 'all' }
        : selectedTools.value.length
          ? { mode: 'selected', names: selectedTools.value }
          : { mode: 'none' }
    });
    const sequence = ++viewSequence;
    activeTaskId.value = created.task.id;
    applyVisibleDetail(created.task.id, created);
    creating.value = false;
    goal.value = '';
    await refreshEvents(created.task.id, sequence);
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    busyAction.value = undefined;
  }
}

async function generatePlan() {
  const id = activeTaskId.value;
  const sequence = viewSequence;
  if (!id || busyAction.value) return;
  busyAction.value = 'plan';
  error.value = '';
  try {
    applyVisibleDetail(id, await planAgentTask(id));
    if (isCurrentView(id, sequence)) inspectorTab.value = 'events';
    await refreshEvents(id, sequence);
  } catch (err) {
    if (isCurrentView(id, sequence)) error.value = getErrorMessage(err);
    await refreshActive(id, sequence).catch(() => undefined);
  } finally {
    busyAction.value = undefined;
  }
}

async function approveAndRun() {
  const id = activeTaskId.value;
  const sequence = viewSequence;
  if (!id || busyAction.value || planDirty.value || !planValid.value) return;
  busyAction.value = 'approve';
  error.value = '';
  try {
    applyVisibleDetail(id, await approveAgentTask(id));
    await refreshEvents(id, sequence);
  } catch (err) {
    if (isCurrentView(id, sequence)) error.value = getErrorMessage(err);
    busyAction.value = undefined;
    return;
  }
  busyAction.value = undefined;
  await executeTask(id);
}

async function savePlanEdits() {
  const id = activeTaskId.value;
  const sequence = viewSequence;
  if (!id || busyAction.value || activeTask.value?.status !== 'awaiting_approval' || !planValid.value) return;
  busyAction.value = 'save-plan';
  error.value = '';
  try {
    applyVisibleDetail(id, await updateAgentTaskPlan(id, planDrafts.value.map((draft) => ({
      objective: draft.objective.trim(),
      expectedEvidence: [...new Set(draft.expectedEvidence.map((item) => item.trim()).filter(Boolean))]
    }))));
    await refreshEvents(id, sequence);
  } catch (err) {
    if (isCurrentView(id, sequence)) error.value = getErrorMessage(err);
    await refreshActive(id, sequence).catch(() => undefined);
  } finally {
    busyAction.value = undefined;
  }
}

function addPlanStep() {
  if (!activeTask.value || planDrafts.value.length >= activeTask.value.maxSteps) return;
  planDrafts.value.push({ key: crypto.randomUUID(), objective: '', expectedEvidence: [''] });
}

function removePlanStep(index: number) {
  if (planDrafts.value.length <= 1) return;
  planDrafts.value.splice(index, 1);
}

function movePlanStep(index: number, offset: number) {
  const target = index + offset;
  if (target < 0 || target >= planDrafts.value.length) return;
  const [draft] = planDrafts.value.splice(index, 1);
  if (draft) planDrafts.value.splice(target, 0, draft);
}

function addPlanEvidence(index: number) {
  planDrafts.value[index]?.expectedEvidence.push('');
}

function removePlanEvidence(stepIndex: number, evidenceIndex: number) {
  const draft = planDrafts.value[stepIndex];
  if (!draft || draft.expectedEvidence.length <= 1) return;
  draft.expectedEvidence.splice(evidenceIndex, 1);
}

async function executeTask(id = activeTaskId.value) {
  if (!id || busyAction.value || runningTaskId.value) return;
  const sequence = ++runSequence;
  busyAction.value = 'run';
  runningTaskId.value = id;
  error.value = '';
  const controller = new AbortController();
  runController = controller;
  startPolling(id, sequence);
  try {
    const result = await runAgentTask(id, controller.signal);
    if (!isCurrentRun(id, sequence)) return;
    applyTaskSummary(result.task);
    if (activeTaskId.value === id) {
      applyVisibleDetail(id, result);
      await refreshEvents(id, viewSequence);
    }
  } catch (err) {
    if (!isCurrentRun(id, sequence)) return;
    if ((err as Error).name !== 'AbortError' && activeTaskId.value === id) error.value = getErrorMessage(err);
    if (activeTaskId.value === id) await refreshActive(id, viewSequence).catch(() => undefined);
  } finally {
    if (!isCurrentRun(id, sequence)) return;
    stopPolling();
    if (runController === controller) runController = undefined;
    runningTaskId.value = undefined;
    busyAction.value = undefined;
    await loadTasks().catch(() => undefined);
    if (activeTaskId.value === id) await refreshActive(id, viewSequence).catch(() => undefined);
  }
}

async function retryStep(step: AgentPlanStep) {
  const id = activeTaskId.value;
  const sequence = viewSequence;
  if (!id || busyAction.value) return;
  busyAction.value = 'retry';
  error.value = '';
  try {
    applyVisibleDetail(id, await retryAgentTaskStep(id, step.id));
    await refreshEvents(id, sequence);
  } catch (err) {
    if (isCurrentView(id, sequence)) error.value = getErrorMessage(err);
    busyAction.value = undefined;
    return;
  }
  busyAction.value = undefined;
  await executeTask(id);
}

async function generateFinalReport() {
  const id = activeTaskId.value;
  const sequence = viewSequence;
  if (!id || busyAction.value) return;
  busyAction.value = 'finalize';
  error.value = '';
  try {
    applyVisibleDetail(id, await finalizeAgentTask(id));
    await refreshEvents(id, sequence);
  } catch (err) {
    if (isCurrentView(id, sequence)) error.value = getErrorMessage(err);
    await refreshActive(id, sequence).catch(() => undefined);
  } finally {
    busyAction.value = undefined;
  }
}

function startPolling(taskId: string, sequence: number) {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    if (!isCurrentRun(taskId, sequence)) return;
    try {
      const [taskDetail, taskEvents] = await Promise.all([getAgentTask(taskId), getAgentTaskEvents(taskId)]);
      if (!isCurrentRun(taskId, sequence)) return;
      applyTaskSummary(taskDetail.task);
      if (activeTaskId.value === taskId) {
        applyVisibleDetail(taskId, taskDetail);
        applyVisibleEvents(taskId, taskEvents.events);
      }
      if (taskDetail.task.status !== 'running' && !runController && runningTaskId.value === taskId) {
        stopPolling();
        runningTaskId.value = undefined;
        busyAction.value = undefined;
      }
    } catch {
      // The blocking run request remains authoritative; a later poll can recover.
    }
  }, 900);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = undefined;
}

async function refreshActive(id = activeTaskId.value, sequence = viewSequence) {
  if (!id) return;
  const [taskDetail, taskEvents] = await Promise.all([
    getAgentTask(id),
    getAgentTaskEvents(id)
  ]);
  if (!isCurrentView(id, sequence)) return;
  applyVisibleDetail(id, taskDetail);
  applyVisibleEvents(id, taskEvents.events);
}

async function refreshEvents(id = activeTaskId.value, sequence = viewSequence) {
  if (!id) return;
  const taskEvents = await getAgentTaskEvents(id);
  if (isCurrentView(id, sequence)) applyVisibleEvents(id, taskEvents.events);
}

function isCurrentView(id: string, sequence: number) {
  return sequence === viewSequence && activeTaskId.value === id;
}

function isCurrentRun(id: string, sequence: number) {
  return sequence === runSequence && runningTaskId.value === id;
}

function applyTaskSummary(task: AgentTask) {
  const index = tasks.value.findIndex((item) => item.id === task.id);
  if (index === -1) {
    tasks.value.unshift(task);
    return;
  }
  const current = tasks.value[index];
  if (current && current.checkpointVersion <= task.checkpointVersion) tasks.value[index] = task;
}

function applyVisibleDetail(id: string, next: AgentTaskDetail) {
  applyTaskSummary(next.task);
  if (activeTaskId.value !== id || next.task.id !== id) return;
  if (detail.value?.task.id === id && detail.value.task.checkpointVersion > next.task.checkpointVersion) return;
  detail.value = next;
  planDrafts.value = next.steps.map((step) => ({
    key: step.id,
    objective: step.objective,
    expectedEvidence: [...step.expectedEvidence]
  }));
}

function applyVisibleEvents(id: string, next: AgentEvent[]) {
  if (activeTaskId.value !== id) return;
  const currentSequence = events.value[events.value.length - 1]?.sequence ?? 0;
  const nextSequence = next[next.length - 1]?.sequence ?? 0;
  if (nextSequence >= currentSequence) events.value = next;
}

function statusLabel(status: AgentTaskStatus) {
  return ({
    created: '已创建',
    planning: '规划中',
    awaiting_approval: '等待批准',
    running: '执行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已取消'
  } satisfies Record<AgentTaskStatus, string>)[status];
}

function stepStatusLabel(status: AgentPlanStep['status']) {
  return ({
    pending: '等待执行',
    running: '执行中',
    completed: '已完成',
    failed: '执行失败',
    blocked: '被阻塞',
    skipped: '已跳过'
  } satisfies Record<AgentPlanStep['status'], string>)[status];
}

function toolStatusLabel(status: ToolExecution['status']) {
  return ({ running: '执行中', completed: '已完成', failed: '执行失败' } satisfies Record<ToolExecution['status'], string>)[status];
}

function toolDisplayName(name: string) {
  return availableTools.value.find((tool) => tool.name === name)?.label ?? name;
}

function toolInputSummary(execution: ToolExecution) {
  const args = toRecord(execution.arguments);
  const value = args?.query ?? args?.path ?? args?.file ?? args?.expression ?? args?.sql;
  if (typeof value === 'string' && value.trim()) return value.trim();
  const serialized = formatJson(execution.arguments).replace(/\s+/g, ' ');
  return serialized.length > 140 ? `${serialized.slice(0, 140)}…` : serialized;
}

function toolStepContext(execution: ToolExecution) {
  const step = detail.value?.steps.find((item) => item.id === execution.stepId);
  return step ? `步骤 ${step.sequence} · ${step.objective}` : '未关联执行步骤';
}

function reviewStepContext(review: AgentReview) {
  const step = detail.value?.steps.find((item) => item.id === review.stepId);
  return step ? `步骤 ${step.sequence} · ${step.objective}` : '未关联执行步骤';
}

function reviewGaps(reviewId: string) {
  return detail.value?.evidenceGaps.filter((gap) => gap.reviewId === reviewId) ?? [];
}

function isSupplementalStep(stepId: string) {
  return detail.value?.evidenceGaps.some((gap) => gap.supplementalStepId === stepId) ?? false;
}

function reviewVerdictLabel(verdict: AgentReview['verdict']) {
  return verdict === 'pass' ? '审查通过' : '证据不足';
}

function claimStepContext(claim: AgentClaim) {
  const step = detail.value?.steps.find((item) => item.id === claim.stepId);
  return step ? `步骤 ${step.sequence}` : '任务级结论';
}

function claimStatusLabel(status: AgentClaim['status']) {
  return ({ proposed: '待验证', supported: '已有支持', unsupported: '证据不足', conflicted: '证据冲突' } as const)[status];
}

function claimStatusClass(status: AgentClaim['status']) {
  if (status === 'supported') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'unsupported') return 'border-destructive/25 bg-destructive/10 text-destructive';
  if (status === 'conflicted') return 'border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300';
  return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

function claimLinks(claimId: string) {
  return (detail.value?.claimEvidence ?? []).flatMap((link) => {
    if (link.claimId !== claimId) return [];
    const evidence = detail.value?.evidence.find((item) => item.id === link.evidenceId);
    if (!evidence) return [];
    const source = detail.value?.sources.find((item) => item.id === evidence.sourceId);
    return [{ link, evidence, source }];
  });
}

function relationLabel(relation: AgentTaskDetail['claimEvidence'][number]['relation']) {
  return ({ supports: '支持', contradicts: '反驳', context: '背景' } as const)[relation];
}

function relationClass(relation: AgentTaskDetail['claimEvidence'][number]['relation']) {
  if (relation === 'supports') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (relation === 'contradicts') return 'border-destructive/25 bg-destructive/10 text-destructive';
  return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300';
}

function sourceTypeLabel(type: AgentTaskDetail['sources'][number]['type']) {
  return ({
    knowledge_document: '知识库',
    document: '文档',
    web: '网页',
    tool_result: '工具结果',
    other: '其他'
  } as const)[type];
}

function sourceEvidenceCount(sourceId: string) {
  return detail.value?.evidence.filter((item) => item.sourceId === sourceId).length ?? 0;
}

function formatEvidenceLocator(locator: unknown) {
  const value = toRecord(locator);
  if (!value) return '';
  const parts: string[] = [];
  if (typeof value.heading === 'string' && value.heading) parts.push(value.heading);
  if (typeof value.pageStart === 'number') {
    parts.push(typeof value.pageEnd === 'number' && value.pageEnd !== value.pageStart
      ? `第 ${value.pageStart}–${value.pageEnd} 页`
      : `第 ${value.pageStart} 页`);
  }
  if (typeof value.originalLineStart === 'number') {
    parts.push(typeof value.originalLineEnd === 'number'
      ? `原文第 ${value.originalLineStart}–${value.originalLineEnd} 行`
      : `原文第 ${value.originalLineStart} 行`);
  }
  if (typeof value.line === 'number') parts.push(`第 ${value.line} 行`);
  if (typeof value.startLine === 'number' && typeof value.pageStart !== 'number' && typeof value.originalLineStart !== 'number') {
    parts.push(typeof value.endLine === 'number' ? `第 ${value.startLine}–${value.endLine} 行` : `第 ${value.startLine} 行`);
  }
  if (value.truncated === true) parts.push('内容已截断');
  return parts.join(' · ');
}

function formatConfidence(value?: number) {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function evidenceGapStatusLabel(status: NonNullable<AgentTaskDetail['evidenceGaps']>[number]['status']) {
  return ({ open: '待处理', scheduled: '已安排补检索', resolved: '已解决', unresolved: '仍未解决' } as const)[status];
}

function evidenceGapStatusClass(status: NonNullable<AgentTaskDetail['evidenceGaps']>[number]['status']) {
  if (status === 'resolved') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'unresolved') return 'border-destructive/25 bg-destructive/10 text-destructive';
  return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

function toolResultItems(execution: ToolExecution) {
  const results = toRecord(execution.result)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    const record = toRecord(item);
    if (!record) return [];
    return [{
      title: String(record.title ?? record.file ?? '未命名结果'),
      heading: typeof record.heading === 'string' ? record.heading : undefined,
      file: typeof record.file === 'string' ? record.file : undefined,
      score: typeof record.score === 'number' ? record.score : undefined
    }];
  });
}

function formatDuration(duration: number) {
  const safeDuration = Math.max(duration, 0);
  if (safeDuration < 1000) return `${safeDuration} ms`;
  const totalSeconds = Math.floor(safeDuration / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function stepDuration(step: AgentPlanStep) {
  if (!step.startedAt) return '';
  const end = step.completedAt ? new Date(step.completedAt).getTime() : now.value;
  return formatDuration(end - new Date(step.startedAt).getTime());
}

const taskDuration = computed(() => {
  const runStartedEvent = events.value.find((event) => {
    if (event.type !== 'task_status_changed') return false;
    return toRecord(event.payload)?.to === 'running';
  });
  const firstStepStartedAt = detail.value?.steps
    .map((step) => step.startedAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const startedAt = runStartedEvent?.createdAt ?? firstStepStartedAt;
  if (!startedAt) return '尚未执行';
  const isActive = activeTask.value?.status === 'running';
  const lastTimestamp = events.value[events.value.length - 1]?.createdAt ?? activeTask.value?.updatedAt;
  const end = isActive ? now.value : new Date(lastTimestamp ?? startedAt).getTime();
  return formatDuration(end - new Date(startedAt).getTime());
});

function toolDuration(execution: ToolExecution) {
  const end = execution.completedAt ? new Date(execution.completedAt).getTime() : now.value;
  return formatDuration(end - new Date(execution.startedAt).getTime());
}

function toRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function eventStep(event: AgentEvent) {
  const payload = toRecord(event.payload);
  const stepId = typeof payload?.stepId === 'string' ? payload.stepId : undefined;
  const sequence = typeof payload?.sequence === 'number' ? payload.sequence : undefined;
  return detail.value?.steps.find((step) => step.id === stepId || step.sequence === sequence);
}

function eventDuration(event: AgentEvent) {
  const payload = toRecord(event.payload);
  const step = eventStep(event);

  if ((event.type === 'step_completed' || event.type === 'step_failed') && step?.startedAt) {
    return { label: '耗时', value: formatDuration(new Date(event.createdAt).getTime() - new Date(step.startedAt).getTime()) };
  }

  if (event.type === 'step_started') {
    const end = step?.completedAt ? new Date(step.completedAt).getTime() : now.value;
    return { label: step?.completedAt ? '耗时' : '已运行', value: formatDuration(end - new Date(event.createdAt).getTime()) };
  }

  const executionId = typeof payload?.executionId === 'string' ? payload.executionId : undefined;
  const execution = detail.value?.toolExecutions.find((item) => item.id === executionId);
  if (event.type === 'tool_started' && execution) {
    const end = execution.completedAt ? new Date(execution.completedAt).getTime() : now.value;
    return { label: execution.completedAt ? '耗时' : '已运行', value: formatDuration(end - new Date(execution.startedAt).getTime()) };
  }
  if ((event.type === 'tool_completed' || event.type === 'tool_failed') && execution) {
    const end = execution.completedAt ?? event.createdAt;
    return { label: '耗时', value: formatDuration(new Date(end).getTime() - new Date(execution.startedAt).getTime()) };
  }

  const phasePairs: Record<string, string> = {
    review_completed: 'review_started',
    review_failed: 'review_started',
    evidence_chain_saved: 'evidence_chain_started',
    evidence_chain_failed: 'evidence_chain_started'
  };
  const startType = phasePairs[event.type];
  if (startType) {
    const start = [...events.value].reverse().find((candidate) => {
      if (candidate.sequence >= event.sequence || candidate.type !== startType) return false;
      const candidateStepId = toRecord(candidate.payload)?.stepId;
      return !payload?.stepId || candidateStepId === payload.stepId;
    });
    if (start) return { label: '耗时', value: formatDuration(new Date(event.createdAt).getTime() - new Date(start.createdAt).getTime()) };
  }

  if (event.type === 'review_started' || event.type === 'evidence_chain_started') {
    const completedTypes = event.type === 'review_started'
      ? new Set(['review_completed', 'review_failed'])
      : new Set(['evidence_chain_saved', 'evidence_chain_failed']);
    const completion = events.value.find((candidate) => {
      if (candidate.sequence <= event.sequence || !completedTypes.has(candidate.type)) return false;
      const candidateStepId = toRecord(candidate.payload)?.stepId;
      return !payload?.stepId || candidateStepId === payload.stepId;
    });
    const end = completion ? new Date(completion.createdAt).getTime() : now.value;
    return { label: completion ? '耗时' : '已运行', value: formatDuration(end - new Date(event.createdAt).getTime()) };
  }

  const previous = events.value.find((candidate) => candidate.sequence === event.sequence - 1);
  return previous
    ? { label: '距上一事件', value: formatDuration(new Date(event.createdAt).getTime() - new Date(previous.createdAt).getTime()) }
    : { label: '起始事件', value: '0 ms' };
}

function eventDescription(event: AgentEvent) {
  const payload = toRecord(event.payload);
  const step = eventStep(event);
  const stepName = step ? `步骤 ${step.sequence}「${step.objective}」` : '当前步骤';
  const toolName = typeof payload?.toolName === 'string' ? toolDisplayName(payload.toolName) : '工具';
  const reason = typeof payload?.reason === 'string' ? payload.reason : undefined;
  const errorMessage = typeof payload?.error === 'string' ? payload.error : undefined;
  const gapCount = Array.isArray(payload?.evidenceGapIds) ? payload.evidenceGapIds.length : undefined;

  const descriptions: Record<string, string> = {
    task_created: '任务已保存，可以开始生成执行计划。',
    plan_created: '执行计划已生成，等待确认后开始运行。',
    plan_updated: '执行计划已按最新修改保存。',
    step_started: `正在执行${stepName}。`,
    step_completed: `${stepName}已执行完成${step?.startedAt ? `，耗时 ${stepDuration(step)}` : ''}。`,
    step_failed: `${stepName}执行失败${errorMessage ? `：${errorMessage}` : '。'}`,
    step_retry_requested: `已请求重新执行${stepName}。`,
    tool_started: `${stepName}正在调用${toolName}。`,
    tool_completed: `${toolName}调用完成，继续处理${stepName}。`,
    tool_failed: `${toolName}调用失败${errorMessage ? `：${errorMessage}` : '。'}`,
    tool_result_reused: `${stepName}复用了已有的工具结果。`,
    review_started: `正在审查${stepName}的证据完整性。`,
    review_completed: `${stepName}的证据审查已完成。`,
    review_failed: `${stepName}的证据审查失败${errorMessage ? `：${errorMessage}` : '。'}`,
    evidence_gap_detected: `审查发现${gapCount ? ` ${gapCount} 个` : ''}证据缺口，需要补充资料。`,
    supplemental_step_added: '已自动加入补充检索步骤。',
    evidence_gap_resolved: '补充检索已解决证据缺口。',
    evidence_gap_unresolved: `证据缺口仍未解决${reason ? `：${reason}` : '。'}`,
    evidence_chain_started: `正在整理${stepName}的来源、证据和结论。`,
    evidence_chain_saved: `${stepName}的证据链已整理并保存。`,
    evidence_chain_failed: `证据链整理失败${errorMessage ? `：${errorMessage}` : '。'}`,
    artifact_created: '全部步骤已汇总，最终报告已生成。',
    artifact_failed: `最终报告生成失败${errorMessage ? `：${errorMessage}` : '。'}`
  };

  if (event.type === 'task_status_changed') {
    const to = typeof payload?.to === 'string' ? payload.to as AgentTaskStatus : undefined;
    return to ? `任务状态已变更为“${statusLabel(to)}”${reason ? `：${reason}` : '。'}` : '任务状态已更新。';
  }
  return descriptions[event.type] ?? '运行状态已更新，展开技术详情可查看原始数据。';
}

function eventLabel(type: string) {
  const labels: Record<string, string> = {
    task_created: '任务已创建',
    task_status_changed: '任务状态变更',
    plan_created: '计划已生成',
    plan_updated: '计划已编辑',
    step_started: '步骤开始',
    step_completed: '步骤完成',
    step_failed: '步骤失败',
    step_retry_requested: '步骤请求重试',
    tool_started: '工具开始执行',
    tool_completed: '工具执行完成',
    tool_failed: '工具执行失败',
    tool_result_reused: '复用工具结果',
    review_started: '开始证据审查',
    review_completed: '证据审查完成',
    review_failed: '证据审查失败',
    evidence_gap_detected: '发现证据缺口',
    supplemental_step_added: '已添加补充检索',
    evidence_gap_resolved: '证据缺口已解决',
    evidence_gap_unresolved: '证据缺口仍未解决',
    evidence_chain_started: '开始构建证据链',
    evidence_chain_saved: '证据链已保存',
    evidence_chain_failed: '证据链构建失败',
    artifact_created: '最终报告已生成',
    artifact_failed: '最终报告生成失败'
  };
  return labels[type] ?? type;
}

function statusClass(status: AgentTaskStatus | AgentPlanStep['status'] | ToolExecution['status']) {
  if (status === 'failed' || status === 'cancelled') return 'border-destructive/25 bg-destructive/10 text-destructive';
  if (status === 'running' || status === 'planning') return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (status === 'completed') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'awaiting_approval') return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  return 'border-[var(--agent-border)] bg-[var(--agent-surface-muted)] text-[var(--agent-text-muted)]';
}

function eventTone(type: string) {
  if (type.includes('failed')) return 'bg-red-500';
  if (type.includes('completed') || type.includes('resolved')) return 'bg-emerald-500';
  if (type.includes('gap') || type.includes('supplemental')) return 'bg-amber-500';
  if (type.includes('started') || type.includes('created')) return 'bg-amber-500';
  return 'bg-muted-foreground/40';
}

function formatJson(value: unknown) {
  return value === undefined ? '—' : JSON.stringify(value, null, 2);
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function getErrorMessage(value: unknown) {
  return value instanceof Error ? value.message : '操作失败';
}
</script>

<template>
  <section
    class="relative grid min-h-0 grid-cols-[var(--sidebar-width)_minmax(0,1fr)_var(--inspector-width)] overflow-hidden max-lg:grid-cols-[var(--sidebar-width)_minmax(0,1fr)] max-md:grid-cols-1"
    :style="{ '--sidebar-width': sidebarTrack, '--inspector-width': inspectorTrack }"
  >
    <PanelResizeHandle
      v-if="!sidebarCollapsed"
      v-model:width="sidebarWidth"
      edge="left"
      :min="sidebarBounds.min"
      :max="sidebarBounds.max"
      :default-width="sidebarBounds.defaultWidth"
      label="调整任务列表宽度"
      class="max-md:hidden"
    />

    <PanelResizeHandle
      v-if="!inspectorCollapsed"
      v-model:width="inspectorWidth"
      edge="right"
      :min="inspectorBounds.min"
      :max="inspectorBounds.max"
      :default-width="inspectorBounds.defaultWidth"
      label="调整运行检查器宽度"
      class="max-lg:hidden"
    />

    <TaskHistorySidebar
      :tasks="tasks"
      :active-task-id="activeTaskId"
      :running-task-id="runningTaskId"
      :compact="sidebarCompact"
      :actions-disabled="Boolean(busyAction)"
      :selection-disabled="Boolean(busyAction && busyAction !== 'run')"
      @create="openCreate"
      @select="selectTask"
      @delete="requestTaskDelete"
      @toggle="toggleTaskSidebar"
    />

    <main class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-[var(--agent-surface)]">
      <TaskRuntimeHeader
        v-if="activeTask"
        :task="activeTask"
        :completed-steps="completedStepCount"
        :total-steps="detail?.steps.length ?? 0"
        :progress="progress"
        :duration="taskDuration"
        :actions-disabled="Boolean(busyAction)"
        @open-inspector="mobileInspectorOpen = true"
        @open-tasks="mobileTasksOpen = true"
        @create="openCreate"
      />
      <header v-else-if="creating" class="hidden min-h-14 items-center gap-2 border-b border-border bg-background px-3 max-md:flex">
        <Button type="button" variant="ghost" size="icon" aria-label="打开任务列表" @click="mobileTasksOpen = true">
          <PhListChecks :size="17" aria-hidden="true" />
        </Button>
        <span class="text-sm font-semibold">新建 Agent 任务</span>
      </header>

      <div class="app-scrollbar row-start-2 min-h-0 overflow-auto overscroll-contain">
        <div v-if="initialLoading" class="mx-auto grid w-full max-w-4xl gap-4 px-6 py-8 max-md:px-4" aria-label="正在加载运行时">
          <div class="h-20 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
          <div class="h-48 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
          <div class="h-32 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        </div>

        <TaskCreateForm
          v-else-if="creating"
          v-model:goal="goal"
          v-model:max-steps="maxSteps"
          v-model:max-tokens="maxTokens"
          v-model:selected-tools="selectedTools"
          :available-tools="availableTools"
          :busy="busyAction === 'create'"
          :error="error"
          @submit="submitTask"
        />

        <div v-else-if="detail" class="mx-auto grid w-full max-w-5xl gap-7 px-6 py-7 max-md:px-4 max-md:py-5">
          <section class="grid grid-cols-[minmax(0,1fr)_auto] items-center overflow-hidden rounded-xl border border-border bg-card max-sm:grid-cols-1">
            <div class="grid grid-cols-4 divide-x divide-border max-sm:grid-cols-2 max-sm:divide-x-0">
              <div class="px-4 py-3 max-sm:border-b max-sm:border-border"><span class="text-[10px] font-medium text-muted-foreground">计划步骤</span><strong class="mt-1 block font-mono text-lg font-semibold tabular-nums">{{ detail.steps.length }}</strong></div>
              <div class="px-4 py-3 max-sm:border-b max-sm:border-border"><span class="text-[10px] font-medium text-muted-foreground">工具执行</span><strong class="mt-1 block font-mono text-lg font-semibold tabular-nums">{{ detail.toolExecutions.length }}</strong></div>
              <div class="px-4 py-3"><span class="text-[10px] font-medium text-muted-foreground">运行事件</span><strong class="mt-1 block font-mono text-lg font-semibold tabular-nums">{{ events.length }}</strong></div>
              <div class="px-4 py-3"><span class="text-[10px] font-medium text-muted-foreground">执行耗时</span><strong class="mt-1 block whitespace-nowrap font-mono text-lg font-semibold tabular-nums">{{ taskDuration }}</strong></div>
            </div>

            <div class="flex flex-wrap items-center justify-end gap-2 border-l border-border px-4 py-3 max-sm:justify-start max-sm:border-l-0 max-sm:border-t">
              <Button v-if="activeTask?.status === 'created'" size="lg" :disabled="Boolean(busyAction)" @click="generatePlan"><PhCircleNotch v-if="busyAction === 'plan'" class="animate-spin" :size="16" aria-hidden="true" /><PhListChecks v-else :size="16" weight="bold" aria-hidden="true" />{{ busyAction === 'plan' ? '正在生成计划' : '生成计划' }}</Button>
              <template v-else-if="activeTask?.status === 'awaiting_approval'">
                <span v-if="planDirty" class="mr-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">有未保存修改</span>
                <Button variant="outline" size="lg" :disabled="Boolean(busyAction) || !planValid || !planDirty" @click="savePlanEdits"><PhCircleNotch v-if="busyAction === 'save-plan'" class="animate-spin" :size="16" aria-hidden="true" /><PhCheck v-else :size="16" weight="bold" aria-hidden="true" />{{ busyAction === 'save-plan' ? '保存中' : '保存计划' }}</Button>
                <Button size="lg" :disabled="Boolean(busyAction) || planDirty || !planValid" @click="approveAndRun"><PhShieldCheck :size="17" weight="bold" aria-hidden="true" />批准并执行</Button>
              </template>
              <Button v-else-if="activeTask?.status === 'running'" size="lg" disabled><PhCircleNotch class="animate-spin" :size="16" aria-hidden="true" />正在执行</Button>
              <TaskStatusBadge v-else-if="activeTask" :status="activeTask.status" :label="statusLabel(activeTask.status)" />
            </div>
          </section>

          <p v-if="error" class="m-0 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive" role="alert">{{ error }}</p>

          <section v-if="finalArtifact" class="overflow-hidden rounded-xl border border-border bg-card">
            <header class="flex items-start justify-between gap-5 border-b border-border bg-muted/40 px-5 py-4">
              <div>
                <p class="m-0 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300"><PhFileText :size="15" weight="bold" aria-hidden="true" /> 最终任务结果</p>
                <h2 class="m-0 mt-1 text-xl font-semibold leading-7 tracking-[-0.025em]">{{ finalArtifact.title }}</h2>
              </div>
              <div class="shrink-0 text-right font-mono text-[10px] leading-5 text-muted-foreground"><TaskStatusBadge status="completed" label="已完成" /><span class="mt-1 block">{{ formatTime(finalArtifact.updatedAt) }}</span></div>
            </header>
            <article class="px-6 py-6 max-md:px-4"><MarkdownMessage :content="finalArtifact.content" /></article>
          </section>

          <section v-else-if="allStepsCompleted && (activeTask?.status === 'completed' || activeTask?.status === 'failed')" class="grid justify-items-center gap-3 rounded-xl border border-dashed border-amber-500/30 bg-amber-500/5 px-5 py-8 text-center">
            <PhFileText :size="26" class="text-amber-700 dark:text-amber-300" aria-hidden="true" />
            <div><h2 class="m-0 text-base font-semibold">步骤已经完成，但还没有最终报告</h2><p class="m-0 mt-1 text-sm text-muted-foreground">Writer 会汇总全部步骤输出，不会重新执行检索工具。</p></div>
            <Button size="lg" :disabled="Boolean(busyAction)" @click="generateFinalReport"><PhCircleNotch v-if="busyAction === 'finalize'" class="animate-spin" :size="15" aria-hidden="true" /><PhFileText v-else :size="15" weight="bold" aria-hidden="true" />{{ busyAction === 'finalize' ? '正在生成最终报告' : '生成最终报告' }}</Button>
          </section>

          <section>
            <div class="mb-3 flex items-end justify-between gap-4">
              <div><p class="m-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">执行计划</p><h2 class="m-0 mt-1 text-lg font-semibold tracking-[-0.02em]">{{ activeTask?.status === 'awaiting_approval' ? '批准前编辑计划' : '可恢复步骤' }}</h2><p v-if="activeTask?.status === 'awaiting_approval'" class="m-0 mt-1 text-xs text-muted-foreground">调整步骤目标、顺序和证据要求，保存后再批准执行。</p></div>
              <span v-if="isViewingRunningTask" class="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300"><PhCircleNotch class="animate-spin" :size="14" aria-hidden="true" /> 正在同步运行状态</span>
            </div>

            <div v-if="!detail.steps.length" class="rounded-xl border border-dashed border-border bg-muted/30 px-5 py-10 text-center text-sm leading-6 text-muted-foreground">计划尚未生成。Planner 会把目标拆成可验证、可恢复的执行步骤。</div>
            <div v-else-if="activeTask?.status === 'awaiting_approval'" class="grid gap-3">
              <article v-for="(draft, index) in planDrafts" :key="draft.key" class="grid gap-3 rounded-xl border border-border bg-muted/30 p-4">
                <div class="flex items-center gap-2">
                  <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background font-mono text-xs font-semibold tabular-nums text-muted-foreground">{{ String(index + 1).padStart(2, '0') }}</span>
                  <input v-model="draft.objective" class="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground outline-none transition-shadow focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" :placeholder="`步骤 ${index + 1} 的执行目标`" :disabled="Boolean(busyAction)" />
                  <Button type="button" variant="ghost" size="icon" :disabled="Boolean(busyAction) || index === 0" title="上移步骤" :aria-label="`上移步骤 ${index + 1}`" @click="movePlanStep(index, -1)"><PhArrowUp :size="14" aria-hidden="true" /></Button>
                  <Button type="button" variant="ghost" size="icon" :disabled="Boolean(busyAction) || index === planDrafts.length - 1" title="下移步骤" :aria-label="`下移步骤 ${index + 1}`" @click="movePlanStep(index, 1)"><PhArrowDown :size="14" aria-hidden="true" /></Button>
                  <Button type="button" variant="ghost" size="icon" class="text-destructive" :disabled="Boolean(busyAction) || planDrafts.length <= 1" title="删除步骤" :aria-label="`删除步骤 ${index + 1}`" @click="removePlanStep(index)"><PhTrash :size="14" aria-hidden="true" /></Button>
                </div>
                <div class="ml-10 grid gap-2">
                  <span class="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">预期证据</span>
                  <div v-for="(_, evidenceIndex) in draft.expectedEvidence" :key="evidenceIndex" class="flex gap-2">
                    <input v-model="draft.expectedEvidence[evidenceIndex]" class="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-xs text-foreground outline-none transition-shadow focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="需要收集或验证的证据" :disabled="Boolean(busyAction)" />
                    <Button type="button" variant="ghost" size="icon-lg" class="text-muted-foreground" :disabled="Boolean(busyAction) || draft.expectedEvidence.length <= 1" title="删除证据要求" aria-label="删除证据要求" @click="removePlanEvidence(index, evidenceIndex)"><PhTrash :size="13" aria-hidden="true" /></Button>
                  </div>
                  <Button type="button" variant="ghost" size="sm" class="w-fit" :disabled="Boolean(busyAction)" @click="addPlanEvidence(index)"><PhPlus :size="13" weight="bold" aria-hidden="true" />增加证据要求</Button>
                </div>
              </article>
              <Button v-if="planDrafts.length < (activeTask?.maxSteps ?? 0)" type="button" variant="outline" size="lg" class="border-dashed text-muted-foreground" :disabled="Boolean(busyAction)" @click="addPlanStep"><PhPlus :size="14" weight="bold" aria-hidden="true" />增加计划步骤</Button>
            </div>
            <div v-else class="grid gap-0">
              <article v-for="(step, index) in detail.steps" :key="step.id" class="group grid grid-cols-[44px_minmax(0,1fr)]">
                <div class="grid grid-rows-[36px_minmax(0,1fr)] justify-items-center">
                  <span class="grid size-9 place-items-center rounded-lg border font-mono text-xs font-semibold tabular-nums" :class="statusClass(step.status)">{{ String(step.sequence).padStart(2, '0') }}</span>
                  <span v-if="index < detail.steps.length - 1" class="h-full w-px bg-border" />
                </div>
                <div class="mb-4 ml-3 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-4 transition-colors group-hover:bg-[var(--agent-surface-muted)]">
                  <div class="flex items-start justify-between gap-4">
                    <div><div class="flex flex-wrap items-center gap-2"><h3 class="m-0 text-sm font-bold leading-5">{{ step.objective }}</h3><span v-if="isSupplementalStep(step.id)" class="inline-flex items-center gap-1 rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-amber-700 dark:text-amber-300"><PhMagnifyingGlass :size="11" weight="bold" aria-hidden="true" />补充检索</span></div><p class="m-0 mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground"><span>第 {{ step.attempts }} 次尝试</span><span v-if="step.startedAt" class="normal-case tracking-normal">{{ step.status === 'running' ? '已运行' : '耗时' }} {{ stepDuration(step) }}</span><span>{{ shortId(step.id) }}</span></p></div>
                    <TaskStatusBadge :status="step.status" :label="stepStatusLabel(step.status)" />
                  </div>
                  <ul class="mb-0 mt-3 grid gap-1 border-l border-border pl-3 text-xs leading-5 text-muted-foreground"><li v-for="evidence in step.expectedEvidence" :key="evidence">{{ evidence }}</li></ul>
                  <p v-if="step.error" class="m-0 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs font-medium leading-5 text-destructive">{{ step.error }}</p>
                  <details v-if="step.output !== undefined" class="mt-3 border-t border-[var(--agent-border)] pt-3"><summary class="cursor-pointer font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--agent-text-muted)]">步骤输出</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-3 font-mono text-[10px] leading-5 text-[var(--agent-text)]">{{ formatJson(step.output) }}</pre></details>
                  <Button v-if="step.status === 'failed' && activeTask?.status === 'failed'" type="button" variant="destructive" size="sm" class="mt-3" :disabled="Boolean(busyAction)" @click="retryStep(step)"><PhArrowClockwise :size="14" weight="bold" aria-hidden="true" />从此步骤重试</Button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </div>
    </main>

    <TaskInspector
      v-model:active-tab="inspectorTab"
      v-model:mobile-open="mobileInspectorOpen"
      :collapsed="inspectorCollapsed"
      :event-count="events.length"
      :review-count="detail?.reviews.length ?? 0"
      :claim-count="detail?.claims.length ?? 0"
      :tool-count="detail?.toolExecutions.length ?? 0"
      @toggle="inspectorCollapsed = !inspectorCollapsed"
    >
      <template #events>
        <div class="grid gap-3">
          <article v-for="event in [...events].reverse()" :key="event.id" class="min-w-0 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5">
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2.5"><span class="size-2.5 shrink-0 rounded-full" :class="eventTone(event.type)" /><strong class="truncate text-[13px] leading-5 text-[var(--agent-text)]">{{ eventLabel(event.type) }}</strong></div>
              <span class="shrink-0 font-mono text-[10px] leading-5 text-[var(--agent-text-muted)]">#{{ event.sequence }} · {{ formatTime(event.createdAt) }}</span>
            </div>
            <p class="m-0 mt-2 break-words pl-5 text-xs font-medium leading-5 text-[var(--agent-text-muted)]">{{ eventDescription(event) }}</p>
            <div class="mt-2 flex items-center gap-1.5 pl-5 font-mono text-[10px] font-bold text-[var(--agent-text-muted)]"><PhClockCounterClockwise :size="13" /><span>{{ eventDuration(event).label }} {{ eventDuration(event).value }}</span></div>
            <details class="mt-3 border-t border-[var(--agent-border)] pt-2.5">
              <summary class="cursor-pointer text-xs font-semibold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">技术详情</summary>
              <div class="mt-2 rounded-md bg-[var(--agent-surface-muted)] p-3">
                <p class="m-0 break-all font-mono text-[10px] font-bold text-[var(--agent-text-muted)]">{{ event.type }}</p>
                <pre class="m-0 mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[var(--agent-text)]">{{ formatJson(event.payload) }}</pre>
              </div>
            </details>
          </article>
          <p v-if="!events.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm text-[var(--agent-text-muted)]">暂无运行事件。</p>
        </div>

      </template>

      <template #reviews>
        <div class="grid gap-3">
          <div v-if="detail?.reviews.length" class="grid grid-cols-3 gap-2">
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">已审查步骤</span><strong class="mt-1 block font-mono text-lg">{{ detail.reviews.length }}</strong></div>
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">证据缺口</span><strong class="mt-1 block font-mono text-lg">{{ detail.evidenceGaps.length }}</strong></div>
            <div class="rounded-lg border border-border bg-card p-3"><span class="text-[10px] font-medium text-muted-foreground">仍未解决</span><strong class="mt-1 block font-mono text-lg text-destructive">{{ detail.evidenceGaps.filter((gap) => gap.status === 'unresolved').length }}</strong></div>
          </div>
          <article v-for="review in [...(detail?.reviews ?? [])].reverse()" :key="review.id" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0"><strong class="block text-[13px] leading-5 text-[var(--agent-text)]">{{ reviewStepContext(review) }}</strong><span class="mt-1 block font-mono text-[10px] text-[var(--agent-text-muted)]">{{ formatTime(review.createdAt) }}</span></div>
              <span class="shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold" :class="review.verdict === 'pass' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'">{{ reviewVerdictLabel(review.verdict) }}</span>
            </div>
            <p class="m-0 mt-3 text-[13px] font-medium leading-5 text-[var(--agent-text)]">{{ review.summary }}</p>

            <div v-if="review.supportedClaims.length" class="mt-3 border-l-2 border-emerald-500/40 pl-3"><span class="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">已有证据支持</span><ul class="mb-0 mt-1 grid gap-1 pl-4 text-xs leading-5 text-muted-foreground"><li v-for="claim in review.supportedClaims" :key="claim">{{ claim }}</li></ul></div>
            <div v-if="review.unsupportedClaims.length" class="mt-3 border-l-2 border-amber-500/40 pl-3"><span class="text-[10px] font-semibold text-amber-700 dark:text-amber-300">尚未充分支持</span><ul class="mb-0 mt-1 grid gap-1 pl-4 text-xs leading-5 text-muted-foreground"><li v-for="claim in review.unsupportedClaims" :key="claim">{{ claim }}</li></ul></div>

            <div v-if="reviewGaps(review.id).length" class="mt-3 grid gap-2 border-t border-[var(--agent-border)] pt-3">
              <div v-for="gap in reviewGaps(review.id)" :key="gap.id" class="rounded-md bg-[var(--agent-surface-muted)] p-3">
                <div class="flex items-start justify-between gap-2"><strong class="text-xs leading-5 text-[var(--agent-text)]">{{ gap.description }}</strong><span class="shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-bold" :class="evidenceGapStatusClass(gap.status)">{{ evidenceGapStatusLabel(gap.status) }}</span></div>
                <dl class="m-0 mt-2 grid gap-2 text-[11px] leading-5"><div><dt class="font-bold text-[var(--agent-text-muted)]">需要的证据</dt><dd class="m-0 text-[var(--agent-text)]">{{ gap.requiredEvidence }}</dd></div><div><dt class="font-bold text-[var(--agent-text-muted)]">建议检索词</dt><dd class="m-0 break-words font-mono text-[10px] text-[var(--agent-text)]">{{ gap.suggestedQuery }}</dd></div></dl>
              </div>
            </div>

            <details v-if="review.limitations.length" class="mt-3 border-t border-[var(--agent-border)] pt-2.5"><summary class="cursor-pointer text-xs font-semibold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">查看审查限制（{{ review.limitations.length }}）</summary><ul class="mb-0 mt-2 grid gap-1 pl-4 text-xs leading-5 text-[var(--agent-text-muted)]"><li v-for="limitation in review.limitations" :key="limitation">{{ limitation }}</li></ul></details>
          </article>
          <p v-if="!detail?.reviews.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm leading-6 text-[var(--agent-text-muted)]">步骤完成后，Reviewer 会在这里展示证据充分性、缺口和补检索状态。</p>
        </div>

      </template>

      <template #evidence>
        <div class="grid gap-3">
          <div v-if="detail?.claims.length || detail?.evidence.length || detail?.sources.length" class="grid grid-cols-2 gap-2">
            <div class="rounded-lg border border-border bg-card p-3"><span class="text-[10px] font-medium text-muted-foreground">结构化结论</span><div class="mt-1 flex items-end justify-between gap-2"><strong class="font-mono text-lg">{{ detail.claims.length }}</strong><span class="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">{{ supportedClaimCount }} 条已有支持</span></div></div>
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">直接证据覆盖</span><div class="mt-1 flex items-end justify-between gap-2"><strong class="font-mono text-lg">{{ claimCoverage }}%</strong><span class="text-[10px] text-[var(--agent-text-muted)]">{{ detail.claimEvidence.length }} 条关联</span></div><div class="mt-2 h-1 overflow-hidden rounded-full bg-[var(--agent-primary-soft)]"><div class="h-full rounded-full bg-emerald-500" :style="{ width: `${claimCoverage}%` }" /></div></div>
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">证据片段</span><strong class="mt-1 block font-mono text-lg">{{ detail.evidence.length }}</strong></div>
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">原始来源</span><strong class="mt-1 block font-mono text-lg">{{ detail.sources.length }}</strong></div>
          </div>

          <div v-if="detail?.claims.length" class="grid gap-2.5">
            <details v-for="claim in detail.claims" :key="claim.id" class="group overflow-hidden rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)]">
              <summary class="cursor-pointer list-none p-3.5 hover:bg-[var(--agent-surface-muted)]">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0"><span class="font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">{{ claimStepContext(claim) }} · {{ shortId(claim.id) }}</span><strong class="mt-1.5 block text-[13px] leading-5 text-[var(--agent-text)]">{{ claim.text }}</strong></div>
                  <span class="shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-bold" :class="claimStatusClass(claim.status)">{{ claimStatusLabel(claim.status) }}</span>
                </div>
                <div class="mt-3 flex items-center justify-between gap-3 text-[10px] text-[var(--agent-text-muted)]"><span>{{ claimLinks(claim.id).length }} 条证据关联</span><span class="font-mono">置信度 {{ formatConfidence(claim.confidence) }} · <span class="group-open:hidden">展开</span><span class="hidden group-open:inline">收起</span></span></div>
              </summary>

              <div class="grid gap-2.5 border-t border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-3">
                <article v-for="item in claimLinks(claim.id)" :key="`${item.link.claimId}-${item.link.evidenceId}`" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0"><span class="block text-[10px] font-bold text-[var(--agent-text-muted)]">{{ item.source?.title ?? '未知来源' }}</span><span v-if="item.source?.uri" class="mt-0.5 block truncate font-mono text-[9px] text-[var(--agent-text-muted)]">{{ item.source.uri }}</span></div>
                    <span class="shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-bold" :class="relationClass(item.link.relation)">{{ relationLabel(item.link.relation) }}</span>
                  </div>
                  <p v-if="item.evidence.context" class="m-0 mt-2 text-[10px] font-bold text-[var(--agent-text-muted)]">{{ item.evidence.context }}</p>
                  <blockquote class="m-0 mt-2 border-l-2 border-border pl-3 text-xs leading-5 text-foreground">{{ item.evidence.content }}</blockquote>
                  <div class="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] text-[var(--agent-text-muted)]"><span v-if="formatEvidenceLocator(item.evidence.locator)">{{ formatEvidenceLocator(item.evidence.locator) }}</span><span v-if="item.evidence.relevanceScore !== undefined">相关度 {{ formatConfidence(item.evidence.relevanceScore) }}</span><span>{{ shortId(item.evidence.id) }}</span></div>
                  <p v-if="item.link.rationale" class="m-0 mt-2 rounded-sm bg-[var(--agent-surface-muted)] px-2.5 py-2 text-[11px] leading-4 text-[var(--agent-text-muted)]"><strong class="text-[var(--agent-text)]">关联说明：</strong>{{ item.link.rationale }}</p>
                </article>
                <p v-if="!claimLinks(claim.id).length" class="m-0 rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 px-3 py-3 text-xs leading-5 text-amber-700 dark:text-amber-300">该结论尚未关联 Evidence，不能作为已验证事实使用。</p>
              </div>
            </details>
          </div>

          <details v-if="unlinkedEvidence.length" class="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3.5"><summary class="cursor-pointer text-xs font-semibold text-amber-700 dark:text-amber-300">未关联证据（{{ unlinkedEvidence.length }}）</summary><div class="mt-3 grid gap-2"><article v-for="item in unlinkedEvidence" :key="item.id" class="rounded-lg border border-amber-500/20 bg-card p-3"><p class="m-0 line-clamp-4 text-xs leading-5 text-foreground">{{ item.content }}</p><span class="mt-2 block font-mono text-[9px] text-muted-foreground">{{ item.evidenceKey }}</span></article></div></details>

          <details v-if="detail?.sources.length" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><summary class="cursor-pointer text-xs font-bold text-[var(--agent-text)]">来源目录（{{ detail.sources.length }}）</summary><div class="mt-3 grid gap-2"><article v-for="source in detail.sources" :key="source.id" class="rounded-md bg-[var(--agent-surface-muted)] p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><strong class="block text-xs leading-5 text-[var(--agent-text)]">{{ source.title }}</strong><span v-if="source.uri" class="mt-0.5 block truncate font-mono text-[9px] text-[var(--agent-text-muted)]">{{ source.uri }}</span></div><span class="shrink-0 rounded-sm border border-[var(--agent-border)] bg-[var(--agent-surface)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--agent-text-muted)]">{{ sourceTypeLabel(source.type) }}</span></div><div class="mt-2 flex items-center justify-between font-mono text-[9px] text-[var(--agent-text-muted)]"><span>{{ sourceEvidenceCount(source.id) }} 条证据</span><span>{{ shortId(source.id) }}</span></div></article></div></details>

          <p v-if="!detail?.claims.length && !detail?.evidence.length && !detail?.sources.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm leading-6 text-[var(--agent-text-muted)]">步骤完成后，Executor 会把工具结果整理为 Source、Evidence、Claim 和引用关系。</p>
        </div>

      </template>

      <template #tools>
        <div class="grid gap-3">
          <article v-for="execution in [...(detail?.toolExecutions ?? [])].reverse()" :key="execution.id" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0"><span class="flex items-center gap-2 text-sm font-bold text-[var(--agent-text)]"><PhWrench :size="15" class="shrink-0" />{{ toolDisplayName(execution.toolName) }}</span><span class="mt-1 block font-mono text-[10px] text-[var(--agent-text-muted)]">{{ execution.toolName }}</span></div>
              <span class="shrink-0 border px-2 py-0.5 font-mono text-[10px] font-bold uppercase" :class="statusClass(execution.status)">{{ toolStatusLabel(execution.status) }}</span>
            </div>
            <p class="m-0 mt-3 line-clamp-2 text-xs font-medium leading-5 text-[var(--agent-text-muted)]">{{ toolStepContext(execution) }}</p>
            <div class="mt-2.5 rounded-md bg-[var(--agent-surface-muted)] px-3 py-2.5">
              <span class="block text-[10px] font-bold text-[var(--agent-text-muted)]">{{ execution.toolName.includes('search') ? '检索内容' : '调用内容' }}</span>
              <p class="m-0 mt-1 break-words text-[13px] font-semibold leading-5 text-[var(--agent-text)]">{{ toolInputSummary(execution) }}</p>
            </div>
            <div class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--agent-text-muted)]">
              <span v-if="toolResultItems(execution).length">返回 {{ toolResultItems(execution).length }} 条结果</span>
              <span>耗时 {{ toolDuration(execution) }}</span>
              <span>{{ formatTime(execution.startedAt) }}</span>
            </div>
            <details class="mt-3 border-t border-[var(--agent-border)] pt-2.5">
              <summary class="cursor-pointer text-xs font-semibold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">查看完整记录</summary>
              <div class="mt-3 grid gap-3">
                <section v-if="toolResultItems(execution).length"><p class="m-0 mb-2 text-xs font-bold text-[var(--agent-text)]">命中来源</p><ol class="m-0 grid list-none gap-2 p-0"><li v-for="(item, index) in toolResultItems(execution)" :key="`${item.file}-${item.heading}-${index}`" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-3 py-2"><div class="flex items-start justify-between gap-2"><strong class="min-w-0 text-xs leading-5 text-[var(--agent-text)]">{{ item.title }}</strong><span v-if="item.score !== undefined" class="shrink-0 font-mono text-[10px] text-[var(--agent-text-muted)]">{{ item.score.toFixed(3) }}</span></div><p v-if="item.heading" class="m-0 mt-0.5 text-[11px] leading-4 text-[var(--agent-text-muted)]">{{ item.heading }}</p></li></ol></section>
                <section><p class="m-0 mb-1.5 text-xs font-bold text-[var(--agent-text)]">调用参数</p><pre class="m-0 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--agent-surface-muted)] p-3 font-mono text-[11px] leading-5 text-[var(--agent-text)]">{{ formatJson(execution.arguments) }}</pre></section>
                <section v-if="execution.error"><p class="m-0 mb-1.5 text-xs font-bold text-[var(--agent-error-text)]">错误信息</p><pre class="m-0 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--agent-error-bg)] p-3 font-mono text-[11px] leading-5 text-[var(--agent-error-text)]">{{ execution.error }}</pre></section>
                <details v-else-if="execution.result !== undefined" class="rounded-md border border-[var(--agent-border)] p-3"><summary class="cursor-pointer text-xs font-bold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">查看原始返回数据</summary><pre class="m-0 mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--agent-surface-muted)] p-3 font-mono text-[11px] leading-5 text-[var(--agent-text)]">{{ formatJson(execution.result) }}</pre></details>
                <details class="rounded-md border border-[var(--agent-border)] p-3"><summary class="cursor-pointer text-xs font-bold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">执行标识</summary><p class="m-0 mt-2 break-all font-mono text-[10px] leading-5 text-[var(--agent-text-muted)]">{{ execution.executionKey }}</p></details>
              </div>
            </details>
          </article>
          <p v-if="!detail?.toolExecutions.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm text-[var(--agent-text-muted)]">工具执行后会显示在这里。</p>
        </div>

      </template>

      <template #checkpoint>
        <div class="grid gap-3">
          <div v-if="detail?.latestCheckpoint" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-4"><div class="flex items-center justify-between gap-3"><span class="text-sm font-bold text-[var(--agent-text)]">当前检查点</span><strong class="font-mono text-xl">v{{ detail.latestCheckpoint.version }}</strong></div><p class="m-0 mt-2 text-xs text-[var(--agent-text-muted)]">保存于 {{ formatDateTime(detail.latestCheckpoint.createdAt) }}</p></div>
          <div class="grid grid-cols-2 gap-3"><div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><span class="text-xs text-[var(--agent-text-muted)]">最大步骤数</span><strong class="mt-1 block font-mono text-xl">{{ activeTask?.maxSteps ?? '—' }}</strong></div><div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><span class="text-xs text-[var(--agent-text-muted)]">Token 上限</span><strong class="mt-1 block font-mono text-xl">{{ activeTask?.maxTokens ?? '—' }}</strong></div></div>
          <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><p class="m-0 text-xs font-bold text-[var(--agent-text)]">允许使用的工具</p><div class="mt-2.5 flex flex-wrap gap-1.5"><span v-for="tool in activeTask?.toolPolicy.mode === 'selected' ? activeTask.toolPolicy.names : []" :key="tool" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1 font-mono text-[11px] text-[var(--agent-text)]">{{ tool }}</span><span v-if="activeTask?.toolPolicy.mode === 'all'" class="text-xs leading-5 text-[var(--agent-text-muted)]">允许使用全部已注册工具</span><span v-if="activeTask?.toolPolicy.mode === 'none'" class="text-xs leading-5 text-[var(--agent-text-muted)]">不允许使用工具</span></div></div>
          <details v-if="detail?.latestCheckpoint" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><summary class="cursor-pointer text-xs font-bold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">查看原始状态</summary><pre class="m-0 mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--agent-surface-muted)] p-3 font-mono text-[11px] leading-5 text-[var(--agent-text)]">{{ formatJson(detail.latestCheckpoint.state) }}</pre></details>
        </div>
      </template>
    </TaskInspector>

    <Dialog v-model:open="mobileTasksOpen">
      <DialogContent :show-close-button="false" class="h-[min(88dvh,720px)] max-w-[calc(100%-1rem)] overflow-hidden p-0 sm:max-w-md md:hidden">
        <DialogHeader class="sr-only">
          <DialogTitle>Agent 任务列表</DialogTitle>
          <DialogDescription>选择已有任务或创建新任务。</DialogDescription>
        </DialogHeader>
        <TaskHistorySidebar
          mobile
          :tasks="tasks"
          :active-task-id="activeTaskId"
          :running-task-id="runningTaskId"
          :compact="false"
          :actions-disabled="Boolean(busyAction)"
          :selection-disabled="Boolean(busyAction && busyAction !== 'run')"
          @create="mobileTasksOpen = false; openCreate()"
          @select="mobileTasksOpen = false; selectTask($event)"
          @delete="mobileTasksOpen = false; requestTaskDelete($event)"
          @toggle="mobileTasksOpen = false"
        />
      </DialogContent>
    </Dialog>

    <Dialog :open="Boolean(deleteTarget)" @update:open="deleteTarget = $event ? deleteTarget : undefined">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <div class="mb-1 flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
            <PhTrash :size="19" weight="bold" aria-hidden="true" />
          </div>
          <DialogTitle>删除 Agent 任务</DialogTitle>
          <DialogDescription class="space-y-2">
            <span class="block break-words font-medium text-foreground">“{{ deleteTargetSummary }}”</span>
            <span class="block">任务及其计划、审查、证据缺口、事件、工具记录和最终报告将被永久删除，此操作无法撤销。</span>
          </DialogDescription>
        </DialogHeader>
        <p v-if="error" class="m-0 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" role="alert">{{ error }}</p>
        <DialogFooter>
          <Button variant="outline" :disabled="busyAction === 'delete'" @click="deleteTarget = undefined">取消</Button>
          <Button variant="destructive" :disabled="busyAction === 'delete'" @click="confirmTaskDelete">
            <PhCircleNotch v-if="busyAction === 'delete'" class="animate-spin" :size="15" aria-hidden="true" />
            <PhTrash v-else :size="15" weight="bold" aria-hidden="true" />
            {{ busyAction === 'delete' ? '正在删除' : '确认删除' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

<style scoped>
summary::-webkit-details-marker {
  display: none;
}
</style>
