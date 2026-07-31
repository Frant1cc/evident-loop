<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  PhArrowClockwise,
  PhCaretDoubleLeft,
  PhCaretDoubleRight,
  PhCheck,
  PhCircleNotch,
  PhClockCounterClockwise,
  PhFileText,
  PhLightning,
  PhListChecks,
  PhMagnifyingGlass,
  PhPlay,
  PhPlus,
  PhShieldCheck,
  PhStack,
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
  runAgentTask
} from '../api/tasks';
import type {
  AgentEvent,
  AgentClaim,
  AgentPlanStep,
  AgentReview,
  AgentTask,
  AgentTaskDetail,
  AgentTaskStatus,
  ToolExecution
} from '../types/tasks';
import { listResearchTools } from '../api/research';
import MarkdownMessage from '../components/chat/MarkdownMessage.vue';
import PanelResizeHandle from '../components/common/PanelResizeHandle.vue';
import { useCollapsiblePanel, useResizablePanel, type PanelWidthBounds } from '../composables/useResizablePanel';

type InspectorTab = 'events' | 'reviews' | 'evidence' | 'tools' | 'checkpoint';

const sidebarBounds: PanelWidthBounds = { defaultWidth: 252, min: 180, max: 460 };
const inspectorBounds: PanelWidthBounds = { defaultWidth: 400, min: 300, max: 760 };
const sidebarWidth = useResizablePanel('tasks:sidebar-width', sidebarBounds);
const inspectorWidth = useResizablePanel('tasks:inspector-width', inspectorBounds);
const sidebarCollapsed = useCollapsiblePanel('tasks:sidebar-collapsed');
const inspectorCollapsed = useCollapsiblePanel('tasks:inspector-collapsed');
const sidebarTrack = computed(() => (sidebarCollapsed.value ? '48px' : `${sidebarWidth.value}px`));
const inspectorTrack = computed(() => (inspectorCollapsed.value ? '48px' : `${inspectorWidth.value}px`));

const tasks = ref<AgentTask[]>([]);
const activeTaskId = ref<string>();
const detail = ref<AgentTaskDetail>();
const events = ref<AgentEvent[]>([]);
const inspectorTab = ref<InspectorTab>('events');
const creating = ref(false);
const initialLoading = ref(true);
const busyAction = ref<'create' | 'plan' | 'approve' | 'run' | 'retry' | 'finalize' | 'delete'>();
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
const selectedTools = ref(['search_knowledge', 'search_docs', 'read_document', 'web_search', 'fetch_page']);
let pollTimer: ReturnType<typeof window.setInterval> | undefined;
let runController: AbortController | undefined;

// Fallback list; replaced on mount by the live registry so new tools show up automatically.
const availableTools = ref<Array<{ name: string; label: string }>>([
  { name: 'search_knowledge', label: '知识库检索' },
  { name: 'search_docs', label: '文档关键词搜索' },
  { name: 'read_document', label: '文档全文阅读' },
  { name: 'web_search', label: '联网搜索' },
  { name: 'fetch_page', label: '网页阅读' }
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

onMounted(async () => {
  try {
    await Promise.all([loadTasks(), loadAvailableTools()]);
    if (tasks.value[0]) await selectTask(tasks.value[0].id);
    else creating.value = true;
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    initialLoading.value = false;
  }
});

onBeforeUnmount(() => {
  stopPolling();
  runController?.abort();
});

async function loadTasks() {
  const data = await listAgentTasks();
  tasks.value = data.tasks;
}

async function selectTask(id: string) {
  if (busyAction.value || id === activeTaskId.value) return;
  error.value = '';
  creating.value = false;
  activeTaskId.value = id;
  const [taskDetail, taskEvents] = await Promise.all([getAgentTask(id), getAgentTaskEvents(id)]);
  applyDetail(taskDetail);
  events.value = taskEvents.events;
}

function openCreate() {
  if (busyAction.value) return;
  creating.value = true;
  activeTaskId.value = undefined;
  detail.value = undefined;
  events.value = [];
  error.value = '';
}

function requestTaskDelete(task: AgentTask) {
  if (busyAction.value || task.status === 'planning' || task.status === 'running') return;
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
      allowedTools: selectedTools.value
    });
    applyDetail(created);
    activeTaskId.value = created.task.id;
    creating.value = false;
    goal.value = '';
    await refreshEvents();
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    busyAction.value = undefined;
  }
}

async function generatePlan() {
  if (!activeTaskId.value || busyAction.value) return;
  busyAction.value = 'plan';
  error.value = '';
  try {
    applyDetail(await planAgentTask(activeTaskId.value));
    inspectorTab.value = 'events';
    await refreshEvents();
  } catch (err) {
    error.value = getErrorMessage(err);
    await refreshActive();
  } finally {
    busyAction.value = undefined;
  }
}

async function approveAndRun() {
  if (!activeTaskId.value || busyAction.value) return;
  busyAction.value = 'approve';
  error.value = '';
  try {
    applyDetail(await approveAgentTask(activeTaskId.value));
    await refreshEvents();
  } catch (err) {
    error.value = getErrorMessage(err);
    busyAction.value = undefined;
    return;
  }
  busyAction.value = undefined;
  await executeTask();
}

async function executeTask() {
  const id = activeTaskId.value;
  if (!id || busyAction.value) return;
  busyAction.value = 'run';
  error.value = '';
  runController = new AbortController();
  startPolling(id);
  try {
    applyDetail(await runAgentTask(id, runController.signal));
    await refreshEvents();
  } catch (err) {
    if ((err as Error).name !== 'AbortError') error.value = getErrorMessage(err);
    await refreshActive();
  } finally {
    stopPolling();
    runController = undefined;
    busyAction.value = undefined;
    await loadTasks().catch(() => undefined);
  }
}

async function retryStep(step: AgentPlanStep) {
  const id = activeTaskId.value;
  if (!id || busyAction.value) return;
  busyAction.value = 'retry';
  error.value = '';
  try {
    applyDetail(await retryAgentTaskStep(id, step.id));
    await refreshEvents();
  } catch (err) {
    error.value = getErrorMessage(err);
    busyAction.value = undefined;
    return;
  }
  busyAction.value = undefined;
  await executeTask();
}

async function generateFinalReport() {
  const id = activeTaskId.value;
  if (!id || busyAction.value) return;
  busyAction.value = 'finalize';
  error.value = '';
  try {
    applyDetail(await finalizeAgentTask(id));
    await refreshEvents();
  } catch (err) {
    error.value = getErrorMessage(err);
    await refreshActive().catch(() => undefined);
  } finally {
    busyAction.value = undefined;
  }
}

function startPolling(taskId: string) {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    if (activeTaskId.value !== taskId) return;
    try {
      const [taskDetail, taskEvents] = await Promise.all([getAgentTask(taskId), getAgentTaskEvents(taskId)]);
      applyDetail(taskDetail);
      events.value = taskEvents.events;
    } catch {
      // The blocking run request remains authoritative; a later poll can recover.
    }
  }, 900);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = undefined;
}

async function refreshActive() {
  if (!activeTaskId.value) return;
  const [taskDetail, taskEvents] = await Promise.all([
    getAgentTask(activeTaskId.value),
    getAgentTaskEvents(activeTaskId.value)
  ]);
  applyDetail(taskDetail);
  events.value = taskEvents.events;
}

async function refreshEvents() {
  if (!activeTaskId.value) return;
  events.value = (await getAgentTaskEvents(activeTaskId.value)).events;
}

function applyDetail(next: AgentTaskDetail) {
  detail.value = next;
  const index = tasks.value.findIndex((task) => task.id === next.task.id);
  if (index === -1) tasks.value.unshift(next.task);
  else tasks.value[index] = next.task;
}

function toggleTool(name: string) {
  selectedTools.value = selectedTools.value.includes(name)
    ? selectedTools.value.filter((tool) => tool !== name)
    : [...selectedTools.value, name];
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
  if (status === 'supported') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'unsupported') return 'border-red-200 bg-red-50 text-red-700';
  if (status === 'conflicted') return 'border-orange-200 bg-orange-50 text-orange-800';
  return 'border-amber-200 bg-amber-50 text-amber-800';
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
  if (relation === 'supports') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (relation === 'contradicts') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-sky-200 bg-sky-50 text-sky-700';
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
  if (typeof value.line === 'number') parts.push(`第 ${value.line} 行`);
  if (typeof value.startLine === 'number') {
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
  if (status === 'resolved') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'unresolved') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-amber-200 bg-amber-50 text-amber-800';
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

function toolDuration(execution: ToolExecution) {
  if (!execution.completedAt) return '执行中';
  const duration = new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime();
  if (duration < 1000) return `${Math.max(duration, 0)} ms`;
  return `${(duration / 1000).toFixed(1)} s`;
}

function toRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function eventLabel(type: string) {
  const labels: Record<string, string> = {
    task_created: '任务已创建',
    task_status_changed: '任务状态变更',
    plan_created: '计划已生成',
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
  if (status === 'failed' || status === 'cancelled') return 'border-red-200 bg-red-50 text-red-700';
  if (status === 'running' || status === 'planning') return 'border-amber-300 bg-amber-50 text-amber-800';
  if (status === 'completed') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'awaiting_approval') return 'border-sky-200 bg-sky-50 text-sky-700';
  return 'border-[var(--agent-border)] bg-[var(--agent-surface-muted)] text-[var(--agent-text-muted)]';
}

function eventTone(type: string) {
  if (type.includes('failed')) return 'bg-red-500';
  if (type.includes('completed') || type.includes('resolved')) return 'bg-emerald-500';
  if (type.includes('gap') || type.includes('supplemental')) return 'bg-amber-500';
  if (type.includes('started') || type.includes('created')) return 'bg-amber-500';
  return 'bg-neutral-300';
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

    <aside v-if="sidebarCollapsed" class="grid min-h-0 min-w-0 content-start justify-items-center gap-2 border-r border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-2 max-md:hidden">
      <button type="button" class="grid h-8 w-8 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)] hover:text-[var(--agent-text)]" aria-label="展开任务列表" title="展开任务列表" @click="sidebarCollapsed = false">
        <PhCaretDoubleRight :size="17" />
      </button>
      <button type="button" class="grid h-8 w-8 place-items-center rounded-md bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)] hover:bg-[var(--agent-surface)] disabled:opacity-50" :disabled="Boolean(busyAction)" aria-label="新建任务" title="新建任务" @click="openCreate">
        <PhPlus :size="17" weight="bold" />
      </button>
      <span class="mt-1 rounded-full bg-[var(--agent-surface)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--agent-text-muted)]" :title="`${tasks.length} 个任务`">{{ tasks.length }}</span>
    </aside>

    <aside v-else class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-r border-[var(--agent-border)] bg-[var(--agent-surface-muted)] max-md:hidden">
      <header class="border-b border-[var(--agent-border)] p-3">
        <button type="button" class="inline-flex h-8 w-full items-center justify-center gap-2 rounded-md bg-[var(--agent-selected-bg)] px-3 text-sm font-bold text-[var(--agent-selected-text)] hover:bg-[var(--agent-surface)] disabled:opacity-50" :disabled="Boolean(busyAction)" @click="openCreate">
          <PhPlus :size="16" weight="bold" /> 新建任务
        </button>
        <div class="mt-4 flex items-center justify-between gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--agent-text-muted)]">
          <span class="truncate">任务列表</span>
          <span class="flex shrink-0 items-center gap-1">
            <span>{{ tasks.length }}</span>
            <button type="button" class="grid h-6 w-6 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)] hover:text-[var(--agent-text)]" aria-label="收起任务列表" title="收起任务列表" @click="sidebarCollapsed = true">
              <PhCaretDoubleLeft :size="14" />
            </button>
          </span>
        </div>
      </header>
      <div class="chat-session-scroll overflow-auto p-2">
        <div v-for="task in tasks" :key="task.id" class="group relative mb-1 rounded-md border border-transparent transition-colors" :class="task.id === activeTaskId ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)] hover:text-[var(--agent-text)]'">
          <button type="button" class="grid w-full gap-2 px-2.5 py-2.5 pr-9 text-left" :disabled="Boolean(busyAction)" @click="selectTask(task.id)">
            <span class="line-clamp-2 text-[13px] font-bold leading-5 text-[var(--agent-text)]">{{ task.goal }}</span>
            <span class="flex items-center justify-between gap-2">
              <span class="border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em]" :class="statusClass(task.status)">{{ statusLabel(task.status) }}</span>
              <span class="font-mono text-[9px] text-[var(--agent-text-muted)]">{{ shortId(task.id) }}</span>
            </span>
          </button>
          <button type="button" class="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-md text-[var(--agent-text-muted)] opacity-0 transition-opacity hover:bg-[var(--agent-error-bg)] hover:text-[var(--agent-error-text)] focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30" :disabled="Boolean(busyAction) || task.status === 'planning' || task.status === 'running'" :aria-label="`删除任务：${task.goal}`" :title="task.status === 'planning' || task.status === 'running' ? '任务执行期间不能删除' : '删除任务'" @click="requestTaskDelete(task)"><PhTrash :size="15" weight="bold" /></button>
        </div>
        <p v-if="!tasks.length && !initialLoading" class="m-0 px-3 py-6 text-center text-xs leading-5 text-[var(--agent-text-muted)]">还没有持久化任务。<br>创建第一个 Agent Run。</p>
      </div>
    </aside>

    <main class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-[var(--agent-surface)]">
      <header v-if="activeTask" class="flex items-center gap-3 border-b border-[var(--agent-border)] px-6 py-3 max-md:px-4">
        <button type="button" class="hidden size-8 shrink-0 items-center justify-center rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] hover:bg-[var(--agent-surface-muted)] max-md:flex" :disabled="Boolean(busyAction)" aria-label="创建新任务" @click="openCreate"><PhPlus :size="16" weight="bold" /></button>
        <div v-if="detail?.steps.length" class="flex min-w-0 flex-1 items-center gap-3">
          <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--agent-primary-soft)]"><div class="h-full rounded-full bg-[var(--agent-primary)] transition-all duration-500" :style="{ width: `${progress}%` }" /></div>
          <span class="shrink-0 font-mono text-[10px] font-bold text-[var(--agent-text-muted)]">{{ completedStepCount }}/{{ detail.steps.length }} · {{ progress }}%</span>
        </div>
        <div v-else class="min-w-0 flex-1" />
        <span class="shrink-0 border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]" :class="statusClass(activeTask.status)">{{ statusLabel(activeTask.status) }}</span>
        <span class="shrink-0 font-mono text-[10px] text-[var(--agent-text-muted)]">检查点 v{{ activeTask.checkpointVersion }}</span>
      </header>

      <div class="row-start-2 min-h-0 overflow-auto">
        <div v-if="initialLoading" class="grid h-full place-items-center text-sm font-semibold text-[var(--agent-text-muted)]"><span class="flex items-center gap-2"><PhCircleNotch class="animate-spin" :size="18" /> 正在加载运行时</span></div>

        <form v-else-if="creating" class="mx-auto grid max-w-3xl gap-7 px-8 py-10 max-md:px-4" @submit.prevent="submitTask">
          <div>
            <label for="task-goal" class="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--agent-text-muted)]">研究目标</label>
            <textarea id="task-goal" v-model="goal" rows="5" class="mt-2 w-full resize-y rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-4 text-base font-semibold leading-7 text-[var(--agent-text)] outline-none placeholder:font-normal placeholder:text-[var(--agent-text-muted)] focus:border-[var(--agent-selected-border)] focus:ring-4 focus:ring-[var(--agent-focus-ring)]" placeholder="例如：比较两种 Agent 工作流方案，并基于知识库证据给出选型建议。" autofocus />
          </div>

          <div class="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <label class="grid gap-2 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-4">
              <span class="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--agent-text-muted)]">最大步骤数</span>
              <input v-model.number="maxSteps" type="number" min="1" max="12" class="h-10 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 font-mono text-lg font-bold outline-none focus:border-[var(--agent-selected-border)] focus:ring-4 focus:ring-[var(--agent-focus-ring)]" />
            </label>
            <label class="grid gap-2 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-4">
              <span class="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--agent-text-muted)]">Token 预算</span>
              <input v-model.number="maxTokens" type="number" min="1000" step="1000" class="h-10 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 font-mono text-lg font-bold outline-none focus:border-[var(--agent-selected-border)] focus:ring-4 focus:ring-[var(--agent-focus-ring)]" />
            </label>
          </div>

          <fieldset class="m-0 border-0 p-0">
            <legend class="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--agent-text-muted)]">允许使用的工具</legend>
            <div class="mt-2 grid grid-cols-2 gap-2 max-sm:grid-cols-1">
              <button v-for="tool in availableTools" :key="tool.name" type="button" class="flex items-center justify-between rounded-md border px-3 py-3 text-left text-sm font-semibold transition-colors" :class="selectedTools.includes(tool.name) ? 'border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'border-[var(--agent-border)] bg-[var(--agent-surface)] text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]'" @click="toggleTool(tool.name)">
                <span>{{ tool.label }}</span><PhCheck v-if="selectedTools.includes(tool.name)" :size="15" weight="bold" />
              </button>
            </div>
          </fieldset>

          <p v-if="error" class="m-0 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{{ error }}</p>
          <button type="submit" class="flex h-11 items-center justify-center gap-2 rounded-md bg-[var(--agent-primary)] px-5 text-sm font-bold text-[var(--agent-primary-text)] hover:bg-[var(--agent-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50" :disabled="!goal.trim() || busyAction === 'create'">
            <PhCircleNotch v-if="busyAction === 'create'" class="animate-spin" :size="17" />
            <PhPlus v-else :size="17" weight="bold" />
            {{ busyAction === 'create' ? '正在创建任务' : '创建持久化任务' }}
          </button>
        </form>

        <div v-else-if="detail" class="mx-auto grid max-w-4xl gap-6 px-6 py-7 max-md:px-4">
          <section class="grid grid-cols-[1fr_auto] items-center gap-5 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-4 max-sm:grid-cols-1">
            <div class="grid grid-cols-3 gap-5 max-sm:grid-cols-3">
              <div><span class="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--agent-text-muted)]">计划步骤</span><strong class="mt-1 block font-mono text-xl">{{ detail.steps.length }}</strong></div>
              <div><span class="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--agent-text-muted)]">工具执行</span><strong class="mt-1 block font-mono text-xl">{{ detail.toolExecutions.length }}</strong></div>
              <div><span class="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--agent-text-muted)]">运行事件</span><strong class="mt-1 block font-mono text-xl">{{ events.length }}</strong></div>
            </div>

            <button v-if="activeTask?.status === 'created'" type="button" class="flex h-10 items-center justify-center gap-2 rounded-md bg-[var(--agent-primary)] px-4 text-sm font-bold text-[var(--agent-primary-text)] hover:bg-[var(--agent-primary-hover)] disabled:opacity-50" :disabled="Boolean(busyAction)" @click="generatePlan"><PhCircleNotch v-if="busyAction === 'plan'" class="animate-spin" :size="16" /><PhListChecks v-else :size="16" weight="bold" />{{ busyAction === 'plan' ? '正在生成计划' : '生成计划' }}</button>
            <button v-else-if="activeTask?.status === 'awaiting_approval'" type="button" class="flex h-10 items-center justify-center gap-2 rounded-md bg-[var(--agent-primary)] px-4 text-sm font-bold text-[var(--agent-primary-text)] hover:bg-[var(--agent-primary-hover)] disabled:opacity-50" :disabled="Boolean(busyAction)" @click="approveAndRun"><PhShieldCheck :size="17" weight="bold" />批准并执行</button>
            <button v-else-if="activeTask?.status === 'running'" type="button" class="flex h-10 items-center justify-center gap-2 rounded-md bg-[var(--agent-primary)] px-4 text-sm font-bold text-[var(--agent-primary-text)] hover:bg-[var(--agent-primary-hover)] disabled:opacity-50" :disabled="Boolean(busyAction)" @click="executeTask"><PhCircleNotch v-if="busyAction === 'run'" class="animate-spin" :size="16" /><PhPlay v-else :size="16" weight="fill" />{{ busyAction === 'run' ? '正在执行' : '继续执行' }}</button>
            <div v-else class="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--agent-text-muted)]"><PhCheck v-if="activeTask?.status === 'completed'" :size="16" weight="bold" /><PhClockCounterClockwise v-else :size="16" />{{ statusLabel(activeTask!.status) }}</div>
          </section>

          <p v-if="error" class="m-0 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{{ error }}</p>

          <section v-if="finalArtifact" class="overflow-hidden rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)]">
            <header class="flex items-start justify-between gap-5 border-b border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-5 py-4">
              <div>
                <p class="m-0 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-800"><PhFileText :size="15" weight="bold" /> 最终任务结果</p>
                <h2 class="m-0 mt-1 text-xl font-bold leading-7 tracking-[-0.025em]">{{ finalArtifact.title }}</h2>
              </div>
              <div class="shrink-0 text-right font-mono text-[9px] leading-5 text-[var(--agent-text-muted)]"><span class="block border border-emerald-200 bg-emerald-50 px-2 text-emerald-700">已完成</span><span class="mt-1 block">{{ formatTime(finalArtifact.updatedAt) }}</span></div>
            </header>
            <article class="px-6 py-6 max-md:px-4"><MarkdownMessage :content="finalArtifact.content" /></article>
          </section>

          <section v-else-if="allStepsCompleted && (activeTask?.status === 'completed' || activeTask?.status === 'failed')" class="grid justify-items-center gap-3 rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-5 py-8 text-center">
            <PhFileText :size="26" class="text-amber-700" />
            <div><h2 class="m-0 text-base font-bold">步骤已经完成，但还没有最终报告</h2><p class="m-0 mt-1 text-sm text-[var(--agent-text-muted)]">Writer 会汇总全部步骤输出，不会重新执行检索工具。</p></div>
            <button type="button" class="flex h-9 items-center gap-2 rounded-md bg-[var(--agent-primary)] px-4 text-xs font-bold text-[var(--agent-primary-text)] hover:bg-[var(--agent-primary-hover)] disabled:opacity-50" :disabled="Boolean(busyAction)" @click="generateFinalReport"><PhCircleNotch v-if="busyAction === 'finalize'" class="animate-spin" :size="15" /><PhFileText v-else :size="15" weight="bold" />{{ busyAction === 'finalize' ? '正在生成最终报告' : '生成最终报告' }}</button>
          </section>

          <section>
            <div class="mb-3 flex items-end justify-between gap-4">
              <div><p class="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--agent-text-muted)]">执行计划</p><h2 class="m-0 mt-1 text-lg font-bold tracking-[-0.02em]">可恢复步骤</h2></div>
              <span v-if="busyAction === 'run'" class="flex items-center gap-2 font-mono text-[10px] font-bold uppercase text-amber-700"><PhCircleNotch class="animate-spin" :size="14" /> 正在同步运行状态</span>
            </div>

            <div v-if="!detail.steps.length" class="rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-5 py-10 text-center text-sm leading-6 text-[var(--agent-text-muted)]">计划尚未生成。Planner 会把目标拆成可验证、可恢复的执行步骤。</div>
            <div v-else class="grid gap-0">
              <article v-for="(step, index) in detail.steps" :key="step.id" class="group grid grid-cols-[44px_minmax(0,1fr)]">
                <div class="grid grid-rows-[36px_minmax(0,1fr)] justify-items-center">
                  <span class="grid size-9 place-items-center rounded-md border font-mono text-xs font-bold" :class="step.status === 'completed' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : step.status === 'running' ? 'border-amber-300 bg-amber-50 text-amber-800' : step.status === 'failed' ? 'border-red-200 bg-red-50 text-red-700' : 'border-[var(--agent-border)] bg-[var(--agent-surface-muted)] text-[var(--agent-text-muted)]'">{{ String(step.sequence).padStart(2, '0') }}</span>
                  <span v-if="index < detail.steps.length - 1" class="h-full w-px bg-neutral-200" />
                </div>
                <div class="mb-4 ml-3 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-4 transition-colors group-hover:bg-[var(--agent-surface-muted)]">
                  <div class="flex items-start justify-between gap-4">
                    <div><div class="flex flex-wrap items-center gap-2"><h3 class="m-0 text-sm font-bold leading-5">{{ step.objective }}</h3><span v-if="isSupplementalStep(step.id)" class="inline-flex items-center gap-1 rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-800"><PhMagnifyingGlass :size="11" weight="bold" />补充检索</span></div><p class="m-0 mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">第 {{ step.attempts }} 次尝试 · {{ shortId(step.id) }}</p></div>
                    <span class="shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase" :class="statusClass(step.status)">{{ stepStatusLabel(step.status) }}</span>
                  </div>
                  <ul class="mb-0 mt-3 grid gap-1 border-l border-neutral-200 pl-3 text-xs leading-5 text-[var(--agent-text-muted)]"><li v-for="evidence in step.expectedEvidence" :key="evidence">{{ evidence }}</li></ul>
                  <p v-if="step.error" class="m-0 mt-3 bg-red-50 px-3 py-2 text-xs font-semibold leading-5 text-red-700">{{ step.error }}</p>
                  <details v-if="step.output !== undefined" class="mt-3 border-t border-[var(--agent-border)] pt-3"><summary class="cursor-pointer font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--agent-text-muted)]">步骤输出</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-3 font-mono text-[10px] leading-5 text-[var(--agent-text)]">{{ formatJson(step.output) }}</pre></details>
                  <button v-if="step.status === 'failed' && activeTask?.status === 'failed'" type="button" class="mt-3 flex h-8 items-center gap-2 rounded-md border border-red-200 px-3 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50" :disabled="Boolean(busyAction)" @click="retryStep(step)"><PhArrowClockwise :size="14" weight="bold" />从此步骤重试</button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </div>
    </main>

    <aside v-if="inspectorCollapsed" class="grid min-h-0 min-w-0 content-start justify-items-center gap-3 border-l border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-2 max-lg:hidden">
      <button type="button" class="grid h-8 w-8 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)] hover:text-[var(--agent-text)]" aria-label="展开运行检查器" title="展开运行检查器" @click="inspectorCollapsed = false">
        <PhCaretDoubleLeft :size="17" />
      </button>
      <PhStack :size="16" weight="bold" class="text-[var(--agent-text-muted)]" />
    </aside>

    <aside v-else class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-[var(--agent-border)] bg-[var(--agent-surface-muted)] max-lg:hidden">
      <header class="border-b border-[var(--agent-border)] px-4 py-3">
        <div class="flex items-center justify-between gap-2">
          <p class="m-0 flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--agent-text)]"><PhStack :size="16" weight="bold" class="shrink-0" /> <span class="truncate">运行检查器</span></p>
          <button type="button" class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)] hover:text-[var(--agent-text)]" aria-label="收起运行检查器" title="收起运行检查器" @click="inspectorCollapsed = true">
            <PhCaretDoubleRight :size="16" />
          </button>
        </div>
        <div class="mt-3 grid grid-cols-5 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-1">
          <button v-for="tab in [{ key: 'events', label: '事件', count: events.length }, { key: 'reviews', label: '审查', count: detail?.reviews.length ?? 0 }, { key: 'evidence', label: '证据链', count: detail?.claims.length ?? 0 }, { key: 'tools', label: '工具', count: detail?.toolExecutions.length ?? 0 }, { key: 'checkpoint', label: '状态' }]" :key="tab.key" type="button" class="flex h-8 items-center justify-center gap-1 rounded-md px-0.5 text-[10px] font-bold" :class="inspectorTab === tab.key ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]'" @click="inspectorTab = tab.key as InspectorTab">
            <span>{{ tab.label }}</span><span v-if="tab.count !== undefined" class="font-mono text-[10px] opacity-70">{{ tab.count }}</span>
          </button>
        </div>
      </header>

      <div class="chat-session-scroll min-h-0 overflow-auto p-4">
        <div v-if="inspectorTab === 'events'" class="grid gap-3">
          <article v-for="event in [...events].reverse()" :key="event.id" class="min-w-0 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5">
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2.5"><span class="size-2.5 shrink-0 rounded-full" :class="eventTone(event.type)" /><strong class="truncate text-[13px] leading-5 text-[var(--agent-text)]">{{ eventLabel(event.type) }}</strong></div>
              <span class="shrink-0 font-mono text-[10px] leading-5 text-[var(--agent-text-muted)]">#{{ event.sequence }} · {{ formatTime(event.createdAt) }}</span>
            </div>
            <p class="m-0 mt-1.5 break-words pl-5 font-mono text-[10px] leading-4 text-[var(--agent-text-muted)]">{{ event.type }}</p>
            <details class="mt-3 border-t border-[var(--agent-border)] pt-2.5">
              <summary class="cursor-pointer text-xs font-semibold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">查看事件数据</summary>
              <pre class="m-0 mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--agent-surface-muted)] p-3 font-mono text-[11px] leading-5 text-[var(--agent-text)]">{{ formatJson(event.payload) }}</pre>
            </details>
          </article>
          <p v-if="!events.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm text-[var(--agent-text-muted)]">暂无运行事件。</p>
        </div>

        <div v-else-if="inspectorTab === 'reviews'" class="grid gap-3">
          <div v-if="detail?.reviews.length" class="grid grid-cols-3 gap-2">
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">已审查步骤</span><strong class="mt-1 block font-mono text-lg">{{ detail.reviews.length }}</strong></div>
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">证据缺口</span><strong class="mt-1 block font-mono text-lg">{{ detail.evidenceGaps.length }}</strong></div>
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">仍未解决</span><strong class="mt-1 block font-mono text-lg text-red-700">{{ detail.evidenceGaps.filter((gap) => gap.status === 'unresolved').length }}</strong></div>
          </div>
          <article v-for="review in [...(detail?.reviews ?? [])].reverse()" :key="review.id" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0"><strong class="block text-[13px] leading-5 text-[var(--agent-text)]">{{ reviewStepContext(review) }}</strong><span class="mt-1 block font-mono text-[10px] text-[var(--agent-text-muted)]">{{ formatTime(review.createdAt) }}</span></div>
              <span class="shrink-0 border px-2 py-0.5 font-mono text-[10px] font-bold" :class="review.verdict === 'pass' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-800'">{{ reviewVerdictLabel(review.verdict) }}</span>
            </div>
            <p class="m-0 mt-3 text-[13px] font-medium leading-5 text-[var(--agent-text)]">{{ review.summary }}</p>

            <div v-if="review.supportedClaims.length" class="mt-3 border-l-2 border-emerald-300 pl-3"><span class="text-[10px] font-bold text-emerald-700">已有证据支持</span><ul class="mb-0 mt-1 grid gap-1 pl-4 text-xs leading-5 text-[var(--agent-text-muted)]"><li v-for="claim in review.supportedClaims" :key="claim">{{ claim }}</li></ul></div>
            <div v-if="review.unsupportedClaims.length" class="mt-3 border-l-2 border-amber-300 pl-3"><span class="text-[10px] font-bold text-amber-800">尚未充分支持</span><ul class="mb-0 mt-1 grid gap-1 pl-4 text-xs leading-5 text-[var(--agent-text-muted)]"><li v-for="claim in review.unsupportedClaims" :key="claim">{{ claim }}</li></ul></div>

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

        <div v-else-if="inspectorTab === 'evidence'" class="grid gap-3">
          <div v-if="detail?.claims.length || detail?.evidence.length || detail?.sources.length" class="grid grid-cols-2 gap-2">
            <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"><span class="text-[10px] font-bold text-[var(--agent-text-muted)]">结构化结论</span><div class="mt-1 flex items-end justify-between gap-2"><strong class="font-mono text-lg">{{ detail.claims.length }}</strong><span class="text-[10px] font-semibold text-emerald-700">{{ supportedClaimCount }} 条已有支持</span></div></div>
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
                  <blockquote class="m-0 mt-2 border-l-2 border-neutral-300 pl-3 text-xs leading-5 text-[var(--agent-text)]">{{ item.evidence.content }}</blockquote>
                  <div class="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] text-[var(--agent-text-muted)]"><span v-if="formatEvidenceLocator(item.evidence.locator)">{{ formatEvidenceLocator(item.evidence.locator) }}</span><span v-if="item.evidence.relevanceScore !== undefined">相关度 {{ formatConfidence(item.evidence.relevanceScore) }}</span><span>{{ shortId(item.evidence.id) }}</span></div>
                  <p v-if="item.link.rationale" class="m-0 mt-2 rounded-sm bg-[var(--agent-surface-muted)] px-2.5 py-2 text-[11px] leading-4 text-[var(--agent-text-muted)]"><strong class="text-[var(--agent-text)]">关联说明：</strong>{{ item.link.rationale }}</p>
                </article>
                <p v-if="!claimLinks(claim.id).length" class="m-0 rounded-md border border-dashed border-amber-300 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800">该结论尚未关联 Evidence，不能作为已验证事实使用。</p>
              </div>
            </details>
          </div>

          <details v-if="unlinkedEvidence.length" class="rounded-md border border-amber-200 bg-amber-50/60 p-3.5"><summary class="cursor-pointer text-xs font-bold text-amber-800">未关联证据（{{ unlinkedEvidence.length }}）</summary><div class="mt-3 grid gap-2"><article v-for="item in unlinkedEvidence" :key="item.id" class="rounded-md border border-amber-200 bg-[var(--agent-surface)] p-3"><p class="m-0 line-clamp-4 text-xs leading-5 text-[var(--agent-text)]">{{ item.content }}</p><span class="mt-2 block font-mono text-[9px] text-[var(--agent-text-muted)]">{{ item.evidenceKey }}</span></article></div></details>

          <details v-if="detail?.sources.length" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><summary class="cursor-pointer text-xs font-bold text-[var(--agent-text)]">来源目录（{{ detail.sources.length }}）</summary><div class="mt-3 grid gap-2"><article v-for="source in detail.sources" :key="source.id" class="rounded-md bg-[var(--agent-surface-muted)] p-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><strong class="block text-xs leading-5 text-[var(--agent-text)]">{{ source.title }}</strong><span v-if="source.uri" class="mt-0.5 block truncate font-mono text-[9px] text-[var(--agent-text-muted)]">{{ source.uri }}</span></div><span class="shrink-0 rounded-sm border border-[var(--agent-border)] bg-[var(--agent-surface)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--agent-text-muted)]">{{ sourceTypeLabel(source.type) }}</span></div><div class="mt-2 flex items-center justify-between font-mono text-[9px] text-[var(--agent-text-muted)]"><span>{{ sourceEvidenceCount(source.id) }} 条证据</span><span>{{ shortId(source.id) }}</span></div></article></div></details>

          <p v-if="!detail?.claims.length && !detail?.evidence.length && !detail?.sources.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm leading-6 text-[var(--agent-text-muted)]">步骤完成后，Executor 会把工具结果整理为 Source、Evidence、Claim 和引用关系。</p>
        </div>

        <div v-else-if="inspectorTab === 'tools'" class="grid gap-3">
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

        <div v-else class="grid gap-3">
          <div v-if="detail?.latestCheckpoint" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-4"><div class="flex items-center justify-between gap-3"><span class="text-sm font-bold text-[var(--agent-text)]">当前检查点</span><strong class="font-mono text-xl">v{{ detail.latestCheckpoint.version }}</strong></div><p class="m-0 mt-2 text-xs text-[var(--agent-text-muted)]">保存于 {{ formatDateTime(detail.latestCheckpoint.createdAt) }}</p></div>
          <div class="grid grid-cols-2 gap-3"><div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><span class="text-xs text-[var(--agent-text-muted)]">最大步骤数</span><strong class="mt-1 block font-mono text-xl">{{ activeTask?.maxSteps ?? '—' }}</strong></div><div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><span class="text-xs text-[var(--agent-text-muted)]">Token 上限</span><strong class="mt-1 block font-mono text-xl">{{ activeTask?.maxTokens ?? '—' }}</strong></div></div>
          <div class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><p class="m-0 text-xs font-bold text-[var(--agent-text)]">允许使用的工具</p><div class="mt-2.5 flex flex-wrap gap-1.5"><span v-for="tool in activeTask?.allowedTools" :key="tool" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1 font-mono text-[11px] text-[var(--agent-text)]">{{ tool }}</span><span v-if="!activeTask?.allowedTools.length" class="text-xs leading-5 text-[var(--agent-text-muted)]">允许使用全部已注册工具</span></div></div>
          <details v-if="detail?.latestCheckpoint" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><summary class="cursor-pointer text-xs font-bold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">查看原始状态</summary><pre class="m-0 mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--agent-surface-muted)] p-3 font-mono text-[11px] leading-5 text-[var(--agent-text)]">{{ formatJson(detail.latestCheckpoint.state) }}</pre></details>
        </div>
      </div>
    </aside>

    <div v-if="deleteTarget" class="fixed inset-0 z-30 grid place-items-center bg-black/20 p-5" role="dialog" aria-modal="true" aria-label="删除任务确认">
      <div class="grid w-full max-w-md gap-4 rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-5 shadow-lg">
        <div class="flex items-start gap-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]"><PhTrash :size="18" weight="bold" /></span>
          <div class="min-w-0">
            <h2 class="m-0 text-base font-bold text-[var(--agent-text)]">删除 Agent 任务</h2>
            <p class="m-0 mt-1 break-words text-sm font-semibold leading-6 text-[var(--agent-text)]">“{{ deleteTargetSummary }}”</p>
            <p class="m-0 mt-1 text-sm leading-6 text-[var(--agent-text-muted)]">该任务及其计划、审查、证据缺口、事件、工具记录和最终报告将被永久删除。</p>
          </div>
        </div>
        <p v-if="error" class="m-0 rounded-md bg-[var(--agent-error-bg)] px-3 py-2 text-sm font-semibold text-[var(--agent-error-text)]">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="inline-flex h-9 items-center rounded-md border border-[var(--agent-border)] px-3 text-sm font-semibold text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)] disabled:opacity-50" :disabled="busyAction === 'delete'" @click="deleteTarget = undefined">取消</button>
          <button type="button" class="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--agent-error-text)] px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50" :disabled="busyAction === 'delete'" @click="confirmTaskDelete"><PhCircleNotch v-if="busyAction === 'delete'" class="animate-spin" :size="15" /><PhTrash v-else :size="15" weight="bold" />{{ busyAction === 'delete' ? '正在删除' : '确认删除' }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
summary::-webkit-details-marker {
  display: none;
}
</style>
