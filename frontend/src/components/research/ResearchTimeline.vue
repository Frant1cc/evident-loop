<script setup lang="ts">
import { computed } from 'vue';

import { Badge } from '@/components/ui/badge';
import type { ResearchStep } from '../../types/research';

const props = defineProps<{
  steps: ResearchStep[];
  selectedStepId?: string;
}>();

const emit = defineEmits<{ select: [step: ResearchStep] }>();

const orderedSteps = computed(() => [...props.steps].sort((a, b) => a.sequence - b.sequence));

function statusVariant(status: ResearchStep['status']) {
  if (status === 'error') return 'destructive' as const;
  if (status === 'running') return 'secondary' as const;
  return 'outline' as const;
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
  <section class="app-scrollbar min-h-0 overflow-auto">
    <ol class="m-0 grid list-none content-start gap-1.5 p-3">
      <li v-for="step in orderedSteps" :key="step.id">
        <button
          type="button"
          class="w-full rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="[
            step.id === selectedStepId ? 'border-border bg-muted' : 'border-border bg-background hover:bg-muted',
            step.status === 'running' ? 'animate-pulse motion-reduce:animate-none' : ''
          ]"
          @click="emit('select', step)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-2 text-[11px] font-medium text-muted-foreground">
              <span class="font-mono tabular-nums">#{{ step.sequence }}</span>
              <span class="truncate">{{ stepTypeLabel(step.type) }}</span>
            </span>
            <Badge :variant="statusVariant(step.status)" class="shrink-0">{{ statusLabel(step.status) }}</Badge>
          </div>
          <p class="m-0 mt-1.5 text-sm font-medium leading-5 text-foreground">{{ step.title }}</p>
          <p v-if="stepInputSummary(step)" class="m-0 mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{{ stepInputSummary(step) }}</p>
          <p v-if="step.error" class="m-0 mt-1.5 line-clamp-2 text-xs leading-5 text-destructive">{{ step.error }}</p>
          <p class="m-0 mt-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">{{ formatTime(step.startedAt) }}</p>
        </button>
      </li>
      <li v-if="!orderedSteps.length" class="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm leading-6 text-muted-foreground">
        等待研究任务开始。
      </li>
    </ol>
  </section>
</template>
