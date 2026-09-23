<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  PhArrowCounterClockwise,
  PhArchive,
  PhBooks,
  PhFlask,
  PhFlowArrow,
  PhGauge,
  PhPlugsConnected,
  PhSlidersHorizontal
} from '@phosphor-icons/vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import McpManagementView from './McpManagementView.vue';
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

type SettingsSection = 'navigation' | 'mcp';

const activeSection = ref<SettingsSection>('navigation');
const contentElement = ref<HTMLElement | null>(null);
const sections = [
  { key: 'navigation', label: '顶部导航', description: '管理功能入口', icon: PhSlidersHorizontal },
  { key: 'mcp', label: 'MCP 连接', description: '管理工具与服务器', icon: PhPlugsConnected }
] satisfies Array<{ key: SettingsSection; label: string; description: string; icon: unknown }>;

const tabOptions = [
  {
    key: 'research',
    label: '研究工作台',
    description: '组织研究任务、来源、过程和最终结论。',
    icon: PhFlask
  },
  {
    key: 'artifacts',
    label: '产物',
    description: '集中查看研究文件与 Agent 最终报告。',
    icon: PhArchive
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

function selectSection(section: SettingsSection) {
  activeSection.value = section;
  contentElement.value?.scrollTo({ top: 0 });
}
</script>

<template>
  <section class="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background md:grid-cols-[232px_minmax(0,1fr)] md:grid-rows-1" aria-label="工作区设置">
    <aside class="min-w-0 border-b border-border bg-card px-3 py-3 md:border-b-0 md:border-r md:px-4 md:py-7">
      <div class="hidden px-3 pb-6 md:block">
        <p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Workspace</p>
        <h1 class="m-0 mt-1 text-xl font-semibold tracking-[-0.03em]">设置</h1>
      </div>
      <nav class="flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-col md:overflow-visible" aria-label="设置导航">
        <button
          v-for="section in sections"
          :key="section.key"
          type="button"
          class="flex min-w-max items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-w-0"
          :class="activeSection === section.key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
          :aria-current="activeSection === section.key ? 'page' : undefined"
          @click="selectSection(section.key)"
        >
          <component :is="section.icon" :size="18" weight="bold" class="shrink-0" aria-hidden="true" />
          <span class="min-w-0"><span class="block text-sm font-semibold">{{ section.label }}</span><span class="hidden text-xs leading-5 opacity-75 md:block">{{ section.description }}</span></span>
        </button>
      </nav>
    </aside>

    <div ref="contentElement" class="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-5 py-7 md:px-8 md:py-9">
      <div v-show="activeSection === 'navigation'" class="mx-auto grid w-full max-w-6xl gap-7">
        <header class="flex flex-col justify-between gap-5 border-b border-border pb-6 sm:flex-row sm:items-end">
          <div class="max-w-2xl">
            <p class="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Workspace preferences</p>
            <h2 class="m-0 mt-1.5 text-2xl font-semibold tracking-[-0.035em] text-foreground">顶部导航</h2>
            <p class="m-0 mt-1.5 text-sm leading-6 text-muted-foreground">让顶栏只保留当前工作需要的功能。更改会自动保存到此浏览器。</p>
          </div>
          <Button variant="outline" class="self-start sm:self-auto" :disabled="isDefault" @click="restoreDefaults"><PhArrowCounterClockwise aria-hidden="true" />恢复默认</Button>
        </header>

        <section class="overflow-hidden rounded-xl border border-border bg-card" aria-labelledby="tab-visibility-title">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div><h3 id="tab-visibility-title" class="m-0 text-sm font-semibold">功能页面</h3><p class="m-0 mt-1 text-xs text-muted-foreground">隐藏暂时不用的页面，不会删除数据或运行记录。</p></div>
            <Badge variant="secondary" class="font-mono tabular-nums">{{ visibleCount }}/{{ tabOptions.length }} 已显示</Badge>
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

          <p class="m-0 border-t border-border bg-muted/30 px-5 py-3 text-xs leading-5 text-muted-foreground">“设置”始终显示。顶栏顺序固定为研究工作台、产物、Agent 运行时、质量评测、知识库、设置。</p>
        </section>
      </div>

      <KeepAlive>
        <McpManagementView v-if="activeSection === 'mcp'" />
      </KeepAlive>
    </div>
  </section>
</template>
