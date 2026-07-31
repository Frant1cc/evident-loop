<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  PhArrowClockwise,
  PhArrowsLeftRight,
  PhCaretDown,
  PhCheckCircle,
  PhCircleNotch,
  PhFlask,
  PhPlay,
  PhSlidersHorizontal,
  PhTrash,
  PhTrendDown,
  PhTrendUp,
  PhWarningCircle,
  PhXCircle
} from '@phosphor-icons/vue';

import {
  createRagEvaluation,
  deleteRagEvaluation,
  getRagEvaluation,
  listRagEvaluations,
  subscribeToRagEvaluation
} from '../api/evaluations';
import type {
  RagEvaluation,
  RagEvaluationCategory,
  RagEvaluationDiff,
  RagEvaluationStatus
} from '../types/evaluations';

const evaluations = ref<RagEvaluation[]>([]);
const activeId = ref<string>();
const active = ref<RagEvaluation>();
const loading = ref(true);
const creating = ref(false);
const deleting = ref(false);
const error = ref('');
const streamWarning = ref('');
const showConfig = ref(false);
const deleteTarget = ref<RagEvaluation>();
const name = ref('');
const k = ref(3);
const recallThreshold = ref(0.9);
const mrrThreshold = ref(0.8);
const retrieval = ref<'dense' | 'hybrid'>('dense');
const queryRewrite = ref(false);
const compareId = ref('');
const compareEvaluation = ref<RagEvaluation>();
const compareLoading = ref(false);
let closeStream: (() => void) | undefined;

const progress = computed(() => {
  if (!active.value?.totalCases) return 0;
  return Math.round(active.value.completedCases / active.value.totalCases * 100);
});
const failedCases = computed(() => active.value?.report?.cases.filter((item) => (item.answerable ?? true) && !item.passed) ?? []);
const isActiveRunning = computed(() => active.value?.status === 'queued' || active.value?.status === 'running');
const comparableRuns = computed(() =>
  evaluations.value.filter((item) => item.id !== activeId.value && item.status === 'completed' && item.report)
);

const diff = computed<RagEvaluationDiff | undefined>(() => {
  const current = active.value?.report;
  const baselineRun = compareEvaluation.value;
  const baseline = baselineRun?.report;
  if (!current || !baseline || !baselineRun) return undefined;

  const currentCases = new Map(current.cases.map((item) => [item.id, item]));
  const baselineCases = new Map(baseline.cases.map((item) => [item.id, item]));
  const change = (item: { id: string; query: string; category: RagEvaluationCategory }) =>
    ({ id: item.id, query: item.query, category: item.category });

  const regressions = current.cases
    .filter((item) => (item.answerable ?? true) && !item.passed && baselineCases.get(item.id)?.passed === true)
    .map(change);
  const improvements = current.cases
    .filter((item) => (item.answerable ?? true) && item.passed && baselineCases.get(item.id)?.passed === false)
    .map(change);
  const addedCases = current.cases.filter((item) => !baselineCases.has(item.id)).map(change);
  const removedCases = baseline.cases.filter((item) => !currentCases.has(item.id)).map(change);

  return {
    baseline: { id: baselineRun.id, name: baselineRun.name, createdAt: baselineRun.createdAt },
    deltas: {
      recallAtK: current.metrics.recallAtK - baseline.metrics.recallAtK,
      mrrAtK: current.metrics.mrrAtK - baseline.metrics.mrrAtK,
      passRate: current.metrics.passRate - baseline.metrics.passRate,
      headingRecallAtK: current.metrics.headingRecallAtK !== undefined && baseline.metrics.headingRecallAtK !== undefined
        ? current.metrics.headingRecallAtK - baseline.metrics.headingRecallAtK
        : undefined,
      anchorRecallAtK: current.metrics.anchorRecallAtK !== undefined && baseline.metrics.anchorRecallAtK !== undefined
        ? current.metrics.anchorRecallAtK - baseline.metrics.anchorRecallAtK
        : undefined
    },
    regressions,
    improvements,
    addedCases,
    removedCases
  };
});

onMounted(async () => {
  try {
    await refreshList();
    if (evaluations.value[0]) await selectEvaluation(evaluations.value[0].id);
  } catch (err) {
    error.value = getError(err);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => closeStream?.());

async function refreshList() {
  evaluations.value = (await listRagEvaluations()).evaluations;
}

async function selectEvaluation(id: string) {
  closeStream?.();
  closeStream = undefined;
  activeId.value = id;
  error.value = '';
  streamWarning.value = '';
  compareId.value = '';
  compareEvaluation.value = undefined;
  active.value = (await getRagEvaluation(id)).evaluation;
  upsertEvaluation(active.value);
  if (active.value.status === 'queued' || active.value.status === 'running') connectStream(id);
}

async function selectCompare(id: string) {
  compareId.value = id;
  compareEvaluation.value = undefined;
  if (!id) return;
  compareLoading.value = true;
  try {
    compareEvaluation.value = (await getRagEvaluation(id)).evaluation;
  } catch (err) {
    error.value = getError(err);
    compareId.value = '';
  } finally {
    compareLoading.value = false;
  }
}

function connectStream(id: string) {
  closeStream?.();
  closeStream = subscribeToRagEvaluation(id, (event) => {
    if (activeId.value !== id) return;
    active.value = event.evaluation;
    upsertEvaluation(event.evaluation);
    if (event.type === 'completed' || event.type === 'failed') {
      closeStream = undefined;
      void refreshList();
    }
  }, () => {
    if (activeId.value === id && isActiveRunning.value) {
      streamWarning.value = '实时连接已断开，可刷新记录获取最新状态。';
    }
  });
}

async function startEvaluation() {
  if (creating.value) return;
  creating.value = true;
  error.value = '';
  try {
    const { evaluation } = await createRagEvaluation({
      name: name.value.trim() || undefined,
      k: k.value,
      thresholds: { recallAtK: recallThreshold.value, mrrAtK: mrrThreshold.value },
      retrieval: retrieval.value,
      queryRewrite: queryRewrite.value
    });
    name.value = '';
    showConfig.value = false;
    evaluations.value.unshift(evaluation);
    active.value = evaluation;
    activeId.value = evaluation.id;
    compareId.value = '';
    compareEvaluation.value = undefined;
    connectStream(evaluation.id);
  } catch (err) {
    error.value = getError(err);
  } finally {
    creating.value = false;
  }
}

async function refreshActive() {
  const id = activeId.value;
  if (!id) return;
  try {
    await selectEvaluation(id);
    await refreshList();
  } catch (err) {
    error.value = getError(err);
  }
}

async function confirmDelete() {
  if (!deleteTarget.value || deleting.value) return;
  deleting.value = true;
  error.value = '';
  const id = deleteTarget.value.id;
  try {
    await deleteRagEvaluation(id);
    evaluations.value = evaluations.value.filter((item) => item.id !== id);
    deleteTarget.value = undefined;
    if (compareId.value === id) {
      compareId.value = '';
      compareEvaluation.value = undefined;
    }
    if (activeId.value === id) {
      activeId.value = undefined;
      active.value = undefined;
      if (evaluations.value[0]) await selectEvaluation(evaluations.value[0].id);
    }
  } catch (err) {
    error.value = getError(err);
  } finally {
    deleting.value = false;
  }
}

function upsertEvaluation(evaluation: RagEvaluation) {
  const index = evaluations.value.findIndex((item) => item.id === evaluation.id);
  if (index === -1) evaluations.value.unshift(evaluation);
  else evaluations.value[index] = evaluation;
}

function statusLabel(status: RagEvaluationStatus) {
  return ({ queued: '排队中', running: '运行中', completed: '已完成', failed: '运行失败' } as const)[status];
}

function categoryLabel(category: RagEvaluationCategory) {
  return ({
    exact: '精确检索',
    semantic: '语义检索',
    distractor: '干扰项',
    multi_document: '多文档',
    unanswerable: '不可答'
  } as const)[category];
}

function retrievalLabel(value?: 'dense' | 'hybrid') {
  return value === 'hybrid' ? 'Hybrid（向量+关键词）' : 'Dense（纯向量）';
}

function metric(value?: number) {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function score(value?: number) {
  return value === undefined ? '—' : value.toFixed(3);
}

function delta(value?: number) {
  if (value === undefined) return '—';
  const points = value * 100;
  const sign = points > 0 ? '+' : '';
  return `${sign}${points.toFixed(1)}pp`;
}

function deltaClass(value?: number) {
  if (value === undefined || Math.abs(value) < 0.0005) return 'text-[var(--agent-text-muted)]';
  return value > 0 ? 'text-emerald-700' : 'text-[var(--agent-error-text)]';
}

function formatDuration(ms?: number) {
  if (ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function getError(err: unknown) {
  return err instanceof Error ? err.message : '评测请求失败';
}
</script>

<template>
  <section class="grid min-h-0 grid-cols-[260px_minmax(0,1fr)] overflow-hidden max-lg:grid-cols-1" aria-label="RAG 评测">
    <aside class="chat-session-scroll min-h-0 overflow-y-auto border-r border-[var(--agent-border)] bg-[var(--agent-surface-muted)] max-lg:hidden">
      <div class="sticky top-0 z-10 border-b border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-4">
        <div class="flex items-center justify-between gap-3">
          <div><h1 class="m-0 text-sm font-bold">运行历史</h1><p class="m-0 mt-1 text-xs text-[var(--agent-text-muted)]">最近 {{ evaluations.length }} 次评测</p></div>
          <button class="icon-tooltip grid size-8 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-white hover:text-[var(--agent-text)]" data-tooltip="刷新历史" type="button" @click="refreshList"><PhArrowClockwise :size="16" weight="bold" /></button>
        </div>
      </div>
      <div class="grid gap-1.5 p-2.5">
        <div
          v-for="item in evaluations"
          :key="item.id"
          class="group grid grid-cols-[minmax(0,1fr)_32px] items-center rounded-lg border transition-colors"
          :class="activeId === item.id ? 'border-[var(--agent-selected-border)] bg-white' : 'border-transparent hover:border-[var(--agent-border)] hover:bg-white'"
        >
          <button type="button" class="grid min-w-0 gap-2 bg-transparent p-3 text-left" @click="selectEvaluation(item.id)">
            <div class="flex items-start justify-between gap-2"><strong class="line-clamp-2 text-xs leading-5">{{ item.name }}</strong><PhCircleNotch v-if="item.status === 'queued' || item.status === 'running'" class="mt-0.5 shrink-0 animate-spin text-emerald-600" :size="14" /><PhXCircle v-else-if="item.status === 'failed'" class="mt-0.5 shrink-0 text-[var(--agent-error-text)]" :size="14" /><PhCheckCircle v-else class="mt-0.5 shrink-0" :class="item.report?.status === 'pass' ? 'text-emerald-600' : 'text-amber-600'" :size="14" /></div>
            <div class="flex items-center justify-between text-[11px] text-[var(--agent-text-muted)]"><span>{{ statusLabel(item.status) }}</span><span>{{ formatDate(item.createdAt) }}</span></div>
          </button>
          <button
            type="button"
            class="icon-tooltip mr-1 grid size-7 place-items-center rounded-md text-[var(--agent-text-muted)] opacity-0 transition-opacity hover:bg-[var(--agent-error-bg)] hover:text-[var(--agent-error-text)] focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-20 group-hover:opacity-100"
            :data-tooltip="item.status === 'queued' || item.status === 'running' ? '运行中不可删除' : '删除记录'"
            :disabled="item.status === 'queued' || item.status === 'running'"
            :aria-label="`删除 ${item.name}`"
            @click="deleteTarget = item"
          >
            <PhTrash :size="14" weight="bold" />
          </button>
        </div>
        <p v-if="!evaluations.length && !loading" class="m-0 px-3 py-12 text-center text-xs leading-5 text-[var(--agent-text-muted)]">还没有评测记录。运行一次基准集后，历史会出现在这里。</p>
      </div>
    </aside>

    <main class="chat-session-scroll min-h-0 overflow-y-auto bg-[var(--agent-bg)]">
      <div class="mx-auto grid w-full max-w-[1180px] gap-6 p-5 md:p-7 lg:p-9">
        <header class="flex items-start justify-between gap-5 max-md:flex-col">
          <div><div class="flex items-center gap-2 text-xs font-semibold text-[var(--agent-text-muted)]"><PhFlask :size="16" weight="bold" />RAG Evaluation</div><h2 class="m-0 mt-2 text-2xl font-bold tracking-tight md:text-3xl">检索质量评测</h2><p class="m-0 mt-2 max-w-2xl text-sm leading-6 text-[var(--agent-text-muted)]">按文件、章节、证据锚点三级衡量 Recall 与 MRR，支持不可答用例分数统计和历史运行对比。</p></div>
          <div class="flex shrink-0 gap-2"><button type="button" class="inline-flex h-10 items-center gap-2 rounded-md border border-[var(--agent-border)] px-3 text-sm font-semibold hover:bg-[var(--agent-surface-muted)]" @click="showConfig = !showConfig"><PhSlidersHorizontal :size="17" />配置</button><button type="button" class="inline-flex h-10 items-center gap-2 rounded-md bg-[var(--agent-primary)] px-4 text-sm font-semibold text-white hover:bg-[var(--agent-primary-hover)] disabled:cursor-wait disabled:opacity-60" :disabled="creating" @click="startEvaluation"><PhCircleNotch v-if="creating" class="animate-spin" :size="17" /><PhPlay v-else :size="17" weight="fill" />{{ creating ? '正在创建' : '开始评测' }}</button></div>
        </header>

        <form v-if="showConfig" class="grid grid-cols-[minmax(180px,1fr)_150px_120px_100px_140px_140px_auto] items-end gap-3 rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-4 max-md:grid-cols-2" @submit.prevent="startEvaluation">
          <label class="grid gap-1.5 text-xs font-semibold max-md:col-span-2">运行名称<input v-model="name" class="h-9 rounded-md border border-[var(--agent-border)] bg-white px-3 text-sm outline-none focus:border-[var(--agent-text-muted)]" placeholder="可选" /></label>
          <label class="grid gap-1.5 text-xs font-semibold">检索策略<select v-model="retrieval" class="h-9 rounded-md border border-[var(--agent-border)] bg-white px-2 text-sm outline-none"><option value="dense">Dense 纯向量</option><option value="hybrid">Hybrid 融合</option></select></label>
          <label class="grid gap-1.5 text-xs font-semibold">查询改写<select v-model="queryRewrite" class="h-9 rounded-md border border-[var(--agent-border)] bg-white px-2 text-sm outline-none"><option :value="false">关闭</option><option :value="true">P3 开启</option></select></label>
          <label class="grid gap-1.5 text-xs font-semibold">Top K<input v-model.number="k" type="number" min="1" max="10" class="h-9 rounded-md border border-[var(--agent-border)] bg-white px-3 text-sm outline-none" /></label>
          <label class="grid gap-1.5 text-xs font-semibold">Recall 阈值<input v-model.number="recallThreshold" type="number" min="0" max="1" step="0.05" class="h-9 rounded-md border border-[var(--agent-border)] bg-white px-3 text-sm outline-none" /></label>
          <label class="grid gap-1.5 text-xs font-semibold">MRR 阈值<input v-model.number="mrrThreshold" type="number" min="0" max="1" step="0.05" class="h-9 rounded-md border border-[var(--agent-border)] bg-white px-3 text-sm outline-none" /></label>
          <button type="submit" class="h-9 rounded-md bg-[var(--agent-primary)] px-4 text-sm font-semibold text-white">运行</button>
        </form>

        <p v-if="error" class="m-0 rounded-md bg-[var(--agent-error-bg)] px-4 py-3 text-sm font-semibold text-[var(--agent-error-text)]">{{ error }}</p>
        <p v-if="streamWarning" class="m-0 flex items-center gap-2 rounded-md bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"><PhWarningCircle :size="17" />{{ streamWarning }}</p>

        <div v-if="loading" class="grid gap-4"><div class="h-32 animate-pulse rounded-lg bg-[var(--agent-surface-muted)]"></div><div class="h-64 animate-pulse rounded-lg bg-[var(--agent-surface-muted)]"></div></div>
        <div v-else-if="!active" class="grid min-h-[380px] place-items-center rounded-lg border border-dashed border-[var(--agent-border)]"><div class="max-w-sm text-center"><PhFlask class="mx-auto text-[var(--agent-text-muted)]" :size="32" /><h3 class="m-0 mt-4 text-lg font-bold">建立第一条质量基线</h3><p class="m-0 mt-2 text-sm leading-6 text-[var(--agent-text-muted)]">点击“开始评测”，系统会运行全部基准问题并实时返回进度。</p></div></div>

        <template v-else>
          <section class="rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)]">
            <div class="flex items-start justify-between gap-4 border-b border-[var(--agent-border)] p-5 max-sm:flex-col"><div><div class="flex items-center gap-2"><h3 class="m-0 text-base font-bold">{{ active.name }}</h3><span class="rounded px-1.5 py-0.5 text-[11px] font-bold" :class="active.status === 'failed' ? 'bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]' : isActiveRunning ? 'bg-emerald-50 text-emerald-700' : active.report?.status === 'pass' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'">{{ statusLabel(active.status) }}<template v-if="active.report"> · {{ active.report.status === 'pass' ? '达标' : '未达标' }}</template></span></div><p class="m-0 mt-1.5 text-xs text-[var(--agent-text-muted)]">{{ formatDate(active.createdAt) }} · {{ active.config.collection }} · Top {{ active.config.k }} · {{ (active.report?.config.retrieval ?? active.config.retrieval) === 'hybrid' ? 'Hybrid' : 'Dense' }}<template v-if="active.report"> · Schema v{{ active.report.schemaVersion }}</template></p></div><div class="flex gap-1"><button type="button" class="icon-tooltip grid size-8 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]" data-tooltip="刷新记录" @click="refreshActive"><PhArrowClockwise :size="16" /></button><button type="button" class="icon-tooltip grid size-8 place-items-center rounded-md text-[var(--agent-text-muted)] hover:bg-[var(--agent-error-bg)] hover:text-[var(--agent-error-text)] disabled:opacity-30" data-tooltip="删除记录" :disabled="isActiveRunning" @click="deleteTarget = active"><PhTrash :size="16" /></button></div></div>

            <div v-if="isActiveRunning" class="p-5"><div class="flex items-end justify-between gap-4"><div><p class="m-0 text-sm font-bold">{{ active.status === 'queued' ? '等待执行资源' : '正在检索基准问题' }}</p><p class="m-0 mt-1 font-mono text-xs text-[var(--agent-text-muted)]">{{ active.currentCaseId || '准备评测数据' }}</p></div><strong class="font-mono text-3xl tracking-tight">{{ progress }}%</strong></div><div class="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--agent-border)]"><div class="h-full rounded-full bg-emerald-600 transition-[width] duration-300" :style="{ width: `${progress}%` }"></div></div><p class="m-0 mt-2 text-xs text-[var(--agent-text-muted)]">{{ active.completedCases }} / {{ active.totalCases }} 个案例完成</p></div>
            <div v-else-if="active.status === 'failed'" class="p-5"><p class="m-0 text-sm font-bold text-[var(--agent-error-text)]">评测没有完成</p><p class="m-0 mt-2 text-sm leading-6 text-[var(--agent-text-muted)]">{{ active.error }}</p></div>
            <template v-else>
              <div class="grid grid-cols-4 divide-x divide-[var(--agent-border)] max-md:grid-cols-2 max-md:divide-x-0">
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">文件 Recall@{{ active.config.k }}</span><strong class="mt-2 block font-mono text-3xl tracking-tight">{{ metric(active.report?.metrics.recallAtK) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">阈值 {{ metric(active.config.thresholds.recallAtK) }}</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">文件 MRR@{{ active.config.k }}</span><strong class="mt-2 block font-mono text-3xl tracking-tight">{{ metric(active.report?.metrics.mrrAtK) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">阈值 {{ metric(active.config.thresholds.mrrAtK) }}</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">案例通过率</span><strong class="mt-2 block font-mono text-3xl tracking-tight">{{ metric(active.report?.metrics.passRate) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">{{ active.report?.cases.filter(item => (item.answerable ?? true) && item.passed).length }} / {{ active.report?.metrics.answerableCaseCount ?? active.report?.metrics.caseCount }} 通过</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">运行耗时</span><strong class="mt-2 block font-mono text-3xl tracking-tight">{{ formatDuration(active.report?.durationMs) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">{{ active.report?.metrics.caseCount }} 个案例</span></div>
              </div>
              <div v-if="active.report?.metrics.headingRecallAtK !== undefined" class="grid grid-cols-4 divide-x divide-[var(--agent-border)] border-t border-[var(--agent-border)] max-md:grid-cols-2 max-md:divide-x-0">
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">章节 Recall@{{ active.config.k }}</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ metric(active.report?.metrics.headingRecallAtK) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">MRR {{ metric(active.report?.metrics.headingMrrAtK) }} · {{ active.report?.metrics.headingCaseCount }} 例</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">证据锚点 Recall@{{ active.config.k }}</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ metric(active.report?.metrics.anchorRecallAtK) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">MRR {{ metric(active.report?.metrics.anchorMrrAtK) }} · {{ active.report?.metrics.anchorCaseCount }} 例</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">可答 Top1 相似度</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ score(active.report?.metrics.answerableAvgTop1Score) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">均值 · {{ active.report?.metrics.answerableCaseCount }} 例</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">不可答 Top1 相似度</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ score(active.report?.metrics.unanswerable?.avgTop1Score) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">最高 {{ score(active.report?.metrics.unanswerable?.maxTop1Score) }} · {{ active.report?.metrics.unanswerable?.caseCount ?? 0 }} 例</span></div>
              </div>
              <div v-if="active.report?.metrics.confidenceGate" class="grid grid-cols-2 divide-x divide-[var(--agent-border)] border-t border-[var(--agent-border)] max-md:grid-cols-1 max-md:divide-x-0">
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">拒答召回</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ metric(active.report.metrics.confidenceGate.rejectionRecall) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">{{ active.report.metrics.confidenceGate.rejectedUnanswerableCount }} / {{ active.report.metrics.unanswerable?.caseCount ?? 0 }} 条不可答问题判为 empty · 阈值 {{ metric(active.report.thresholds.minRejectionRecall) }}</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">误拒率</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ metric(active.report.metrics.confidenceGate.falseRejectionRate) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">{{ active.report.metrics.confidenceGate.falselyRejectedAnswerableCount }} / {{ active.report.metrics.answerableCaseCount ?? 0 }} 条可答问题被判为 empty · 上限 {{ active.report.thresholds.maxFalseRejections ?? '—' }} 条</span></div>
              </div>
              <div v-if="active.report?.metrics.queryRewrite && active.report.config.queryRewrite" class="grid grid-cols-3 divide-x divide-[var(--agent-border)] border-t border-[var(--agent-border)] max-md:grid-cols-1 max-md:divide-x-0">
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">改写触发率</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ metric(active.report.metrics.queryRewrite.triggerRate) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">{{ active.report.metrics.queryRewrite.triggeredCaseCount }} / {{ active.report.metrics.caseCount }} 个案例</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">平均查询数</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ active.report.metrics.queryRewrite.avgQueryCount.toFixed(2) }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">最多 {{ active.report.metrics.queryRewrite.maxQueryCount }} 次 · 总计 {{ active.report.metrics.queryRewrite.totalQueryCount }}</span></div>
                <div class="p-5"><span class="text-xs font-semibold text-[var(--agent-text-muted)]">平均改写耗时</span><strong class="mt-2 block font-mono text-2xl tracking-tight">{{ active.report.metrics.queryRewrite.avgRewriteDurationMs === undefined ? '—' : `${Math.round(active.report.metrics.queryRewrite.avgRewriteDurationMs)} ms` }}</strong><span class="mt-1 block text-[11px] text-[var(--agent-text-muted)]">仅统计已触发案例</span></div>
              </div>
            </template>
          </section>

          <section v-if="active.report && comparableRuns.length" class="rounded-lg border border-[var(--agent-border)]">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--agent-border)] px-5 py-4">
              <div class="flex items-center gap-2"><PhArrowsLeftRight :size="16" weight="bold" class="text-[var(--agent-text-muted)]" /><h3 class="m-0 text-sm font-bold">基线对比</h3><PhCircleNotch v-if="compareLoading" class="animate-spin text-[var(--agent-text-muted)]" :size="14" /></div>
              <label class="flex items-center gap-2 text-xs font-semibold text-[var(--agent-text-muted)]">对比运行
                <select :value="compareId" class="h-8 max-w-[260px] rounded-md border border-[var(--agent-border)] bg-white px-2 text-xs font-semibold text-[var(--agent-text)] outline-none" @change="selectCompare(($event.target as HTMLSelectElement).value)">
                  <option value="">选择历史运行…</option>
                  <option v-for="item in comparableRuns" :key="item.id" :value="item.id">{{ item.name }}（{{ formatDate(item.createdAt) }}）</option>
                </select>
              </label>
            </div>
            <template v-if="diff">
              <div class="grid grid-cols-5 divide-x divide-[var(--agent-border)] max-md:grid-cols-2 max-md:divide-x-0">
                <div class="p-4"><span class="text-[11px] font-semibold text-[var(--agent-text-muted)]">文件 Recall</span><strong class="mt-1 block font-mono text-xl" :class="deltaClass(diff.deltas.recallAtK)">{{ delta(diff.deltas.recallAtK) }}</strong></div>
                <div class="p-4"><span class="text-[11px] font-semibold text-[var(--agent-text-muted)]">文件 MRR</span><strong class="mt-1 block font-mono text-xl" :class="deltaClass(diff.deltas.mrrAtK)">{{ delta(diff.deltas.mrrAtK) }}</strong></div>
                <div class="p-4"><span class="text-[11px] font-semibold text-[var(--agent-text-muted)]">通过率</span><strong class="mt-1 block font-mono text-xl" :class="deltaClass(diff.deltas.passRate)">{{ delta(diff.deltas.passRate) }}</strong></div>
                <div class="p-4"><span class="text-[11px] font-semibold text-[var(--agent-text-muted)]">章节 Recall</span><strong class="mt-1 block font-mono text-xl" :class="deltaClass(diff.deltas.headingRecallAtK)">{{ delta(diff.deltas.headingRecallAtK) }}</strong></div>
                <div class="p-4"><span class="text-[11px] font-semibold text-[var(--agent-text-muted)]">锚点 Recall</span><strong class="mt-1 block font-mono text-xl" :class="deltaClass(diff.deltas.anchorRecallAtK)">{{ delta(diff.deltas.anchorRecallAtK) }}</strong></div>
              </div>
              <div class="grid grid-cols-2 gap-px border-t border-[var(--agent-border)] bg-[var(--agent-border)] max-md:grid-cols-1">
                <div class="bg-white p-4">
                  <div class="flex items-center gap-1.5 text-xs font-bold text-[var(--agent-error-text)]"><PhTrendDown :size="14" weight="bold" />退步（{{ diff.regressions.length }}）</div>
                  <ul v-if="diff.regressions.length" class="m-0 mt-2 grid list-none gap-1.5 p-0">
                    <li v-for="item in diff.regressions" :key="item.id" class="rounded-md bg-[var(--agent-error-bg)] px-3 py-2 text-xs"><strong class="font-mono">{{ item.id }}</strong><span class="text-[var(--agent-text-muted)]"> · {{ categoryLabel(item.category) }}</span><p class="m-0 mt-0.5 leading-5">{{ item.query }}</p></li>
                  </ul>
                  <p v-else class="m-0 mt-2 text-xs text-[var(--agent-text-muted)]">没有由过变挂的案例。</p>
                </div>
                <div class="bg-white p-4">
                  <div class="flex items-center gap-1.5 text-xs font-bold text-emerald-700"><PhTrendUp :size="14" weight="bold" />改进（{{ diff.improvements.length }}）</div>
                  <ul v-if="diff.improvements.length" class="m-0 mt-2 grid list-none gap-1.5 p-0">
                    <li v-for="item in diff.improvements" :key="item.id" class="rounded-md bg-emerald-50 px-3 py-2 text-xs"><strong class="font-mono">{{ item.id }}</strong><span class="text-[var(--agent-text-muted)]"> · {{ categoryLabel(item.category) }}</span><p class="m-0 mt-0.5 leading-5">{{ item.query }}</p></li>
                  </ul>
                  <p v-else class="m-0 mt-2 text-xs text-[var(--agent-text-muted)]">没有由挂变过的案例。</p>
                </div>
              </div>
              <p v-if="diff.addedCases.length || diff.removedCases.length" class="m-0 border-t border-[var(--agent-border)] px-5 py-3 text-xs text-[var(--agent-text-muted)]">基准集变化：新增 {{ diff.addedCases.length }} 例、移除 {{ diff.removedCases.length }} 例，指标差值不完全可比。</p>
            </template>
            <p v-else class="m-0 px-5 py-6 text-center text-xs text-[var(--agent-text-muted)]">选择一次已完成的历史运行，即可对比指标差值和逐案例的过/挂变化。</p>
          </section>

          <section v-if="active.report" class="grid grid-cols-[minmax(0,1.2fr)_minmax(280px,.8fr)] gap-6 max-lg:grid-cols-1">
            <div class="rounded-lg border border-[var(--agent-border)]"><div class="border-b border-[var(--agent-border)] px-5 py-4"><h3 class="m-0 text-sm font-bold">分类成绩</h3></div><div class="overflow-x-auto"><table class="w-full border-collapse text-left"><thead><tr class="text-[11px] font-bold text-[var(--agent-text-muted)]"><th class="px-5 py-3">类别</th><th class="px-3 py-3">通过</th><th class="px-3 py-3">Recall</th><th class="px-3 py-3">MRR</th><th class="px-3 py-3">章节</th><th class="px-5 py-3 text-right">通过率</th></tr></thead><tbody><tr v-for="category in active.report.categories" :key="category.category" class="border-t border-[var(--agent-border-soft)] text-sm"><td class="px-5 py-3.5 font-semibold">{{ categoryLabel(category.category) }}</td><td class="px-3 py-3.5 font-mono text-xs">{{ category.passedCount }}/{{ category.caseCount }}</td><td class="px-3 py-3.5 font-mono text-xs">{{ metric(category.recallAtK) }}</td><td class="px-3 py-3.5 font-mono text-xs">{{ metric(category.mrrAtK) }}</td><td class="px-3 py-3.5 font-mono text-xs">{{ metric(category.headingRecallAtK) }}</td><td class="px-5 py-3.5 text-right font-mono text-xs font-bold">{{ metric(category.passRate) }}</td></tr></tbody></table></div></div>
            <div class="rounded-lg border border-[var(--agent-border)] p-5"><h3 class="m-0 text-sm font-bold">运行配置</h3><dl class="mt-4 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-3 text-xs"><dt class="text-[var(--agent-text-muted)]">检索策略</dt><dd class="m-0 font-mono">{{ retrievalLabel(active.report?.config.retrieval ?? active.config.retrieval) }}</dd><dt class="text-[var(--agent-text-muted)]">Query Rewrite</dt><dd class="m-0 font-mono">{{ (active.report?.config.queryRewrite ?? active.config.queryRewrite) ? 'P3 开启' : '关闭' }}</dd><dt class="text-[var(--agent-text-muted)]">Embedding</dt><dd class="m-0 break-all font-mono">{{ active.config.embeddingModel }}</dd><dt class="text-[var(--agent-text-muted)]">Collection</dt><dd class="m-0 break-all font-mono">{{ active.config.collection }}</dd><dt class="text-[var(--agent-text-muted)]">Top K</dt><dd class="m-0 font-mono">{{ active.config.k }}</dd><dt class="text-[var(--agent-text-muted)]">Recall 阈值</dt><dd class="m-0 font-mono">{{ metric(active.config.thresholds.recallAtK) }}</dd><dt class="text-[var(--agent-text-muted)]">MRR 阈值</dt><dd class="m-0 font-mono">{{ metric(active.config.thresholds.mrrAtK) }}</dd><dt class="text-[var(--agent-text-muted)]">用例规模</dt><dd class="m-0 font-mono">{{ active.report.metrics.caseCount }}（不可答 {{ active.report.metrics.unanswerable?.caseCount ?? 0 }}）</dd></dl></div>
          </section>

          <section v-if="active.report" class="rounded-lg border border-[var(--agent-border)]"><div class="flex items-center justify-between border-b border-[var(--agent-border)] px-5 py-4"><div><h3 class="m-0 text-sm font-bold">失败案例</h3><p class="m-0 mt-1 text-xs text-[var(--agent-text-muted)]">检查未召回文档和实际排序（章节/锚点命中以标记显示）</p></div><strong class="font-mono text-sm" :class="failedCases.length ? 'text-[var(--agent-error-text)]' : 'text-emerald-700'">{{ failedCases.length }}</strong></div>
            <div v-if="failedCases.length" class="grid gap-px bg-[var(--agent-border)]"><details v-for="item in failedCases" :key="item.id" class="group bg-white p-5"><summary class="flex cursor-pointer list-none items-start justify-between gap-4"><div><div class="flex flex-wrap items-center gap-2"><span class="rounded bg-[var(--agent-error-bg)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--agent-error-text)]">{{ categoryLabel(item.category) }}</span><strong class="font-mono text-xs">{{ item.id }}</strong></div><p class="m-0 mt-2 text-sm leading-6">{{ item.query }}</p></div><PhCaretDown class="mt-1 shrink-0 text-[var(--agent-text-muted)] transition-transform group-open:rotate-180" :size="16" /></summary><div class="mt-4 grid gap-3 border-t border-[var(--agent-border)] pt-4"><p class="m-0 text-xs"><span class="text-[var(--agent-text-muted)]">期望文档：</span><span class="font-mono">{{ item.expectedFiles.join(', ') }}</span></p><p v-if="item.expectedHeadings?.length" class="m-0 text-xs"><span class="text-[var(--agent-text-muted)]">期望章节：</span><span class="font-mono">{{ item.expectedHeadings.join('、') }}</span></p><ol class="m-0 grid list-none gap-2 p-0"><li v-for="result in item.retrieved" :key="result.id" class="grid grid-cols-[28px_minmax(0,1fr)_auto_70px] items-center gap-2 rounded-md bg-[var(--agent-surface-muted)] px-3 py-2 text-xs"><span class="font-mono text-[var(--agent-text-muted)]">#{{ result.rank }}</span><span class="min-w-0 truncate"><strong>{{ result.file }}</strong><span v-if="result.heading" class="text-[var(--agent-text-muted)]"> · {{ result.heading }}</span></span><span class="flex gap-1"><span v-if="result.headingRelevant" class="rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-bold text-emerald-700">章节</span><span v-if="result.anchorRelevant" class="rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-bold text-emerald-700">锚点</span></span><span class="text-right font-mono" :class="result.relevant ? 'text-emerald-700' : 'text-[var(--agent-text-muted)]'">{{ result.score.toFixed(3) }}</span></li></ol></div></details></div>
            <div v-else class="grid place-items-center px-5 py-12 text-center"><PhCheckCircle class="text-emerald-600" :size="28" /><p class="m-0 mt-3 text-sm font-bold">全部案例通过</p><p class="m-0 mt-1 text-xs text-[var(--agent-text-muted)]">当前配置下没有失败案例。</p></div>
          </section>
        </template>
      </div>
    </main>

    <div v-if="deleteTarget" class="fixed inset-0 z-30 grid place-items-center bg-black/20 p-5" role="dialog" aria-modal="true" aria-label="删除评测记录确认"><div class="grid w-full max-w-md gap-4 rounded-lg border border-[var(--agent-border)] bg-white p-5 shadow-lg"><div class="flex gap-3"><span class="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]"><PhTrash :size="18" /></span><div><h3 class="m-0 text-base font-bold">删除评测记录</h3><p class="m-0 mt-1 text-sm leading-6 text-[var(--agent-text-muted)]">“{{ deleteTarget.name }}”的配置和完整报告将被永久删除。</p></div></div><div class="flex justify-end gap-2"><button type="button" class="h-9 rounded-md border border-[var(--agent-border)] px-3 text-sm font-semibold" :disabled="deleting" @click="deleteTarget = undefined">取消</button><button type="button" class="h-9 rounded-md bg-[var(--agent-error-text)] px-3 text-sm font-semibold text-white disabled:opacity-60" :disabled="deleting" @click="confirmDelete">{{ deleting ? '删除中' : '确认删除' }}</button></div></div></div>
  </section>
</template>

<style scoped>
summary::-webkit-details-marker { display: none; }
</style>
