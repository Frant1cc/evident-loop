<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  PhArrowSquareOut,
  PhCheck,
  PhCheckCircle,
  PhCircleNotch,
  PhFlask,
  PhGlobeHemisphereWest,
  PhListPlus,
  PhPlay,
  PhPlus,
  PhTrash,
  PhWarningCircle,
  PhXCircle
} from '@phosphor-icons/vue';

import {
  createWebEvaluation,
  createWebEvaluationCase,
  deleteWebEvaluation,
  deleteWebEvaluationCase,
  listWebEvaluationCases,
  listWebEvaluations,
  subscribeToWebEvaluation
} from '../api/evaluations';
import type { WebEvaluation, WebEvaluationCase, WebEvaluationMetrics } from '../types/evaluations';
import EvaluationHistorySidebar, { type EvaluationHistoryItem } from '../components/evaluations/EvaluationHistorySidebar.vue';
import EvaluationStatusBadge from '../components/evaluations/EvaluationStatusBadge.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

const cases = ref<WebEvaluationCase[]>([]);
const runs = ref<WebEvaluation[]>([]);
const selectedIds = ref<string[]>([]);
const activeId = ref('');
const baselineId = ref('');
const detailId = ref('');
const error = ref('');
const loading = ref(true);
const launching = ref(false);
const showCreator = ref(false);
const savingCase = ref(false);
const deleting = ref(false);
const deleteRunTarget = ref<WebEvaluation>();
const deleteCaseTarget = ref<WebEvaluationCase>();
const form = ref({ title: '', question: '', answerable: true, domains: '', needs: '' });
let unsubscribe: (() => void) | undefined;

const active = computed(() => runs.value.find((item) => item.id === activeId.value));
const baseline = computed(() => runs.value.find((item) => item.id === baselineId.value));
const detail = computed(() => active.value?.report?.cases.find((item) => item.id === detailId.value) ?? active.value?.report?.cases[0]);
const running = computed(() => ['queued', 'running'].includes(active.value?.status ?? ''));
const anyRunning = computed(() => runs.value.some((item) => ['queued', 'running'].includes(item.status)));
const baselines = computed(() => runs.value.filter((item) => item.id !== activeId.value && item.status === 'completed'));
const metrics = computed(() => active.value?.report?.metrics);
const customCases = computed(() => cases.value.filter((item) => item.custom));
const progress = computed(() => (active.value?.completedCases ?? 0) / Math.max(active.value?.totalCases ?? 1, 1));
const historyItems = computed<EvaluationHistoryItem[]>(() => runs.value.map((run) => ({
  id: run.id,
  name: run.name,
  status: run.status,
  statusLabel: statusLabel(run.status),
  meta: `${run.completedCases}/${run.totalCases} · ${date(run.createdAt)}`,
  passed: run.report ? run.report.metrics.falseSufficientCount === 0 && run.report.metrics.passRate === 1 : undefined
})));
const deltas = computed(() => {
  const current = metrics.value;
  const base = baseline.value?.report?.metrics;
  if (!current || !base) return [];
  const fields: Array<[keyof WebEvaluationMetrics, string, boolean?]> = [
    ['hitAtK', 'Hit@K'],
    ['mrr', 'MRR'],
    ['evidencePrecision', '证据精确率'],
    ['evidenceRecall', '问题覆盖率'],
    ['passRate', '通过率'],
    ['falseSufficientRate', '误判充分率', true]
  ];
  return fields.map(([key, label, lower]) => {
    const value = Number(current[key]) - Number(base[key]);
    return { key, label, delta: value, good: lower ? value < 0 : value > 0 };
  });
});

onMounted(async () => {
  try {
    await reload();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => unsubscribe?.());

async function reload() {
  const [caseData, runData] = await Promise.all([listWebEvaluationCases(), listWebEvaluations()]);
  cases.value = caseData.cases;
  if (!selectedIds.value.length) selectedIds.value = caseData.cases.map((item) => item.id);
  runs.value = runData.evaluations;
  if (runs.value[0] && !activeId.value) selectRun(runs.value[0]);
}

async function launch() {
  if (!selectedIds.value.length || anyRunning.value || launching.value) return;
  launching.value = true;
  error.value = '';
  try {
    const { evaluation } = await createWebEvaluation({ caseIds: selectedIds.value, k: 3 });
    runs.value.unshift(evaluation);
    selectRun(evaluation);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    launching.value = false;
  }
}

function selectRun(run: WebEvaluation) {
  activeId.value = run.id;
  detailId.value = run.report?.cases[0]?.id ?? '';
  baselineId.value = '';
  unsubscribe?.();
  unsubscribe = undefined;
  if (!['queued', 'running'].includes(run.status)) return;
  unsubscribe = subscribeToWebEvaluation(run.id, (event) => {
    const index = runs.value.findIndex((item) => item.id === event.evaluation.id);
    if (index >= 0) runs.value[index] = event.evaluation;
    if (event.evaluation.report && !detailId.value) detailId.value = event.evaluation.report.cases[0]?.id ?? '';
  }, () => {
    error.value = '实时进度连接已中断，请刷新查看结果。';
  });
}

function selectRunById(id: string) {
  const run = runs.value.find((item) => item.id === id);
  if (run) selectRun(run);
}

async function confirmRemoveRun() {
  const run = deleteRunTarget.value;
  if (!run || deleting.value) return;
  deleting.value = true;
  error.value = '';
  try {
    await deleteWebEvaluation(run.id);
    runs.value = runs.value.filter((item) => item.id !== run.id);
    deleteRunTarget.value = undefined;
    if (activeId.value === run.id) {
      activeId.value = '';
      if (runs.value[0]) selectRun(runs.value[0]);
    }
  } catch (cause) {
    error.value = message(cause);
  } finally {
    deleting.value = false;
  }
}

async function saveCase() {
  if (savingCase.value) return;
  savingCase.value = true;
  error.value = '';
  try {
    const domains = split(form.value.domains);
    const { case: saved } = await createWebEvaluationCase({
      title: form.value.title,
      question: form.value.question,
      answerable: form.value.answerable,
      includeDomains: domains,
      expectedDomains: domains,
      evidenceNeeds: split(form.value.needs)
    });
    cases.value.push(saved);
    selectedIds.value.push(saved.id);
    form.value = { title: '', question: '', answerable: true, domains: '', needs: '' };
    showCreator.value = false;
  } catch (cause) {
    error.value = message(cause);
  } finally {
    savingCase.value = false;
  }
}

async function confirmRemoveCase() {
  const item = deleteCaseTarget.value;
  if (!item || deleting.value) return;
  deleting.value = true;
  error.value = '';
  try {
    await deleteWebEvaluationCase(item.id);
    cases.value = cases.value.filter((candidate) => candidate.id !== item.id);
    selectedIds.value = selectedIds.value.filter((id) => id !== item.id);
    deleteCaseTarget.value = undefined;
  } catch (cause) {
    error.value = message(cause);
  } finally {
    deleting.value = false;
  }
}

function toggle(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id];
}

function split(value: string) {
  return value.split(/[，,;；\n]/).map((item) => item.trim()).filter(Boolean);
}

function statusLabel(status: WebEvaluation['status']) {
  return ({ queued: '排队中', running: '运行中', completed: '已完成', failed: '运行失败' } as const)[status];
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function time(value: number) {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function date(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : '操作失败';
}
</script>

<template>
  <section class="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)] overflow-hidden bg-background max-lg:grid-cols-1" aria-label="联网检索评测">
    <EvaluationHistorySidebar
      :items="historyItems"
      :active-id="activeId"
      :loading="loading"
      title="联网评测"
      @refresh="reload"
      @select="selectRunById"
      @delete="deleteRunTarget = runs.find((item) => item.id === $event)"
    />

    <main class="app-scrollbar min-h-0 overflow-y-auto overscroll-contain">
      <div class="mx-auto grid w-full max-w-6xl gap-6 px-5 py-7 md:px-7 lg:px-9 lg:py-8">
        <header class="flex items-start justify-between gap-5 max-md:flex-col">
          <div>
            <p class="m-0 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"><PhGlobeHemisphereWest :size="16" weight="bold" aria-hidden="true" />Web retrieval lab</p>
            <h1 class="m-0 mt-1.5 text-2xl font-semibold tracking-[-0.035em] md:text-3xl">联网检索实验台</h1>
            <p class="m-0 mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">把问题拆成可核验的证据点，判断“检索到了”是否真的足以支撑回答。</p>
          </div>
          <div class="flex w-full shrink-0 items-center gap-2 md:w-auto">
            <select v-if="runs.length" :value="activeId" class="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 lg:hidden" aria-label="选择联网评测运行" @change="selectRunById(($event.target as HTMLSelectElement).value)">
              <option v-for="run in runs" :key="run.id" :value="run.id">{{ run.name }}</option>
            </select>
            <Button size="lg" :disabled="launching || !selectedIds.length || anyRunning" @click="launch">
              <PhCircleNotch v-if="launching || anyRunning" class="animate-spin" :size="17" aria-hidden="true" />
              <PhPlay v-else :size="17" weight="fill" aria-hidden="true" />
              {{ anyRunning ? '评测运行中' : `运行 ${selectedIds.length} 道题` }}
            </Button>
          </div>
        </header>

        <p v-if="error" class="m-0 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert"><PhWarningCircle class="mt-0.5 shrink-0" :size="17" aria-hidden="true" />{{ error }}</p>

        <section v-if="running" class="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <div class="flex items-end justify-between gap-4"><div><p class="m-0 text-sm font-semibold">正在验证 {{ active?.currentCaseId || '问题集' }}</p><p class="m-0 mt-1 text-xs text-muted-foreground">顺序调用真实联网检索，避免并发放大 API credits 消耗。</p></div><strong class="font-mono text-xl tabular-nums text-amber-700 dark:text-amber-300">{{ active?.completedCases }}/{{ active?.totalCases }}</strong></div>
          <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary"><div class="h-full rounded-full bg-amber-500 transition-[width] duration-300 motion-reduce:transition-none" :style="{ width: pct(progress) }" /></div>
        </section>

        <section class="overflow-hidden rounded-xl border border-border bg-card">
          <header class="flex items-center justify-between gap-4 border-b border-border px-5 py-4 max-sm:items-start">
            <div><h2 class="m-0 text-sm font-semibold">回归基线与自定义题</h2><p class="m-0 mt-1 text-xs leading-5 text-muted-foreground">固定题保证前后可比；自定义题验证真实业务问题。</p></div>
            <div class="flex shrink-0 items-center gap-1">
              <Button variant="outline" size="sm" @click="showCreator = !showCreator"><PhPlus :size="14" aria-hidden="true" />添加题目</Button>
              <Button variant="ghost" size="sm" @click="selectedIds = selectedIds.length === cases.length ? [] : cases.map((item) => item.id)">{{ selectedIds.length === cases.length ? '清空' : '全选' }}</Button>
            </div>
          </header>

          <form v-if="showCreator" class="border-b border-border bg-muted/30 p-5" @submit.prevent="saveCase">
            <div class="flex items-start gap-3"><span class="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground"><PhListPlus :size="18" aria-hidden="true" /></span><div><h3 class="m-0 text-sm font-semibold">添加自定义评测题</h3><p class="m-0 mt-1 text-xs leading-5 text-muted-foreground">域名和证据点使用逗号分隔。</p></div></div>
            <div class="mt-4 grid grid-cols-2 gap-4 max-sm:grid-cols-1">
              <label class="grid gap-1.5 text-xs font-medium">题目名称<input v-model="form.title" required maxlength="80" class="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="例如：OpenAI Responses API" /></label>
              <label class="grid gap-1.5 text-xs font-medium max-sm:col-auto sm:col-span-2">问题内容<Textarea v-model="form.question" required maxlength="1000" class="min-h-24 bg-background" placeholder="写入希望验证的完整问题。" /></label>
              <label class="grid gap-1.5 text-xs font-medium">官方域名<input v-model="form.domains" :required="form.answerable" class="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="例如：platform.openai.com" /></label>
              <label class="grid gap-1.5 text-xs font-medium">证据点<input v-model="form.needs" :required="form.answerable" class="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" placeholder="例如：参数名, 可选值, 定价" /></label>
              <label class="flex items-center gap-2 text-xs font-medium"><input v-model="form.answerable" type="checkbox" class="size-4 rounded border-input accent-primary" />这是可回答的问题</label>
            </div>
            <div class="mt-4 flex justify-end gap-2"><Button type="button" variant="outline" @click="showCreator = false">取消</Button><Button type="submit" :disabled="savingCase"><PhCircleNotch v-if="savingCase" class="animate-spin" aria-hidden="true" />{{ savingCase ? '保存中' : '保存并加入本次运行' }}</Button></div>
          </form>

          <div v-if="loading" class="grid grid-cols-2 gap-2 p-4 max-sm:grid-cols-1"><span v-for="index in 4" :key="index" class="h-20 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" /></div>
          <div v-else class="grid grid-cols-2 gap-2 p-4 max-sm:grid-cols-1">
            <div v-for="item in cases" :key="item.id" class="group relative flex min-w-0 rounded-lg border transition-colors" :class="selectedIds.includes(item.id) ? 'border-border bg-secondary/70' : 'border-border/70 hover:bg-muted/50'">
              <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-start gap-3 p-3 pr-9 text-left" :aria-pressed="selectedIds.includes(item.id)" @click="toggle(item.id)">
                <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border" :class="selectedIds.includes(item.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background text-transparent'"><PhCheck :size="13" weight="bold" aria-hidden="true" /></span>
                <span class="min-w-0"><span class="flex items-center gap-2"><strong class="truncate text-sm font-medium">{{ item.title }}</strong><Badge v-if="item.custom" variant="secondary" class="h-4 px-1.5 text-[9px]">自定义</Badge></span><span class="mt-1 block text-[11px] leading-5 text-muted-foreground">{{ item.answerable ? '可回答' : '不可回答' }} · {{ item.evidenceNeeds.length }} 个证据点 · {{ item.expectedDomains.join(', ') || '不限定域名' }}</span></span>
              </button>
              <Button v-if="item.custom" type="button" variant="ghost" size="icon-sm" class="absolute right-1.5 top-1.5 text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100" :aria-label="`删除自定义题：${item.title}`" @click="deleteCaseTarget = item"><PhTrash :size="14" aria-hidden="true" /></Button>
            </div>
            <p v-if="!cases.length" class="col-span-full m-0 px-4 py-8 text-center text-sm text-muted-foreground">暂无可用评测题。</p>
          </div>
          <p v-if="customCases.length" class="m-0 border-t border-border px-5 py-3 text-[11px] leading-5 text-muted-foreground">自定义题会持久化保存；固定基线题不可删除，以保证历史评测可比。</p>
        </section>

        <template v-if="metrics && active?.report">
          <section class="grid grid-cols-6 divide-x divide-border overflow-hidden rounded-xl border border-border bg-card max-xl:grid-cols-3 max-sm:grid-cols-2 max-sm:divide-x-0">
            <div class="p-4"><span class="text-[11px] font-medium text-muted-foreground">Hit@{{ active.report.k }}</span><strong class="mt-1 block font-mono text-2xl font-semibold tabular-nums">{{ pct(metrics.hitAtK) }}</strong><span class="mt-1 block text-[10px] leading-4 text-muted-foreground">前 K 条出现有效来源</span></div>
            <div class="p-4"><span class="text-[11px] font-medium text-muted-foreground">MRR</span><strong class="mt-1 block font-mono text-2xl font-semibold tabular-nums">{{ metrics.mrr.toFixed(2) }}</strong><span class="mt-1 block text-[10px] leading-4 text-muted-foreground">有效来源越靠前越好</span></div>
            <div class="p-4"><span class="text-[11px] font-medium text-muted-foreground">证据精确率</span><strong class="mt-1 block font-mono text-2xl font-semibold tabular-nums">{{ pct(metrics.evidencePrecision) }}</strong><span class="mt-1 block text-[10px] leading-4 text-muted-foreground">有效来源比例</span></div>
            <div class="p-4"><span class="text-[11px] font-medium text-muted-foreground">问题覆盖率</span><strong class="mt-1 block font-mono text-2xl font-semibold tabular-nums">{{ pct(metrics.evidenceRecall) }}</strong><span class="mt-1 block text-[10px] leading-4 text-muted-foreground">事实点覆盖比例</span></div>
            <div class="p-4"><span class="text-[11px] font-medium text-muted-foreground">用例通过率</span><strong class="mt-1 block font-mono text-2xl font-semibold tabular-nums">{{ pct(metrics.passRate) }}</strong><span class="mt-1 block text-[10px] leading-4 text-muted-foreground">{{ metrics.caseCount }} 道问题</span></div>
            <div class="p-4" :class="metrics.falseSufficientCount ? 'bg-destructive/5' : ''"><span class="text-[11px] font-medium text-muted-foreground">误判充分</span><strong class="mt-1 block font-mono text-2xl font-semibold tabular-nums" :class="metrics.falseSufficientCount ? 'text-destructive' : ''">{{ metrics.falseSufficientCount }}</strong><span class="mt-1 block text-[10px] leading-4 text-muted-foreground">系统说充分但证据不足</span></div>
          </section>

          <section class="rounded-xl border border-border bg-card p-5">
            <div class="flex items-center justify-between gap-4 max-sm:items-start"><div><h2 class="m-0 text-sm font-semibold">与历史运行对比</h2><p class="m-0 mt-1 text-xs text-muted-foreground">检查优化是否带来实际提升。</p></div><select v-model="baselineId" class="h-9 max-w-64 rounded-lg border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"><option value="">选择基线运行</option><option v-for="run in baselines" :key="run.id" :value="run.id">{{ run.name }}</option></select></div>
            <div v-if="deltas.length" class="mt-4 grid grid-cols-6 gap-3 max-lg:grid-cols-3 max-sm:grid-cols-2"><div v-for="item in deltas" :key="item.key" class="border-l-2 border-border pl-3"><span class="block text-[10px] text-muted-foreground">{{ item.label }}</span><strong class="mt-1 block font-mono text-base tabular-nums" :class="item.delta === 0 ? 'text-muted-foreground' : item.good ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'">{{ item.delta > 0 ? '+' : '' }}{{ pct(item.delta) }}</strong></div></div>
            <p v-else class="m-0 mt-4 text-xs text-muted-foreground">完成至少两次运行后，可在这里比较策略变化。</p>
          </section>

          <section class="overflow-hidden rounded-xl border border-border bg-card">
            <header class="flex items-center justify-between gap-4 border-b border-border px-5 py-4"><div><h2 class="m-0 text-sm font-semibold">逐题结果</h2><p class="m-0 mt-1 text-xs text-muted-foreground">选择题目查看证据覆盖、查询轨迹和来源。</p></div><span class="text-[11px] text-muted-foreground">平均 {{ metrics.avgQueryCount.toFixed(1) }} 次查询 / {{ metrics.avgPageCount.toFixed(1) }} 页</span></header>
            <div class="divide-y divide-border">
              <button v-for="item in active.report.cases" :key="item.id" type="button" class="grid w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)_minmax(170px,240px)_auto] items-center gap-3 px-5 py-3 text-left hover:bg-muted/50 max-md:grid-cols-[24px_minmax(0,1fr)]" :class="detail?.id === item.id ? 'bg-muted' : ''" @click="detailId = item.id">
                <component :is="item.passed ? PhCheckCircle : PhXCircle" :class="item.passed ? 'text-emerald-600 dark:text-emerald-300' : 'text-destructive'" :size="19" weight="fill" />
                <span class="min-w-0"><strong class="block truncate text-sm font-medium">{{ item.title }}</strong><small class="mt-0.5 block text-[10px] text-muted-foreground">{{ item.verdict }} · {{ item.queryCount }} 次查询 · {{ time(item.durationMs) }}</small></span>
                <span class="grid grid-cols-[55px_1fr_34px] items-center gap-2 max-md:col-start-2"><small class="text-[10px] text-muted-foreground">问题覆盖</small><i class="h-1.5 overflow-hidden rounded-full bg-secondary"><i class="block h-full rounded-full bg-primary" :style="{ width: pct(item.evidenceRecall) }" /></i><b class="font-mono text-[10px]">{{ pct(item.evidenceRecall) }}</b></span>
                <Badge v-if="item.falseSufficient" variant="destructive" class="max-md:col-start-2">误判充分</Badge>
              </button>
            </div>
          </section>

          <section v-if="detail" class="overflow-hidden rounded-xl border border-border bg-card">
            <header class="flex items-start justify-between gap-4 border-b border-border px-5 py-4"><div><span class="font-mono text-[10px] text-muted-foreground">{{ detail.id }}</span><h2 class="m-0 mt-1 text-base font-semibold leading-6">{{ detail.question }}</h2></div><EvaluationStatusBadge status="completed" :label="detail.verdict" :passed="detail.passed" /></header>
            <div class="grid grid-cols-[.8fr_1.2fr] gap-7 p-5 max-md:grid-cols-1">
              <div><h3 class="m-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">问题覆盖</h3><p v-if="!detail.supportedNeeds.length" class="text-xs text-muted-foreground">不可回答用例：预期系统不判定为充分。</p><p v-for="need in detail.supportedNeeds" :key="need.id" class="flex items-center gap-2 text-sm" :class="need.supported ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'"><component :is="need.supported ? PhCheckCircle : PhXCircle" :size="18" weight="fill" />{{ need.label }}</p><h3 class="m-0 mt-6 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">查询轨迹</h3><ol class="pl-5 text-xs leading-6 text-muted-foreground"><li v-for="query in detail.retrievalQueries" :key="query">{{ query }}</li></ol><p class="border-l-2 border-amber-500/40 pl-3 text-xs leading-5 text-muted-foreground"><strong class="text-foreground">停止原因：</strong>{{ detail.stopReason }}</p></div>
              <div><h3 class="m-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">返回来源</h3><p v-if="!detail.retrieved.length" class="text-xs text-muted-foreground">没有形成可用 Web Source。</p><article v-for="source in detail.retrieved" :key="source.url" class="mt-2 grid grid-cols-[24px_minmax(0,1fr)_28px] gap-2 rounded-lg border p-3" :class="source.relevant ? 'border-emerald-500/30' : 'border-border'"><span class="grid size-6 place-items-center rounded-full bg-secondary font-mono text-[10px]">{{ source.rank }}</span><span class="min-w-0"><strong class="block truncate text-xs">{{ source.title }}</strong><small class="mt-0.5 block text-[10px] text-muted-foreground">{{ source.domain }} · score {{ source.score.toFixed(2) }}<template v-if="source.supportedNeedIds.length"> · 支持 {{ source.supportedNeedIds.join(', ') }}</template></small></span><Button as="a" :href="source.url" target="_blank" rel="noreferrer" variant="ghost" size="icon-sm" aria-label="打开来源"><PhArrowSquareOut :size="17" aria-hidden="true" /></Button></article></div>
            </div>
          </section>
        </template>

        <div v-else-if="!loading && !running" class="grid min-h-72 place-items-center rounded-xl border border-dashed border-border px-5 text-center"><div class="max-w-sm"><PhFlask class="mx-auto text-muted-foreground" :size="28" aria-hidden="true" /><h2 class="m-0 mt-3 text-base font-semibold">运行第一次基线评测</h2><p class="m-0 mt-1 text-sm leading-6 text-muted-foreground">结果会同时显示检索命中、证据精确率、问题覆盖率与误判充分。</p></div></div>
      </div>
    </main>

    <Dialog :open="Boolean(deleteRunTarget)" @update:open="deleteRunTarget = $event ? deleteRunTarget : undefined">
      <DialogContent class="sm:max-w-md"><DialogHeader><div class="mb-1 flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive"><PhTrash :size="19" weight="bold" aria-hidden="true" /></div><DialogTitle>删除联网评测</DialogTitle><DialogDescription>“{{ deleteRunTarget?.name }}”的配置与完整报告将被永久删除，此操作无法撤销。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" :disabled="deleting" @click="deleteRunTarget = undefined">取消</Button><Button variant="destructive" :disabled="deleting" @click="confirmRemoveRun"><PhCircleNotch v-if="deleting" class="animate-spin" aria-hidden="true" />确认删除</Button></DialogFooter></DialogContent>
    </Dialog>

    <Dialog :open="Boolean(deleteCaseTarget)" @update:open="deleteCaseTarget = $event ? deleteCaseTarget : undefined">
      <DialogContent class="sm:max-w-md"><DialogHeader><div class="mb-1 flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive"><PhTrash :size="19" weight="bold" aria-hidden="true" /></div><DialogTitle>删除自定义评测题</DialogTitle><DialogDescription>“{{ deleteCaseTarget?.title }}”将从后续评测题集中永久删除。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" :disabled="deleting" @click="deleteCaseTarget = undefined">取消</Button><Button variant="destructive" :disabled="deleting" @click="confirmRemoveCase"><PhCircleNotch v-if="deleting" class="animate-spin" aria-hidden="true" />确认删除</Button></DialogFooter></DialogContent>
    </Dialog>
  </section>
</template>
