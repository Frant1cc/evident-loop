<script setup lang="ts">
import { PhBooks, PhChatCircleText, PhFlask, PhFlowArrow, PhGauge, PhGear } from '@phosphor-icons/vue';

import type { AppTabKey, TabVisibility } from '../../types/navigation';

const props = defineProps<{
  activeTab: AppTabKey;
  tabVisibility: TabVisibility;
}>();

const emit = defineEmits<{
  change: [tab: AppTabKey];
}>();

const tabs = [
  { key: 'chat', label: '对话', icon: PhChatCircleText },
  { key: 'research', label: '研究工作台', icon: PhFlask },
  { key: 'tasks', label: 'Agent 运行时', icon: PhFlowArrow },
  { key: 'evaluations', label: '质量评测', icon: PhGauge },
  { key: 'knowledge', label: '知识库', icon: PhBooks },
  { key: 'settings', label: '设置', icon: PhGear }
] satisfies Array<{ key: AppTabKey; label: string; icon: unknown }>;

function isTabVisible(key: AppTabKey) {
  return key === 'settings' || props.tabVisibility[key];
}
</script>

<template>
  <nav class="flex flex-wrap gap-1.5" aria-label="功能标签">
    <button
      v-for="tab in tabs.filter((item) => isTabVisible(item.key))"
      :key="tab.key"
      type="button"
      class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-transparent px-3 text-sm font-semibold transition-colors hover:border-[var(--agent-border)] hover:bg-[var(--agent-surface-muted)]"
      :class="tab.key === props.activeTab ? 'border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)]'"
      @click="emit('change', tab.key)"
    >
      <component :is="tab.icon" :size="17" weight="bold" aria-hidden="true" />
      {{ tab.label }}
    </button>
  </nav>
</template>
