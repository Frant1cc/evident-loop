<script setup lang="ts">
import { PhArrowClockwise, PhCircleNotch, PhTrash } from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import EvaluationStatusBadge from './EvaluationStatusBadge.vue';
import type { RagEvaluationStatus, WebEvaluationStatus } from '../../types/evaluations';

export type EvaluationHistoryItem = {
  id: string;
  name: string;
  status: RagEvaluationStatus | WebEvaluationStatus;
  statusLabel: string;
  meta: string;
  passed?: boolean;
};

defineProps<{
  items: EvaluationHistoryItem[];
  activeId?: string;
  loading: boolean;
  title?: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  delete: [id: string];
  refresh: [];
}>();

function canDelete(status: RagEvaluationStatus | WebEvaluationStatus) {
  return status !== 'queued' && status !== 'running';
}
</script>

<template>
  <aside class="app-scrollbar min-h-0 overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground max-lg:hidden" :aria-label="title ?? '评测运行历史'">
    <header class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-sidebar-border bg-sidebar p-3">
      <div class="min-w-0 px-1">
        <p class="m-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">History</p>
        <h2 class="m-0 mt-1 text-sm font-semibold">{{ title ?? '运行记录' }} · {{ items.length }}</h2>
      </div>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button type="button" variant="ghost" size="icon" aria-label="刷新运行历史" @click="emit('refresh')">
            <PhArrowClockwise :size="16" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>刷新运行历史</TooltipContent>
      </Tooltip>
    </header>

    <nav class="space-y-1 p-2" aria-label="评测运行">
      <div
        v-for="item in items"
        :key="item.id"
        class="group flex min-w-0 items-start rounded-lg transition-colors"
        :class="activeId === item.id ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'"
      >
        <button type="button" class="min-w-0 flex-1 cursor-pointer px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring" @click="emit('select', item.id)">
          <span class="flex min-w-0 items-start gap-2">
            <PhCircleNotch v-if="item.status === 'queued' || item.status === 'running'" class="mt-0.5 shrink-0 animate-spin text-amber-600 dark:text-amber-300" :size="13" aria-hidden="true" />
            <span class="line-clamp-2 min-w-0 text-[13px] font-medium leading-5 text-foreground">{{ item.name }}</span>
          </span>
          <span class="mt-1.5 flex items-center gap-2">
            <EvaluationStatusBadge :status="item.status" :label="item.statusLabel" :passed="item.passed" />
            <span class="ml-auto text-[10px] tabular-nums text-muted-foreground">{{ item.meta }}</span>
          </span>
        </button>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              class="mr-1 mt-1.5 shrink-0 text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-20"
              :disabled="!canDelete(item.status)"
              :aria-label="`删除运行：${item.name}`"
              @click="emit('delete', item.id)"
            >
              <PhTrash :size="14" weight="bold" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{{ canDelete(item.status) ? '删除运行' : '运行期间不能删除' }}</TooltipContent>
        </Tooltip>
      </div>

      <div v-if="loading" class="grid gap-2 p-2" aria-label="正在加载运行历史">
        <span v-for="index in 4" :key="index" class="h-16 animate-pulse rounded-lg bg-sidebar-accent motion-reduce:animate-none" />
      </div>
      <p v-else-if="!items.length" class="m-0 px-4 py-10 text-center text-xs leading-5 text-muted-foreground">首次运行后，结果会保存在这里。</p>
    </nav>
  </aside>
</template>
