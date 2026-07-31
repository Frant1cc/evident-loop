<script setup lang="ts">
import { computed } from 'vue';
import {
  PhArrowCounterClockwise,
  PhBooks,
  PhChatCircleText,
  PhCheck,
  PhFlask,
  PhFlowArrow,
  PhGauge,
  PhSlidersHorizontal
} from '@phosphor-icons/vue';

import {
  defaultTabVisibility,
  type ConfigurableTabKey,
  type TabVisibility
} from '../types/navigation';

const props = defineProps<{
  tabVisibility: TabVisibility;
}>();

const emit = defineEmits<{
  'update:tabVisibility': [visibility: TabVisibility];
}>();

const tabOptions = [
  {
    key: 'chat',
    label: '对话',
    description: '与 AI 助手进行即时问答和连续对话。',
    icon: PhChatCircleText
  },
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
    label: 'RAG 评测',
    description: '运行检索评测并检查召回与排序质量。',
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
  <div class="min-h-0 overflow-auto bg-[var(--agent-surface-muted)]">
    <div class="mx-auto grid w-full max-w-5xl gap-8 px-5 py-8 md:px-8 md:py-10">
      <header class="flex flex-col justify-between gap-5 border-b border-[var(--agent-border)] pb-7 sm:flex-row sm:items-end">
        <div class="max-w-2xl">
          <div class="mb-3 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-[var(--agent-text-muted)]">
            <PhSlidersHorizontal :size="15" weight="bold" aria-hidden="true" />
            工作区偏好
          </div>
          <h1 class="m-0 text-2xl font-bold tracking-[-0.02em] text-[var(--agent-text)] md:text-[28px]">设置</h1>
          <p class="m-0 mt-2 text-sm leading-6 text-[var(--agent-text-muted)]">选择顶部导航中显示的功能。更改会自动保存到当前浏览器。</p>
        </div>

        <button
          type="button"
          class="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 self-start rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-3 text-sm font-semibold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-primary-soft)] disabled:cursor-default disabled:opacity-40 sm:self-auto"
          :disabled="isDefault"
          @click="restoreDefaults"
        >
          <PhArrowCounterClockwise :size="16" weight="bold" aria-hidden="true" />
          恢复默认
        </button>
      </header>

      <section aria-labelledby="tab-visibility-title">
        <div class="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 id="tab-visibility-title" class="m-0 text-base font-bold text-[var(--agent-text)]">功能 Tab</h2>
            <p class="m-0 mt-1 text-sm text-[var(--agent-text-muted)]">设置始终显示，确保你可以随时恢复隐藏的功能。</p>
          </div>
          <span class="shrink-0 rounded-full border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2.5 py-1 text-xs font-bold tabular-nums text-[var(--agent-text-muted)]">
            已显示 {{ visibleCount }}/{{ tabOptions.length }}
          </span>
        </div>

        <div class="overflow-hidden rounded-xl border border-[var(--agent-border)] bg-[var(--agent-surface)]">
          <label
            v-for="(tab, index) in tabOptions"
            :key="tab.key"
            class="group flex cursor-pointer items-center gap-4 px-4 py-4 transition-colors hover:bg-[var(--agent-surface-muted)] md:px-5"
            :class="{ 'border-t border-[var(--agent-border)]': index > 0 }"
          >
            <span
              class="grid size-10 shrink-0 place-items-center rounded-lg border transition-colors"
              :class="tabVisibility[tab.key] ? 'border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'border-[var(--agent-border)] bg-[var(--agent-surface-muted)] text-[var(--agent-text-muted)]'"
            >
              <component :is="tab.icon" :size="19" weight="bold" aria-hidden="true" />
            </span>

            <span class="min-w-0 flex-1">
              <span class="block text-sm font-bold text-[var(--agent-text)]">{{ tab.label }}</span>
              <span class="mt-0.5 block text-sm leading-5 text-[var(--agent-text-muted)]">{{ tab.description }}</span>
            </span>

            <input
              class="peer sr-only"
              type="checkbox"
              :checked="tabVisibility[tab.key]"
              :aria-label="`在导航中显示${tab.label}`"
              @change="toggleTab(tab.key)"
            />
            <span
              class="relative h-6 w-11 shrink-0 rounded-full border transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--agent-text)]"
              :class="tabVisibility[tab.key] ? 'border-[var(--agent-text)] bg-[var(--agent-text)]' : 'border-[var(--agent-selected-border)] bg-[var(--agent-surface-muted)]'"
              aria-hidden="true"
            >
              <span
                class="absolute top-0.5 grid size-[18px] place-items-center rounded-full bg-white text-[var(--agent-text)] transition-transform"
                :class="tabVisibility[tab.key] ? 'translate-x-[20px]' : 'translate-x-0.5'"
              >
                <PhCheck v-if="tabVisibility[tab.key]" :size="11" weight="bold" />
              </span>
            </span>
          </label>
        </div>

        <p class="m-0 mt-4 text-xs leading-5 text-[var(--agent-text-muted)]">导航顺序固定为：对话、研究工作台、Agent 运行时、RAG 评测、知识库、设置。</p>
      </section>
    </div>
  </div>
</template>
