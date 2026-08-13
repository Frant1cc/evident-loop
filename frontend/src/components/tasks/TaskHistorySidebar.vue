<script setup lang="ts">
import { PhCaretDoubleLeft, PhCircleNotch, PhPlus, PhTrash } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentTask, AgentTaskStatus } from '../../types/tasks';
import TaskStatusBadge from './TaskStatusBadge.vue';

const props = defineProps<{
  tasks: AgentTask[];
  activeTaskId?: string;
  runningTaskId?: string;
  compact: boolean;
  actionsDisabled: boolean;
  selectionDisabled: boolean;
  mobile?: boolean;
}>();

const emit = defineEmits<{
  create: [];
  select: [taskId: string];
  delete: [task: AgentTask];
  toggle: [];
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

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  const today = new Date();
  return new Intl.DateTimeFormat('zh-CN', date.toDateString() === today.toDateString()
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric' }
  ).format(date);
}

function canDelete(task: AgentTask) {
  return !props.actionsDisabled && (task.status !== 'running' || task.id !== props.runningTaskId);
}
</script>

<template>
  <aside
    class="grid h-full min-h-0 min-w-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    :class="[compact ? 'grid-rows-[auto_1fr_auto] gap-2 p-2' : 'grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-3', mobile ? '' : 'max-md:hidden']"
    aria-label="Agent 任务列表"
  >
    <div v-if="compact" class="grid content-start justify-items-center gap-2">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button type="button" variant="ghost" size="icon" aria-label="展开任务栏" @click="emit('toggle')">
            <PhCaretDoubleLeft :size="17" class="rotate-180" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">展开任务栏</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button type="button" variant="secondary" size="icon" :disabled="actionsDisabled" aria-label="新建任务" @click="emit('create')">
            <PhPlus :size="17" weight="bold" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">新建任务</TooltipContent>
      </Tooltip>
    </div>

    <div v-else class="grid min-w-0 gap-3">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0 px-1">
          <p class="m-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Workspace</p>
          <h2 class="m-0 mt-1 text-sm font-semibold">Agent 任务</h2>
        </div>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="收起任务栏" @click="emit('toggle')">
              <PhCaretDoubleLeft :size="16" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>收起任务栏</TooltipContent>
        </Tooltip>
      </div>
      <Button variant="secondary" size="lg" class="w-full justify-start" :disabled="actionsDisabled" @click="emit('create')">
        <PhPlus :size="16" weight="bold" aria-hidden="true" />
        新建任务
      </Button>
    </div>

    <nav v-if="!compact" class="app-scrollbar min-h-0 space-y-1 overflow-y-auto overscroll-contain" aria-label="Agent 任务">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="group flex min-w-0 items-start rounded-lg transition-colors"
        :class="task.id === activeTaskId ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'"
      >
        <button
          type="button"
          class="min-w-0 flex-1 cursor-pointer px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          :disabled="selectionDisabled"
          :title="task.goal"
          @click="emit('select', task.id)"
        >
          <span class="line-clamp-2 text-[13px] font-medium leading-5 text-foreground">{{ task.goal }}</span>
          <span class="mt-1.5 flex min-w-0 items-center gap-1.5">
            <PhCircleNotch v-if="task.id === runningTaskId" class="shrink-0 animate-spin text-amber-600 dark:text-amber-300" :size="12" aria-hidden="true" />
            <TaskStatusBadge :status="task.status" :label="statusLabel(task.status)" />
            <span class="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{{ formatUpdatedAt(task.updatedAt) }}</span>
          </span>
        </button>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              class="mr-1 mt-1.5 shrink-0 text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-20"
              :disabled="!canDelete(task)"
              :aria-label="`删除任务：${task.goal}`"
              @click="emit('delete', task)"
            >
              <PhTrash :size="14" weight="bold" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{{ task.id === runningTaskId ? '任务运行期间不能删除' : '删除任务' }}</TooltipContent>
        </Tooltip>
      </div>

      <div v-if="!tasks.length" class="grid place-items-center px-3 py-10 text-center text-muted-foreground">
        <p class="m-0 text-xs leading-5">创建第一个任务，让 Agent 按计划收集和验证证据。</p>
      </div>
    </nav>

    <div v-if="compact" aria-hidden="true" />
    <div v-if="compact" class="grid content-start justify-items-center border-t border-sidebar-border pt-2">
      <span class="h-5 rounded-full bg-sidebar-accent px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-muted-foreground" :aria-label="`${tasks.length} 个任务`">{{ tasks.length }}</span>
    </div>
    <p v-else class="m-0 border-t border-sidebar-border px-1 pt-3 text-[11px] leading-4 text-muted-foreground">
      任务、检查点与证据链会自动保存
    </p>
  </aside>
</template>
