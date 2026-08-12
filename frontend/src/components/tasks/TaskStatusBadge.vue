<script setup lang="ts">
import { computed } from 'vue';

import { Badge } from '@/components/ui/badge';
import type { AgentTaskStatus, PlanStepStatus, ToolExecution } from '../../types/tasks';

type RuntimeStatus = AgentTaskStatus | PlanStepStatus | ToolExecution['status'];

const props = defineProps<{
  status: RuntimeStatus;
  label: string;
}>();

const tone = computed(() => {
  if (props.status === 'failed' || props.status === 'cancelled') {
    return 'border-destructive/25 bg-destructive/10 text-destructive dark:bg-destructive/20';
  }
  if (props.status === 'completed') {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (props.status === 'running' || props.status === 'planning') {
    return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  if (props.status === 'awaiting_approval') {
    return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  }
  return 'border-border bg-muted text-muted-foreground';
});
</script>

<template>
  <Badge variant="outline" class="h-5 rounded-md px-1.5 font-mono text-[10px] font-semibold" :class="tone">
    {{ label }}
  </Badge>
</template>
