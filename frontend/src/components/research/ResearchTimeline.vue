<script setup lang="ts">
import { computed } from 'vue';

import type { ResearchStep } from '../../types/research';

const props = defineProps<{
  steps: ResearchStep[];
  selectedStepId?: string;
}>();

const emit = defineEmits<{ select: [step: ResearchStep] }>();

const orderedSteps = computed(() => [...props.steps].sort((a, b) => a.sequence - b.sequence));

function statusClass(status: ResearchStep['status']) {
  if (status === 'error') return 'bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]';
  if (status === 'running') return 'bg-amber-100 text-amber-800';
  return 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]';
}

function statusLabel(status: ResearchStep['status']) {
  return ({ running: '执行中', complete: '已完成', error: '失败' } as const)[status];
}

function stepTypeLabel(type: ResearchStep['type']) {
  return type === 'tool' ? '工具调用' : '模型推理';
}

function stepInputSummary(step: ResearchStep) {
  if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) return undefined;
  const input = step.input as Record<string, unknown>;
  const summary = input.query ?? input.path ?? input.file ?? input.expression;
  return typeof summary === 'string' ? summary : undefined;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}
</script>

<template>
  <section class="min-h-0 overflow-auto">
    <div class="grid content-start gap-3 p-4">
      <button
        v-for="step in orderedSteps"
        :key="step.id"
        type="button"
        class="rounded-md border p-3.5 text-left transition-colors"
        :class="step.id === selectedStepId ? 'border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)]' : 'border-[var(--agent-border)] bg-[var(--agent-surface)] hover:bg-[var(--agent-surface-muted)]'"
        @click="emit('select', step)"
      >
        <div class="flex items-start justify-between gap-2">
          <span class="flex items-center gap-2 text-xs font-semibold text-[var(--agent-text-muted)]"><span class="font-mono">#{{ step.sequence }}</span>{{ stepTypeLabel(step.type) }}</span>
          <span class="rounded px-2 py-0.5 text-[10px] font-bold" :class="statusClass(step.status)">{{ statusLabel(step.status) }}</span>
        </div>
        <p class="m-0 mt-2 text-sm font-bold leading-5 text-[var(--agent-text)]">{{ step.title }}</p>
        <p v-if="stepInputSummary(step)" class="m-0 mt-2 line-clamp-2 rounded-md bg-[var(--agent-surface-muted)] px-2.5 py-2 text-xs font-medium leading-5 text-[var(--agent-text-muted)]">{{ stepInputSummary(step) }}</p>
        <p v-if="step.error" class="m-0 mt-2 rounded-md bg-[var(--agent-error-bg)] px-2.5 py-2 text-xs leading-5 text-[var(--agent-error-text)]">{{ step.error }}</p>
        <p class="m-0 mt-2 font-mono text-[10px] text-[var(--agent-text-muted)]">{{ formatTime(step.startedAt) }}</p>
      </button>
      <p v-if="!orderedSteps.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm leading-6 text-[var(--agent-text-muted)]">等待研究任务开始。</p>
    </div>
  </section>
</template>
