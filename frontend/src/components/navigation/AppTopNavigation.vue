<script setup lang="ts">
import {
  PhBooks,
  PhArchive,
  PhFlask,
  PhFlowArrow,
  PhGauge,
  PhGear,
  PhPlugsConnected,
  PhMoon,
  PhSparkle,
  PhSun
} from '@phosphor-icons/vue';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useColorTheme } from '../../composables/useColorTheme';
import type { AppTabKey, TabVisibility } from '../../types/navigation';

const props = defineProps<{
  activeTab: AppTabKey;
  tabVisibility: TabVisibility;
}>();

const emit = defineEmits<{
  change: [tab: AppTabKey];
}>();

const tabs = [
  { key: 'research', label: '研究工作台', icon: PhFlask },
  { key: 'artifacts', label: '产物', icon: PhArchive },
  { key: 'tasks', label: 'Agent 运行时', icon: PhFlowArrow },
  { key: 'evaluations', label: '质量评测', icon: PhGauge },
  { key: 'knowledge', label: '知识库', icon: PhBooks },
  { key: 'mcp', label: 'MCP 管理', icon: PhPlugsConnected },
  { key: 'settings', label: '设置', icon: PhGear }
] satisfies Array<{ key: AppTabKey; label: string; icon: unknown }>;

const { dark, toggleTheme } = useColorTheme();

function isTabVisible(key: AppTabKey) {
  return key === 'settings' || key === 'mcp' || props.tabVisibility[key];
}
</script>

<template>
  <nav class="flex min-w-0 items-center gap-3" aria-label="功能导航">
    <div class="flex shrink-0 items-center gap-2 pr-1">
      <span class="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-xs">
        <PhSparkle :size="16" weight="fill" aria-hidden="true" />
      </span>
      <span class="hidden text-sm font-semibold tracking-[-0.015em] text-foreground xl:inline">EvidentLoop</span>
    </div>

    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Tooltip v-for="tab in tabs.filter((item) => isTabVisible(item.key))" :key="tab.key">
        <TooltipTrigger as-child>
          <Button
            type="button"
            :variant="tab.key === props.activeTab ? 'secondary' : 'ghost'"
            size="default"
            class="h-9 shrink-0 px-3"
            :aria-label="tab.label"
            :aria-current="tab.key === props.activeTab ? 'page' : undefined"
            @click="emit('change', tab.key)"
          >
            <component :is="tab.icon" :size="16" weight="bold" aria-hidden="true" />
            <span class="max-md:hidden">{{ tab.label }}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent class="md:hidden">{{ tab.label }}</TooltipContent>
      </Tooltip>
    </div>

    <Tooltip>
      <TooltipTrigger as-child>
        <Button type="button" variant="ghost" size="icon-lg" class="shrink-0" :aria-label="dark ? '切换到浅色模式' : '切换到深色模式'" @click="toggleTheme">
          <PhSun v-if="dark" :size="17" weight="bold" aria-hidden="true" />
          <PhMoon v-else :size="17" weight="bold" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ dark ? '浅色模式' : '深色模式' }}</TooltipContent>
    </Tooltip>
  </nav>
</template>
