<script setup lang="ts">
import { PhCaretDoubleLeft, PhCaretDoubleRight } from '@phosphor-icons/vue';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type TaskInspectorTab = 'events' | 'reviews' | 'evidence' | 'tools' | 'checkpoint';

const props = defineProps<{
  collapsed: boolean;
  mobileOpen: boolean;
  eventCount: number;
  reviewCount: number;
  claimCount: number;
  toolCount: number;
}>();

const activeTab = defineModel<TaskInspectorTab>('activeTab', { required: true });

const emit = defineEmits<{
  toggle: [];
  'update:mobileOpen': [value: boolean];
}>();

const tabs: Array<{ key: TaskInspectorTab; label: string; count?: 'events' | 'reviews' | 'claims' | 'tools' }> = [
  { key: 'events', label: '事件', count: 'events' },
  { key: 'reviews', label: '审查', count: 'reviews' },
  { key: 'evidence', label: '证据', count: 'claims' },
  { key: 'tools', label: '工具', count: 'tools' },
  { key: 'checkpoint', label: '状态' }
];

function countFor(key?: 'events' | 'reviews' | 'claims' | 'tools') {
  if (key === 'events') return props.eventCount;
  if (key === 'reviews') return props.reviewCount;
  if (key === 'claims') return props.claimCount;
  if (key === 'tools') return props.toolCount;
  return undefined;
}
</script>

<template>
  <aside v-if="collapsed" class="grid min-h-0 min-w-0 content-start justify-items-center border-l border-border bg-card p-2 max-lg:hidden">
    <Tooltip>
      <TooltipTrigger as-child>
        <Button type="button" variant="ghost" size="icon" aria-label="展开运行检查器" @click="emit('toggle')">
          <PhCaretDoubleLeft :size="17" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">展开运行检查器</TooltipContent>
    </Tooltip>
  </aside>

  <aside v-else class="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] border-l border-border bg-card max-lg:hidden" aria-label="运行检查器">
    <Tabs v-model="activeTab" class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0">
      <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <TabsList class="h-9 min-w-0 flex-1">
          <TabsTrigger v-for="tab in tabs" :key="tab.key" :value="tab.key" class="h-8 min-w-0 gap-1 px-1 text-[11px]">
            <span>{{ tab.label }}</span>
            <Badge v-if="countFor(tab.count) !== undefined" variant="secondary" class="hidden h-4 min-w-4 rounded px-1 font-mono text-[9px] tabular-nums 2xl:inline-flex">{{ countFor(tab.count) }}</Badge>
          </TabsTrigger>
        </TabsList>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button type="button" variant="ghost" size="icon-sm" class="shrink-0" aria-label="收起运行检查器" @click="emit('toggle')">
              <PhCaretDoubleRight :size="16" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">收起运行检查器</TooltipContent>
        </Tooltip>
      </header>

      <div class="min-h-0">
        <TabsContent v-for="tab in tabs" :key="tab.key" :value="tab.key" class="m-0 h-full">
          <div class="app-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain p-4">
            <slot :name="tab.key" />
          </div>
        </TabsContent>
      </div>
    </Tabs>
  </aside>

  <Dialog :open="mobileOpen" @update:open="emit('update:mobileOpen', $event)">
    <DialogContent class="grid h-[min(88dvh,760px)] max-w-[calc(100%-1rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-2xl lg:hidden">
      <DialogHeader class="border-b border-border px-4 py-3 pr-12">
        <DialogTitle>运行检查器</DialogTitle>
        <DialogDescription>查看事件、证据审查、工具调用和检查点。</DialogDescription>
      </DialogHeader>
      <Tabs v-model="activeTab" class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0">
        <TabsList class="mx-3 mt-3 h-10">
          <TabsTrigger v-for="tab in tabs" :key="tab.key" :value="tab.key" class="h-9 min-w-0 px-1 text-[11px]">
            {{ tab.label }}
          </TabsTrigger>
        </TabsList>
        <div class="min-h-0">
          <TabsContent v-for="tab in tabs" :key="tab.key" :value="tab.key" class="m-0 h-full">
            <div class="app-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain p-4">
              <slot :name="tab.key" />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
