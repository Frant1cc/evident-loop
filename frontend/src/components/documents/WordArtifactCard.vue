<script setup lang="ts">
import {
  PhClockCountdown,
  PhDownloadSimple,
  PhEye,
  PhFileDoc
} from '@phosphor-icons/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import type { WordArtifact } from '../../types/artifacts';

const props = defineProps<{
  artifact: WordArtifact;
}>();

const emit = defineEmits<{
  preview: [artifact: WordArtifact];
}>();

const now = ref(Date.now());
let clock: ReturnType<typeof window.setInterval> | undefined;

const expired = computed(() => Date.parse(props.artifact.expiresAt) <= now.value);
const expiryLabel = computed(() => {
  if (expired.value) return '已过期';
  return `有效至 ${new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(props.artifact.expiresAt))}`;
});

onMounted(() => {
  clock = window.setInterval(() => {
    now.value = Date.now();
  }, 60_000);
});

onBeforeUnmount(() => {
  if (clock) window.clearInterval(clock);
});

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <section
    class="word-artifact-card mt-3 grid overflow-hidden rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface-muted)]"
    :class="{ 'opacity-70': expired }"
    aria-label="Word 文档"
  >
    <div class="flex min-w-0 items-center gap-3 px-3.5 py-3">
      <span class="grid size-10 shrink-0 place-items-center rounded-md bg-[#185ABD] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]">
        <PhFileDoc :size="22" weight="fill" aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="m-0 truncate text-sm font-bold text-[var(--agent-text)]" :title="artifact.fileName">
          {{ artifact.fileName }}
        </p>
        <div class="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--agent-text-muted)]">
          <span>DOCX · {{ formatFileSize(artifact.size) }}</span>
          <span class="inline-flex items-center gap-1" :class="{ 'text-[var(--agent-error-text)]': expired }">
            <PhClockCountdown :size="12" aria-hidden="true" />
            {{ expiryLabel }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex items-center justify-end gap-2 border-t border-[var(--agent-border)] px-3 py-2">
      <button
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 text-xs font-bold text-[var(--agent-text)] transition-colors hover:border-[var(--agent-selected-border)] hover:bg-[var(--agent-selected-bg)] disabled:cursor-not-allowed disabled:opacity-45"
        :disabled="expired"
        @click="emit('preview', artifact)"
      >
        <PhEye :size="15" weight="bold" aria-hidden="true" />
        预览
      </button>
      <a
        v-if="!expired"
        class="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--agent-selected-bg)] px-3 text-xs font-bold text-[var(--agent-selected-text)] no-underline transition-opacity hover:opacity-80"
        :href="artifact.downloadUrl"
        :download="artifact.fileName"
      >
        <PhDownloadSimple :size="15" weight="bold" aria-hidden="true" />
        下载
      </a>
      <span
        v-else
        class="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-md bg-[var(--agent-surface)] px-3 text-xs font-bold text-[var(--agent-text-muted)]"
      >
        <PhDownloadSimple :size="15" aria-hidden="true" />
        已失效
      </span>
    </div>
  </section>
</template>
