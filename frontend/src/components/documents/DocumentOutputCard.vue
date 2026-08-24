<script setup lang="ts">
import {
  PhDownloadSimple,
  PhEye,
  PhSpinnerGap,
  PhWarningCircle,
  PhFileDoc,
  PhFilePdf
} from '@phosphor-icons/vue';
import { computed } from 'vue';
import type { ArtifactOutput } from '../../types/artifacts';

const props = defineProps<{
  output: ArtifactOutput;
  busy?: boolean;
}>();

const emit = defineEmits<{
  retry: [outputId: string];
  preview: [output: ArtifactOutput];
}>();

const statusText = computed(() => {
  const status = props.output.status;
  if (status === 'completed') return '可下载';
  if (status === 'failed') return props.output.error ?? '失败';
  const label = ({
    pending: '等待中',
    rendering: '渲染中',
    validating: '质检中',
    cancelled: '已取消'
  } as Record<string, string>)[status] ?? status;
  return props.output.progress ? `${label} · ${props.output.progress}` : label;
});

const formatLabel = computed(() => {
  return props.output.format.toUpperCase();
});

const formatIcon = computed(() => {
  if (props.output.format === 'docx') return PhFileDoc;
  if (props.output.format === 'pdf') return PhFilePdf;
  return PhFileDoc;
});

const canRetry = computed(() => {
  return props.output.status === 'failed' || props.output.status === 'cancelled';
});

const canPreview = computed(() => {
  if (props.output.status !== 'completed') return false;
  if (props.output.format === 'pptx') return Boolean(props.output.renderedSpec?.presentation.slides.length);
  return Boolean(props.output.previewUrl || props.output.downloadUrl);
});

const canDownload = computed(() => {
  return props.output.status === 'completed' && props.output.downloadUrl;
});

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <div class="document-output-card grid gap-2">
    <div class="flex flex-wrap items-center gap-2 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2.5 py-2 text-xs">
      <component :is="formatIcon" :size="16" weight="bold" class="text-[var(--agent-text-muted)]" aria-hidden="true" />
      <span class="font-bold uppercase text-[var(--agent-text)]">{{ formatLabel }}</span>
      <span class="text-[var(--agent-text-muted)]" role="status">{{ statusText }}</span>
      <PhSpinnerGap v-if="output.status === 'rendering' || output.status === 'validating'" :size="14" class="animate-spin text-[var(--agent-text-muted)]" aria-hidden="true" />
      <PhWarningCircle v-if="output.status === 'failed'" :size="14" class="text-destructive" aria-hidden="true" />
      <span v-if="output.size" class="text-[10px] text-[var(--agent-text-muted)]">{{ formatFileSize(output.size) }}</span>

      <div class="ml-auto flex items-center gap-2">
        <button
          v-if="canPreview"
          type="button"
          class="inline-flex h-7 items-center gap-1 rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-selected-bg)] disabled:opacity-50"
          :disabled="busy"
          @click="emit('preview', output)"
        >
          <PhEye :size="14" weight="bold" aria-hidden="true" />
          预览
        </button>

        <a
          v-if="canDownload"
          class="inline-flex h-7 items-center gap-1 rounded bg-[var(--agent-selected-bg)] px-2 text-xs font-bold text-[var(--agent-selected-text)] no-underline transition-opacity hover:opacity-80"
          :href="output.downloadUrl"
          :download="output.fileName"
        >
          <PhDownloadSimple :size="14" weight="bold" aria-hidden="true" />
          下载
        </a>

        <button
          v-if="canRetry"
          type="button"
          class="rounded border border-[var(--agent-border)] px-2 py-1 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)] disabled:opacity-50"
          :disabled="busy"
          @click="emit('retry', output.id)"
        >
          重试
        </button>
      </div>
    </div>

    <p v-if="output.diagnostics?.length" class="m-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-5 text-amber-800 dark:text-amber-200" role="alert">
      {{ output.diagnostics.join(' · ') }}
    </p>

    <div v-if="output.provenance?.length" class="text-[10px] text-[var(--agent-text-muted)]">
      {{ output.provenance.map((item) => item.kind === 'authorized_source_asset' ? '授权来源图' : '内置形状').join(' / ') }}
    </div>

    <details v-if="output.renderedSpec" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2.5 py-2 text-[11px] text-[var(--agent-text-muted)]">
      <summary class="cursor-pointer font-semibold">技术详情{{ output.renderedSpecDigest ? `（${output.renderedSpecDigest.slice(0, 12)}…）` : '' }}</summary>
      <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10px]">{{ JSON.stringify(output.renderedSpec, null, 2) }}</pre>
    </details>

  </div>
</template>
