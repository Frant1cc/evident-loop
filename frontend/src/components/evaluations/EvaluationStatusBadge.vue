<script setup lang="ts">
import { computed } from 'vue';

import { Badge } from '@/components/ui/badge';
import type { RagEvaluationStatus, WebEvaluationStatus } from '../../types/evaluations';

const props = defineProps<{
  status: RagEvaluationStatus | WebEvaluationStatus;
  label: string;
  passed?: boolean;
}>();

const tone = computed(() => {
  if (props.status === 'failed') return 'border-destructive/25 bg-destructive/10 text-destructive dark:bg-destructive/20';
  if (props.status === 'queued' || props.status === 'running') return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (props.passed === false) return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
});
</script>

<template>
  <Badge variant="outline" class="h-5 rounded-md px-1.5 font-mono text-[10px] font-semibold" :class="tone">{{ label }}</Badge>
</template>
