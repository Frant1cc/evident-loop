<script setup lang="ts">
import { computed } from 'vue';
import {
  PhArrowCounterClockwise,
  PhBooks,
  PhFlask,
  PhFlowArrow,
  PhGauge,
  PhSlidersHorizontal
} from '@phosphor-icons/vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

import {
  defaultTabVisibility,
  type ConfigurableTabKey,
  type TabVisibility
} from '../types/navigation';

defineOptions({ name: 'SettingsView' });

const props = defineProps<{
  tabVisibility: TabVisibility;
}>();

const emit = defineEmits<{
  'update:tabVisibility': [visibility: TabVisibility];
}>();

const tabOptions = [
  {
    key: 'research',
    label: '研究工作台',
    description: '组织研究任务、来源、过程和最终结论。',
    icon: PhFlask
  },
  {
    key: 'tasks',
    label: 'Agent 运行时',
    description: '查看任务计划、执行步骤、证据与工具调用。',
    icon: PhFlowArrow
  },
  {
    key: 'evaluations',
    label: '质量评测',
    description: '运行联网检索与 RAG 评测，检查证据和召回质量。',
    icon: PhGauge
  },
  {
    key: 'knowledge',
    label: '知识库',
    description: '管理文档、切片和向量索引。',
    icon: PhBooks
  }
] satisfies Array<{
  key: ConfigurableTabKey;
  label: string;
  description: string;
  icon: unknown;
}>;

const visibleCount = computed(() =>
  tabOptions.filter((tab) => props.tabVisibility[tab.key]).length
);

const isDefault = computed(() =>
  tabOptions.every((tab) => props.tabVisibility[tab.key] === defaultTabVisibility[tab.key])
);

function toggleTab(key: ConfigurableTabKey) {
  emit('update:tabVisibility', {
    ...props.tabVisibility,
    [key]: !props.tabVisibility[key]
  });
}

function restoreDefaults() {
  emit('update:tabVisibility', { ...defaultTabVisibility });
}
</script>

<template>
  <section class="h-full min-h-0 overflow-auto bg-background" aria-label="工作区设置">
    <div class="mx-auto grid w-full max-w-6xl gap-7 px-5 py-7 md:px-8 md:py-9">
      <header class="flex flex-col justify-between gap-5 border-b border-border pb-6 sm:flex-row sm:items-end">
        <div class="max-w-2xl">
          <p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Workspace preferences</p>
          <h1 class="m-0 mt-1.5 text-2xl font-semibold tracking-[-0.035em] text-foreground">设置</h1>
          <p class="m-0 mt-1.5 text-sm leading-6 text-muted-foreground">让顶栏只保留当前工作需要的功能。所有更改都会自动保存到此浏览器。</p>
        </div>
        <Button variant="outline" class="self-start sm:self-auto" :disabled="isDefault" @click="restoreDefaults"><PhArrowCounterClockwise aria-hidden="true" />恢复默认</Button>
      </header>

      <section class="grid items-start gap-6 lg:grid-cols-[250px_minmax(0,1fr)]" aria-labelledby="tab-visibility-title">
        <aside class="grid gap-4 lg:sticky lg:top-7">
          <div class="rounded-xl border border-border bg-card p-5">
            <div class="flex items-center justify-between gap-3"><span class="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground"><PhSlidersHorizontal :size="18" weight="bold" aria-hidden="true" /></span><Badge variant="secondary" class="font-mono tabular-nums">{{ visibleCount }}/{{ tabOptions.length }}</Badge></div>
            <h2 id="tab-visibility-title" class="m-0 mt-5 text-base font-semibold">顶部导航</h2>
            <p class="m-0 mt-2 text-sm leading-6 text-muted-foreground">隐藏暂时不用的工作区，不会删除其中的数据或运行记录。</p>
          </div>
          <div class="rounded-xl border border-dashed border-border px-4 py-3 text-xs leading-5 text-muted-foreground">
            “设置”会始终显示，因此可以随时回来恢复其他页面。
          </div>
        </aside>

        <div class="overflow-hidden rounded-xl border border-border bg-card">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div><h3 class="m-0 text-sm font-semibold">功能页面</h3><p class="m-0 mt-1 text-xs text-muted-foreground">开关生效后，顶栏会立即更新。</p></div>
            <span class="text-xs text-muted-foreground">自动保存</span>
          </div>

          <div class="divide-y divide-border">
            <div v-for="tab in tabOptions" :key="tab.key" class="group flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/35 md:px-5">
              <span class="grid size-10 shrink-0 place-items-center rounded-lg border transition-colors" :class="tabVisibility[tab.key] ? 'border-primary/20 bg-primary/10 text-primary' : 'border-border bg-muted text-muted-foreground'">
                <component :is="tab.icon" :size="19" weight="bold" aria-hidden="true" />
              </span>
              <span class="min-w-0 flex-1"><span class="block text-sm font-semibold text-foreground">{{ tab.label }}</span><span class="mt-1 block text-sm leading-5 text-muted-foreground">{{ tab.description }}</span></span>
              <div class="flex shrink-0 items-center gap-3"><span class="hidden text-xs font-medium text-muted-foreground sm:inline">{{ tabVisibility[tab.key] ? '已显示' : '已隐藏' }}</span><Switch :model-value="tabVisibility[tab.key]" :aria-label="`在导航中显示${tab.label}`" @update:model-value="toggleTab(tab.key)" /></div>
            </div>
          </div>

          <p class="m-0 border-t border-border bg-muted/30 px-5 py-3 text-xs leading-5 text-muted-foreground">固定顺序：研究工作台、Agent 运行时、质量评测、知识库、设置。</p>
        </div>
      </section>
    </div>
  </section>
</template>
