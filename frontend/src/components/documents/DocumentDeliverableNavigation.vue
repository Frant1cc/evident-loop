<script setup lang="ts">
import { computed } from 'vue';
import type { ArtifactSpec, ResearchArtifactGeneration } from '../../types/artifacts';

type DeliverableTab = 'presentation' | 'longform';

const props = defineProps<{
  spec: ArtifactSpec;
  activeTab: DeliverableTab;
  generation?: ResearchArtifactGeneration;
}>();

const emit = defineEmits<{
  'update:activeTab': [tab: DeliverableTab];
}>();

const hasPresentation = computed(() => props.spec.formats.includes('pptx'));
const hasLongform = computed(() => props.spec.formats.includes('docx') || props.spec.formats.includes('pdf'));

const deliverables = computed(() => {
  const items = [];
  if (hasPresentation.value) {
    items.push({
      id: 'presentation' as DeliverableTab,
      label: '演示文稿',
      count: props.spec.presentation.slides.length,
      format: 'PPTX',
      icon: '📊'
    });
  }
  if (hasLongform.value) {
    const longformFormats = props.spec.formats.filter(f => f === 'docx' || f === 'pdf').map(f => f.toUpperCase()).join('、');
    items.push({
      id: 'longform' as DeliverableTab,
      label: '长篇文档',
      count: props.spec.longform?.blocks?.length ?? 0,
      format: longformFormats,
      icon: '📄'
    });
  }
  return items;
});
</script>

<template>
  <nav
    class="document-deliverable-nav flex flex-col gap-1 p-2"
    aria-label="文稿导航"
  >
    <button
      v-for="item in deliverables"
      :key="item.id"
      type="button"
      class="flex w-full flex-col rounded-md px-3 py-2.5 text-left transition-colors"
      :class="activeTab === item.id
        ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]'
        : 'text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]'"
      :aria-current="activeTab === item.id ? 'true' : undefined"
      @click="emit('update:activeTab', item.id)"
    >
      <div class="flex items-center gap-2">
        <span aria-hidden="true">{{ item.icon }}</span>
        <span class="text-sm font-semibold">{{ item.label }}</span>
      </div>
      <div class="mt-0.5 flex items-center gap-2 pl-6 text-[11px]" :class="activeTab === item.id ? 'text-[var(--agent-selected-text)]/70' : 'text-[var(--agent-text-muted)]'">
        <span>{{ item.count }} 个内容</span>
        <span>·</span>
        <span>{{ item.format }}</span>
      </div>
    </button>

    <div v-if="deliverables.length === 0" class="px-3 py-4 text-xs text-[var(--agent-text-muted)]">
      暂无稿件
    </div>
  </nav>
</template>
