<script setup lang="ts">
import { PhArrowSquareOut, PhEye, PhSpinnerGap } from '@phosphor-icons/vue';
import { computed } from 'vue';
import type { ArtifactOutput, ResearchArtifactGeneration } from '../../types/artifacts';

const props = defineProps<{
  generation: ResearchArtifactGeneration;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'open-workbench': [];
  preview: [output: ArtifactOutput];
  'generate': [];
  'cancel': [];
  'retry': [outputId: string];
}>();

const statusLabel = computed(() => {
  const labels: Record<string, string> = {
    planning: '规划中',
    awaiting_confirmation: '草稿已创建',
    rendering: '渲染中',
    validating: '质检中',
    repairing: '修复中',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
    superseded: '历史草稿'
  };
  return labels[props.generation.status] ?? props.generation.status;
});

const deliverables = computed(() => {
  const items = [];
  const spec = props.generation.spec;

  if (spec.formats.includes('pptx')) {
    items.push({
      type: '演示文稿',
      count: spec.presentation.slides.length,
      unit: '页',
      formats: ['PPTX']
    });
  }

  if (spec.formats.includes('docx') || spec.formats.includes('pdf')) {
    const formats = spec.formats.filter(f => f === 'docx' || f === 'pdf').map(f => f.toUpperCase());
    items.push({
      type: '长篇文档',
      count: spec.longform?.blocks?.length ?? 0,
      unit: '个内容块',
      formats
    });
  }

  return items;
});

const canGenerate = computed(() => {
  return props.generation.status === 'awaiting_confirmation' && !props.generation.stale;
});

const isGenerating = computed(() => {
  return ['rendering', 'validating', 'repairing'].includes(props.generation.status);
});

const hasCompletedOutputs = computed(() => {
  return props.generation.outputs.some(o => o.status === 'completed');
});

const hasFailedOutputs = computed(() => {
  return props.generation.outputs.some(o => o.status === 'failed' || o.status === 'cancelled');
});

function canPreviewOutput(output: ArtifactOutput) {
  if (output.status !== 'completed') return false;
  if (output.format === 'pptx') return Boolean(output.renderedSpec?.presentation.slides.length);
  return Boolean(output.previewUrl || output.downloadUrl);
}
</script>

<template>
  <section
    class="document-status-card grid w-full gap-3 rounded-2xl border border-border bg-card p-3.5 text-card-foreground shadow-xs dark:border-white/[0.06] dark:bg-card/75 dark:shadow-none"
    aria-label="文稿"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <p class="m-0 text-sm font-bold text-[var(--agent-text)]">{{ statusLabel }}</p>
          <span
            v-if="generation.stale"
            class="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-400"
          >
            已失效
          </span>
        </div>
        <h3 class="m-0 mt-1 text-base font-bold text-[var(--agent-text)]">{{ generation.spec.title }}</h3>
        <p class="m-0 mt-0.5 text-xs text-[var(--agent-text-muted)]">v{{ generation.version }}</p>
      </div>

      <button
        type="button"
        class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[var(--agent-selected-bg)] px-3 text-xs font-bold text-[var(--agent-selected-text)] transition-opacity hover:opacity-80"
        @click="emit('open-workbench')"
      >
        <PhArrowSquareOut :size="14" weight="bold" aria-hidden="true" />
        打开工作台
      </button>
    </div>

    <div class="space-y-1.5">
      <div v-for="(item, index) in deliverables" :key="index" class="flex items-center gap-2 text-xs text-[var(--agent-text-muted)]">
        <span class="font-semibold">{{ item.type }}</span>
        <span>·</span>
        <span>{{ item.count }} {{ item.unit }}</span>
        <span>·</span>
        <span class="font-mono font-bold">{{ item.formats.join('、') }}</span>
      </div>
    </div>

    <div v-if="generation.outputs.length" class="grid gap-2 border-t border-[var(--agent-border)] pt-3">
      <div v-for="output in generation.outputs" :key="output.id" class="flex items-center justify-between rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2.5 py-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-bold uppercase text-[var(--agent-text)]">{{ output.format }}</span>
          <PhSpinnerGap v-if="['rendering', 'validating'].includes(output.status)" :size="12" class="animate-spin text-[var(--agent-text-muted)]" aria-hidden="true" />
          <span class="text-xs text-[var(--agent-text-muted)]" role="status">
            {{ output.status === 'completed' ? '可下载' : output.status === 'failed' ? '失败' : output.progress ?? output.status }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="canPreviewOutput(output)"
            type="button"
            class="inline-flex items-center gap-1 text-xs font-bold text-[var(--agent-text)] transition-colors hover:text-[var(--agent-selected-text)]"
            :disabled="busy"
            @click="emit('preview', output)"
          >
            <PhEye :size="13" weight="bold" aria-hidden="true" />
            预览
          </button>
          <a
            v-if="output.status === 'completed' && output.downloadUrl"
            :href="output.downloadUrl"
            :download="output.fileName"
            class="text-xs font-bold text-[var(--agent-selected-text)] no-underline"
          >
            下载
          </a>
          <button
            v-if="output.status === 'failed' || output.status === 'cancelled'"
            type="button"
            class="text-xs font-bold text-[var(--agent-text)] transition-colors hover:text-[var(--agent-selected-text)] disabled:opacity-50"
            :disabled="busy"
            @click="emit('retry', output.id)"
          >
            重试
          </button>
        </div>
      </div>
    </div>

    <div v-if="canGenerate || isGenerating" class="flex items-center justify-end gap-2 border-t border-[var(--agent-border)] pt-3">
      <button
        v-if="isGenerating"
        type="button"
        class="rounded border border-destructive/30 px-3 py-1.5 text-xs font-bold text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-50"
        :disabled="busy"
        @click="emit('cancel')"
      >
        取消生成
      </button>
      <button
        v-else-if="canGenerate"
        type="button"
        class="rounded-md bg-[var(--agent-selected-bg)] px-3 py-1.5 text-xs font-bold text-[var(--agent-selected-text)] transition-opacity hover:opacity-80 disabled:opacity-50"
        :disabled="busy"
        @click="emit('generate')"
      >
        生成{{ generation.spec.formats.map(f => f.toUpperCase()).join('、') }}
      </button>
    </div>

    <div v-if="generation.stale" class="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200" role="alert">
      研究会话已变化，此草稿已失效。请重新生成大纲。
    </div>
  </section>
</template>
