<script setup lang="ts">
import {
  PhArrowLeft,
  PhCheckCircle,
  PhCircleNotch,
  PhClockCounterClockwise,
  PhFileText,
  PhGear,
  PhWarningCircle
} from '@phosphor-icons/vue';
import { computed } from 'vue';
import type { DraftSaveState } from './documentEditor';

const props = defineProps<{
  title: string;
  version: number;
  saveState: DraftSaveState;
  editable?: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'open-settings': [];
  'open-versions': [];
  generate: [];
}>();

const saveStateLabel = computed(() => {
  const labels: Record<DraftSaveState, string> = {
    saved: '已保存',
    dirty: '有未保存修改',
    saving: '保存中',
    error: '保存失败'
  };
  return labels[props.saveState];
});

const saveStateColor = computed(() => {
  if (props.saveState === 'saved') return 'text-emerald-700 dark:text-emerald-400';
  if (props.saveState === 'error') return 'bg-destructive/10 text-destructive';
  if (props.saveState === 'dirty') return 'bg-amber-500/10 text-amber-800 dark:text-amber-300';
  return 'text-[var(--agent-text-muted)]';
});
</script>

<template>
  <header class="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 sm:px-4">
    <div class="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <button
        type="button"
        class="grid size-9 shrink-0 place-items-center rounded-md text-[var(--agent-text-muted)] transition-[background-color,color,transform] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)]"
        aria-label="返回研究工作台"
        title="返回研究工作台"
        @click="emit('close')"
      >
        <PhArrowLeft :size="19" weight="bold" aria-hidden="true" />
      </button>

      <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--agent-primary)] text-[var(--agent-primary-text)] max-sm:hidden">
        <PhFileText :size="18" weight="fill" aria-hidden="true" />
      </div>

      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        <div class="min-w-0">
          <h1 class="m-0 truncate text-sm font-semibold tracking-[-0.01em] text-[var(--agent-text)]" :title="title">{{ title }}</h1>
          <p class="m-0 mt-0.5 text-[10px] text-[var(--agent-text-muted)]">草稿版本 {{ version }}</p>
        </div>
        <span class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium" :class="saveStateColor" role="status">
          <PhCircleNotch v-if="saveState === 'saving'" :size="11" class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <PhWarningCircle v-else-if="saveState === 'error' || saveState === 'dirty'" :size="11" weight="fill" aria-hidden="true" />
          <PhCheckCircle v-else :size="11" weight="fill" aria-hidden="true" />
          <span class="max-sm:hidden">{{ saveStateLabel }}</span>
        </span>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1.5 sm:gap-2">
      <button
        type="button"
        class="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-[var(--agent-text-muted)] transition-[background-color,color,transform] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)] sm:px-3"
        aria-label="版本历史"
        title="版本历史"
        @click="emit('open-versions')"
      >
        <PhClockCounterClockwise :size="16" weight="bold" aria-hidden="true" />
        <span class="max-md:hidden">版本</span>
      </button>

      <button
        type="button"
        class="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-[var(--agent-text-muted)] transition-[background-color,color,transform] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)] sm:px-3"
        aria-label="设置"
        title="设置"
        @click="emit('open-settings')"
      >
        <PhGear :size="16" weight="bold" aria-hidden="true" />
        <span class="max-md:hidden">设置</span>
      </button>

      <button
        v-if="editable"
        type="button"
        class="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--agent-primary)] px-3 text-xs font-semibold text-[var(--agent-primary-text)] shadow-sm transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)] sm:px-4"
        :disabled="busy || saveState === 'saving'"
        aria-keyshortcuts="Control+Enter Meta+Enter"
        title="生成文件（⌘ Enter）"
        @click="emit('generate')"
      >
        生成文件
      </button>
    </div>
  </header>
</template>
