<script setup lang="ts">
import { PhClockCounterClockwise, PhList, PhPlus, PhStack } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentTask, AgentTaskStatus } from '../../types/tasks';
import TaskStatusBadge from './TaskStatusBadge.vue';

defineProps<{
  task: AgentTask;
  completedSteps: number;
  totalSteps: number;
  progress: number;
  duration: string;
  actionsDisabled: boolean;
}>();

const emit = defineEmits<{
  openInspector: [];
  openTasks: [];
  create: [];
}>();

function statusLabel(status: AgentTaskStatus) {
  return ({
    created: '已创建',
    planning: '规划中',
    awaiting_approval: '等待批准',
    running: '执行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已取消'
  } satisfies Record<AgentTaskStatus, string>)[status];
}
</script>

<template>
  <header class="flex min-h-14 items-center gap-4 border-b border-border bg-background px-5 max-md:px-3">
    <div class="flex shrink-0 items-center gap-1 md:hidden">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button type="button" variant="ghost" size="icon" aria-label="打开任务列表" @click="emit('openTasks')">
            <PhList :size="17" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>任务列表</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button type="button" variant="ghost" size="icon" :disabled="actionsDisabled" aria-label="新建任务" @click="emit('create')">
            <PhPlus :size="17" weight="bold" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>新建任务</TooltipContent>
      </Tooltip>
    </div>

    <div v-if="totalSteps" class="flex min-w-0 flex-1 items-center gap-3" aria-label="任务完成进度">
      <div class="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-secondary">
        <div class="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" :style="{ width: `${progress}%` }" />
      </div>
      <span class="shrink-0 font-mono text-[11px] font-medium tabular-nums text-muted-foreground">{{ completedSteps }}/{{ totalSteps }} · {{ progress }}%</span>
    </div>
    <div v-else class="min-w-0 flex-1" />

    <span class="hidden shrink-0 items-center gap-1.5 font-mono text-[11px] font-medium tabular-nums text-muted-foreground sm:flex" :title="task.status === 'running' ? '本次任务已执行时间' : '本次任务执行耗时'">
      <PhClockCounterClockwise :size="14" aria-hidden="true" />
      {{ task.status === 'running' ? '已执行' : '耗时' }} {{ duration }}
    </span>
    <TaskStatusBadge :status="task.status" :label="statusLabel(task.status)" />
    <span class="hidden shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground xl:inline">checkpoint v{{ task.checkpointVersion }}</span>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button type="button" variant="ghost" size="icon" class="lg:hidden" aria-label="打开运行检查器" @click="emit('openInspector')">
          <PhStack :size="17" weight="bold" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">运行检查器</TooltipContent>
    </Tooltip>
  </header>
</template>
