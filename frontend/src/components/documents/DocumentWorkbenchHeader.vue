<script setup lang="ts">
import { PhX, PhClockCounterClockwise, PhGear, PhFloppyDisk } from '@phosphor-icons/vue';
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
  if (props.saveState === 'saved') return 'text-green-700 dark:text-green-400';
  if (props.saveState === 'error') return 'text-destructive';
  return 'text-[var(--agent-text-muted)]';
});
</script>

<template>
  <header class="flex h-14 items-center justify-between gap-4 border-b border-[var(--agent-border)] bg-[var(--agent-surface)] px-4">
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <button
        type="button"
        class="grid size-8 shrink-0 place-items-center rounded text-[var(--agent-text-muted)] transition-colors hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]"
        aria-label="关闭工作台"
        @click="emit('close')"
      >
        <PhX :size="20" weight="bold" aria-hidden="true" />
      </button>

      <div class="min-w-0 flex-1">
        <h1 class="m-0 truncate text-sm font-bold text-[var(--agent-text)]" :title="title">{{ title }}</h1>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-[var(--agent-text-muted)]">v{{ version }}</span>
          <span class="text-[var(--agent-text-muted)]">·</span>
          <span :class="saveStateColor" role="status">
            <PhFloppyDisk v-if="saveState === 'saving'" :size="12" class="inline animate-pulse" aria-hidden="true" />
            {{ saveStateLabel }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <button
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]"
        aria-label="版本历史"
        @click="emit('open-versions')"
      >
        <PhClockCounterClockwise :size="14" weight="bold" aria-hidden="true" />
        <span class="max-sm:hidden">版本</span>
      </button>

      <button
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]"
        aria-label="设置"
        @click="emit('open-settings')"
      >
        <PhGear :size="14" weight="bold" aria-hidden="true" />
        <span class="max-sm:hidden">设置</span>
      </button>

      <button
        v-if="editable"
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded bg-[var(--agent-selected-bg)] px-3 text-xs font-bold text-[var(--agent-selected-text)] transition-opacity hover:opacity-80 disabled:opacity-50"
        :disabled="busy || saveState === 'saving'"
        @click="emit('generate')"
      >
        生成
      </button>
    </div>
  </header>
</template>
