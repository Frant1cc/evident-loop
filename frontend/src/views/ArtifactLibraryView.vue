<script setup lang="ts">
import {
  PhArchive,
  PhArrowClockwise,
  PhArrowSquareOut,
  PhCircleNotch,
  PhDownloadSimple,
  PhEye,
  PhFileDoc,
  PhFilePdf,
  PhFilePpt,
  PhFileText,
  PhFlask,
  PhFlowArrow,
  PhMagnifyingGlass,
  PhWarningCircle
} from '@phosphor-icons/vue';
import { computed, onActivated, ref } from 'vue';

import { listAllResearchArtifactGenerations } from '../api/artifacts';
import { listAllAgentArtifacts } from '../api/tasks';
import MarkdownMessage from '../components/conversation/MarkdownMessage.vue';
import DocumentPreviewDialog from '../components/documents/DocumentPreviewDialog.vue';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogHeader, DialogScrollContent, DialogTitle } from '@/components/ui/dialog';
import { AppSelect, type AppSelectOption } from '@/components/ui/select';
import type { ArtifactOutput, ResearchArtifactGeneration } from '../types/artifacts';
import type { AgentArtifactLibraryItem } from '../types/tasks';
import type { AppTabKey } from '../types/navigation';

defineOptions({ name: 'ArtifactLibraryView' });

const emit = defineEmits<{
  'openSource': [tab: AppTabKey];
}>();

type SourceFilter = 'all' | 'research' | 'agent';
type FormatFilter = 'all' | 'pptx' | 'pdf' | 'docx' | 'report';
type StatusFilter = 'all' | 'ready' | 'active' | 'attention';
type LibraryItem =
  | {
      id: string;
      kind: 'research';
      title: string;
      sourceTitle: string;
      updatedAt: string;
      status: ResearchArtifactGeneration['status'];
      generation: ResearchArtifactGeneration;
    }
  | {
      id: string;
      kind: 'agent';
      title: string;
      sourceTitle: string;
      updatedAt: string;
      status: 'completed';
      artifact: AgentArtifactLibraryItem;
    };

const researchGenerations = ref<ResearchArtifactGeneration[]>([]);
const agentArtifacts = ref<AgentArtifactLibraryItem[]>([]);
const loading = ref(false);
const error = ref('');
const query = ref('');
const sourceFilter = ref<SourceFilter>('all');
const formatFilter = ref<FormatFilter>('all');
const statusFilter = ref<StatusFilter>('all');
const previewOutput = ref<ArtifactOutput>();
const previewReport = ref<AgentArtifactLibraryItem>();

const sourceOptions: AppSelectOption[] = [
  { value: 'all', label: '全部来源' },
  { value: 'research', label: '研究工作台' },
  { value: 'agent', label: 'Agent 运行时' }
];
const formatOptions: AppSelectOption[] = [
  { value: 'all', label: '全部格式' },
  { value: 'pptx', label: 'PPTX' },
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'DOCX' },
  { value: 'report', label: 'Agent 报告' }
];
const statusOptions: AppSelectOption[] = [
  { value: 'all', label: '全部状态' },
  { value: 'ready', label: '可用' },
  { value: 'active', label: '处理中' },
  { value: 'attention', label: '需处理' }
];

const items = computed<LibraryItem[]>(() => [
  ...researchGenerations.value
    .filter((generation) => generation.outputs.length > 0)
    .map((generation): LibraryItem => ({
      id: generation.id,
      kind: 'research',
      title: generation.spec.title,
      sourceTitle: generation.snapshot?.conversationTitle || '研究工作台',
      updatedAt: generation.updatedAt,
      status: generation.status,
      generation
    })),
  ...agentArtifacts.value.map((artifact): LibraryItem => ({
    id: artifact.id,
    kind: 'agent',
    title: artifact.title,
    sourceTitle: artifact.taskGoal,
    updatedAt: artifact.updatedAt,
    status: 'completed',
    artifact
  }))
].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));

const filteredItems = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase();
  return items.value.filter((item) => {
    if (sourceFilter.value !== 'all' && item.kind !== sourceFilter.value) return false;
    if (formatFilter.value !== 'all') {
      if (item.kind === 'agent') return formatFilter.value === 'report';
      if (!item.generation.outputs.some((output) => output.format === formatFilter.value)) return false;
    }
    if (statusFilter.value !== 'all' && statusGroup(item) !== statusFilter.value) return false;
    if (!normalizedQuery) return true;
    return `${item.title} ${item.sourceTitle}`.toLocaleLowerCase().includes(normalizedQuery);
  });
});

const readyCount = computed(() => items.value.filter((item) => statusGroup(item) === 'ready').length);
const fileCount = computed(() => researchGenerations.value.reduce(
  (count, generation) => count + generation.outputs.filter((output) => output.status === 'completed').length,
  0
));
const activeCount = computed(() => items.value.filter((item) => statusGroup(item) === 'active').length);

onActivated(load);

async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  const [researchResult, agentResult] = await Promise.allSettled([
    listAllResearchArtifactGenerations(),
    listAllAgentArtifacts()
  ]);
  if (researchResult.status === 'fulfilled') researchGenerations.value = researchResult.value.generations;
  if (agentResult.status === 'fulfilled') agentArtifacts.value = agentResult.value.artifacts;
  if (researchResult.status === 'rejected' && agentResult.status === 'rejected') {
    error.value = '产物列表暂时无法加载，请检查服务后重试。';
  } else if (researchResult.status === 'rejected' || agentResult.status === 'rejected') {
    error.value = '部分产物未能同步，当前显示其余可用内容。';
  }
  loading.value = false;
}

function statusGroup(item: LibraryItem): Exclude<StatusFilter, 'all'> {
  if (item.kind === 'agent' || item.status === 'completed') return 'ready';
  if (['planning', 'rendering', 'validating', 'repairing'].includes(item.status)) return 'active';
  return 'attention';
}

function statusText(item: LibraryItem) {
  if (item.kind === 'agent') return '可阅读';
  return ({
    planning: '规划中',
    awaiting_confirmation: item.generation.stale ? '内容已更新' : '等待确认',
    rendering: '生成中',
    validating: '质量检查',
    repairing: '自动修复',
    completed: '已完成',
    partial: '部分完成',
    failed: '生成失败',
    cancelled: '已取消',
    superseded: '历史草稿'
  } as Record<string, string>)[item.status] ?? item.status;
}

function statusClass(item: LibraryItem) {
  const group = statusGroup(item);
  if (group === 'ready') return 'border-border bg-muted text-muted-foreground';
  if (group === 'active') return 'border-indigo-600/20 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300';
  return 'border-rose-600/20 bg-rose-500/10 text-rose-700 dark:text-rose-300';
}

function sourceClass(item: LibraryItem) {
  return item.kind === 'research'
    ? 'border-teal-600/20 bg-teal-500/10 text-teal-700 dark:text-teal-300'
    : 'border-violet-600/20 bg-violet-500/10 text-violet-700 dark:text-violet-300';
}

function formatIcon(format: ArtifactOutput['format']) {
  if (format === 'pdf') return PhFilePdf;
  if (format === 'pptx') return PhFilePpt;
  return PhFileDoc;
}

function formatClass(format: ArtifactOutput['format']) {
  if (format === 'pdf') return 'border-red-600/15 bg-red-500/8 text-red-700 dark:text-red-300';
  if (format === 'pptx') return 'border-orange-600/15 bg-orange-500/8 text-orange-700 dark:text-orange-300';
  return 'border-blue-600/15 bg-blue-500/8 text-blue-700 dark:text-blue-300';
}

function outputStatusText(output: ArtifactOutput) {
  return ({
    pending: '等待中',
    rendering: '生成中',
    validating: '检查中',
    completed: '可下载',
    failed: '失败',
    cancelled: '已取消'
  } as Record<string, string>)[output.status] ?? output.status;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatSize(value?: number) {
  if (value === undefined) return '';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <section class="artifact-library h-full min-h-0 min-w-0 w-full max-w-full overflow-auto bg-background" aria-label="产物中心">
    <div class="mx-auto grid min-w-0 w-full max-w-7xl gap-6 px-4 py-6 md:px-8 md:py-8">
      <header class="grid gap-5 border-b border-border pb-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div class="max-w-2xl">
          <div class="mb-3 flex items-center gap-2 text-muted-foreground">
            <span class="grid size-7 place-items-center rounded-md border border-border bg-card"><PhArchive :size="15" weight="bold" aria-hidden="true" /></span>
            <span class="font-mono text-[10px] font-semibold uppercase tracking-[0.18em]">Deliverable archive</span>
          </div>
          <h1 class="m-0 text-3xl font-semibold tracking-[-0.045em] text-foreground">产物</h1>
          <p class="m-0 mt-2 text-sm leading-6 text-muted-foreground">汇集研究生成的交付文件与 Agent 最终报告，在一个地方完成检查、预览和下载。</p>
        </div>

        <div class="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-xl border border-border bg-card">
          <div class="min-w-20 px-4 py-3"><p class="m-0 font-mono text-xl font-semibold tabular-nums">{{ readyCount }}</p><p class="m-0 mt-0.5 text-[11px] text-muted-foreground">可用产物</p></div>
          <div class="min-w-20 px-4 py-3"><p class="m-0 font-mono text-xl font-semibold tabular-nums">{{ fileCount }}</p><p class="m-0 mt-0.5 text-[11px] text-muted-foreground">交付文件</p></div>
          <div class="min-w-20 px-4 py-3"><p class="m-0 font-mono text-xl font-semibold tabular-nums">{{ activeCount }}</p><p class="m-0 mt-0.5 text-[11px] text-muted-foreground">处理中</p></div>
        </div>
      </header>

      <div class="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-3 lg:grid-cols-[minmax(260px,1fr)_repeat(3,auto)_auto]">
        <label class="relative min-w-0">
          <span class="sr-only">搜索产物</span>
          <PhMagnifyingGlass class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" :size="15" aria-hidden="true" />
          <input v-model="query" type="search" placeholder="搜索标题或来源…" class="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:ring-3 focus:ring-ring/20" />
        </label>
        <AppSelect :model-value="sourceFilter" :options="sourceOptions" label="来源筛选" class="w-full lg:w-36" @update:model-value="sourceFilter = $event as SourceFilter" />
        <AppSelect :model-value="formatFilter" :options="formatOptions" label="格式筛选" class="w-full lg:w-32" @update:model-value="formatFilter = $event as FormatFilter" />
        <AppSelect :model-value="statusFilter" :options="statusOptions" label="状态筛选" class="w-full lg:w-32" @update:model-value="statusFilter = $event as StatusFilter" />
        <Button variant="outline" class="h-9 w-full lg:w-auto" :disabled="loading" @click="load"><PhCircleNotch v-if="loading" class="animate-spin" aria-hidden="true" /><PhArrowClockwise v-else aria-hidden="true" />刷新</Button>
      </div>

      <div v-if="error" class="flex items-center gap-2 rounded-lg border border-amber-600/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"><PhWarningCircle :size="17" weight="fill" aria-hidden="true" />{{ error }}</div>

      <div v-if="loading && !items.length" class="grid min-h-64 place-items-center rounded-xl border border-dashed border-border">
        <div class="grid justify-items-center gap-3 text-muted-foreground"><PhCircleNotch class="animate-spin" :size="24" aria-hidden="true" /><p class="m-0 text-sm">正在整理产物档案…</p></div>
      </div>

      <div v-else-if="!filteredItems.length" class="grid min-h-64 place-items-center rounded-xl border border-dashed border-border bg-muted/15 p-6 text-center">
        <div class="max-w-sm"><span class="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-card text-muted-foreground"><PhArchive :size="23" weight="bold" aria-hidden="true" /></span><h2 class="m-0 mt-4 text-base font-semibold">{{ items.length ? '没有符合条件的产物' : '还没有产物' }}</h2><p class="m-0 mt-1.5 text-sm leading-6 text-muted-foreground">{{ items.length ? '调整搜索词或筛选条件后再试。' : '在研究工作台生成文件，或在 Agent 运行时生成最终报告后，它们会出现在这里。' }}</p></div>
      </div>

      <ol v-else class="m-0 grid min-w-0 list-none gap-3 p-0">
        <li v-for="(item, index) in filteredItems" :key="`${item.kind}:${item.id}`" class="artifact-row group overflow-hidden rounded-xl border border-border bg-card" :style="{ '--row-index': index }">
          <article class="min-w-0">
            <div class="grid gap-4 p-4 md:p-5">
              <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
                <span class="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted text-muted-foreground">
                  <PhFlask v-if="item.kind === 'research'" :size="19" weight="bold" aria-hidden="true" />
                  <PhFileText v-else :size="19" weight="bold" aria-hidden="true" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <h2 class="m-0 min-w-0 truncate text-base font-semibold tracking-[-0.018em]" :title="item.title">{{ item.title }}</h2>
                    <span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold" :class="sourceClass(item)">
                      <PhFlask v-if="item.kind === 'research'" :size="10" weight="bold" aria-hidden="true" />
                      <PhFlowArrow v-else :size="10" weight="bold" aria-hidden="true" />
                      {{ item.kind === 'research' ? '研究产物' : 'Agent 报告' }}
                    </span>
                    <span class="rounded-full border px-2 py-0.5 text-[10px] font-semibold" :class="statusClass(item)">{{ statusText(item) }}</span>
                    <span v-if="item.kind === 'research'" class="font-mono text-[10px] text-muted-foreground">V{{ item.generation.version }}</span>
                  </div>
                  <button type="button" class="mt-1.5 inline-flex max-w-full items-center gap-1.5 p-0 text-left text-xs text-muted-foreground transition-colors hover:text-foreground" @click="emit('openSource', item.kind === 'research' ? 'research' : 'tasks')">
                    <PhFlask v-if="item.kind === 'research'" :size="12" aria-hidden="true" /><PhFlowArrow v-else :size="12" aria-hidden="true" />
                    <span class="truncate">{{ item.sourceTitle }}</span><PhArrowSquareOut :size="11" aria-hidden="true" />
                  </button>
                </div>
                <time class="shrink-0 font-mono text-[10px] text-muted-foreground" :datetime="item.updatedAt">{{ formatDate(item.updatedAt) }}</time>
              </div>

              <div v-if="item.kind === 'research'" class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <div v-for="output in item.generation.outputs" :key="output.id" class="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
                  <span class="grid size-8 shrink-0 place-items-center rounded-md border" :class="formatClass(output.format)"><component :is="formatIcon(output.format)" :size="17" weight="fill" aria-hidden="true" /></span>
                  <div class="min-w-0 flex-1"><p class="m-0 truncate text-xs font-semibold" :title="output.fileName">{{ output.fileName || output.format.toUpperCase() }}</p><p class="m-0 mt-0.5 text-[10px] text-muted-foreground">{{ outputStatusText(output) }}<template v-if="output.size"> · {{ formatSize(output.size) }}</template></p></div>
                  <Button v-if="output.status === 'completed'" variant="ghost" size="icon-sm" aria-label="预览文件" @click="previewOutput = output"><PhEye aria-hidden="true" /></Button>
                  <Button v-if="output.status === 'completed' && output.downloadUrl" as-child variant="ghost" size="icon-sm"><a :href="output.downloadUrl" :download="output.fileName" aria-label="下载文件"><PhDownloadSimple aria-hidden="true" /></a></Button>
                </div>
                <p v-if="!item.generation.outputs.length" class="m-0 rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground sm:col-span-2 xl:col-span-3">产物大纲已保存，确认后会在这里显示交付文件。</p>
              </div>

              <div v-else class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-3">
                <div class="flex min-w-0 items-center gap-3"><span class="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground"><PhFileText :size="16" weight="fill" aria-hidden="true" /></span><div class="min-w-0"><p class="m-0 text-xs font-semibold">Agent 最终报告</p><p class="m-0 mt-0.5 text-[10px] text-muted-foreground">Markdown · 可直接阅读</p></div></div>
                <Button variant="outline" size="sm" @click="previewReport = item.artifact"><PhEye aria-hidden="true" />阅读报告</Button>
              </div>
            </div>
          </article>
        </li>
      </ol>
    </div>

    <DocumentPreviewDialog :output="previewOutput" @close="previewOutput = undefined" />

    <Dialog :open="Boolean(previewReport)" @update:open="(open) => { if (!open) previewReport = undefined; }">
      <DialogScrollContent class="h-[min(88dvh,900px)] w-[calc(100vw-2rem)] min-w-0 max-w-4xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader class="min-w-0 border-b border-border px-6 py-5 pr-14 text-left">
          <p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Agent final report</p>
          <DialogTitle class="mt-1 text-xl tracking-[-0.025em]">{{ previewReport?.title }}</DialogTitle>
          <DialogDescription class="mt-1 line-clamp-2">{{ previewReport?.taskGoal }}</DialogDescription>
        </DialogHeader>
        <article v-if="previewReport" class="report-body min-h-0 min-w-0 max-w-full overflow-x-hidden overflow-y-auto px-6 py-6 md:px-8"><MarkdownMessage class="report-markdown" :content="previewReport.content" /></article>
      </DialogScrollContent>
    </Dialog>
  </section>
</template>

<style scoped>
.artifact-row {
  animation: artifact-row-in 320ms ease-out both;
  animation-delay: calc(min(var(--row-index), 8) * 35ms);
  transition: border-color 160ms ease, transform 160ms ease;
}

.artifact-row:hover {
  border-color: color-mix(in oklch, var(--foreground), transparent 76%);
  transform: translateY(-1px);
}

.report-body :deep(.report-markdown),
.report-body :deep(.markdown-segment),
.report-body :deep(.markdown-code-block) {
  min-width: 0;
  max-width: 100%;
}

.report-body :deep(img) {
  max-width: 100%;
  height: auto;
}

.report-body :deep(a),
.report-body :deep(code:not(pre code)) {
  overflow-wrap: anywhere;
  word-break: break-word;
}

@keyframes artifact-row-in {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .artifact-row { animation: none; transition: none; }
}
</style>
