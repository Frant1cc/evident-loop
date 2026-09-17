<script setup lang="ts">
import {
  PhFileText,
  PhListBullets,
  PhListNumbers,
  PhPresentation,
  PhTable,
  PhTextAlignLeft,
  PhTextH
} from '@phosphor-icons/vue';
import { computed } from 'vue';
import type { ArtifactSpec, LongformBlock, ResearchArtifactGeneration } from '../../types/artifacts';

type DeliverableTab = 'presentation' | 'longform';

const props = defineProps<{
  spec: ArtifactSpec;
  activeTab: DeliverableTab;
  generation?: ResearchArtifactGeneration;
  currentSlideId?: string;
  selectedBlockId?: string;
  compact?: boolean;
}>();

const emit = defineEmits<{
  'update:activeTab': [tab: DeliverableTab];
  'update:currentSlideId': [id: string];
  'update:selectedBlockId': [id: string];
}>();

const hasPresentation = computed(() => props.spec.formats.includes('pptx'));
const hasLongform = computed(() => props.spec.formats.includes('docx') || props.spec.formats.includes('pdf'));

const longformFormat = computed(() => props.spec.formats
  .filter(format => format === 'docx' || format === 'pdf')
  .map(format => format.toUpperCase())
  .join(' / '));

const blockMeta: Record<LongformBlock['type'], { label: string; icon: typeof PhTextH }> = {
  heading: { label: '标题', icon: PhTextH },
  paragraph: { label: '段落', icon: PhTextAlignLeft },
  bulletList: { label: '无序列表', icon: PhListBullets },
  numberedList: { label: '有序列表', icon: PhListNumbers },
  table: { label: '表格', icon: PhTable },
  pageBreak: { label: '分页', icon: PhFileText }
};

function blockTitle(block: LongformBlock) {
  if (block.type === 'heading' || block.type === 'paragraph') return block.text.trim() || blockMeta[block.type].label;
  if (block.type === 'bulletList' || block.type === 'numberedList') return block.items.find(item => item.trim()) || blockMeta[block.type].label;
  if (block.type === 'table') return block.headers.filter(Boolean).join(' / ') || '表格';
  return '分页符';
}
</script>

<template>
  <nav class="flex h-full min-h-0 flex-col" aria-label="文稿结构">
    <div v-if="!compact" class="border-b border-[var(--agent-border)] p-3">
      <p class="m-0 mb-2 px-1 text-[11px] font-semibold text-[var(--agent-text-muted)]">产物</p>
      <div class="grid gap-1 rounded-lg bg-[var(--agent-surface-muted)] p-1" :class="hasPresentation && hasLongform ? 'grid-cols-2' : 'grid-cols-1'">
        <button
          v-if="hasPresentation"
          type="button"
          class="flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-semibold transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)]"
          :class="activeTab === 'presentation'
            ? 'bg-[var(--agent-surface)] text-[var(--agent-text)] shadow-sm'
            : 'text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]'"
          :aria-pressed="activeTab === 'presentation'"
          @click="emit('update:activeTab', 'presentation')"
        >
          <PhPresentation :size="15" weight="bold" aria-hidden="true" />
          <span class="truncate">演示文稿</span>
        </button>
        <button
          v-if="hasLongform"
          type="button"
          class="flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-semibold transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)]"
          :class="activeTab === 'longform'
            ? 'bg-[var(--agent-surface)] text-[var(--agent-text)] shadow-sm'
            : 'text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]'"
          :aria-pressed="activeTab === 'longform'"
          @click="emit('update:activeTab', 'longform')"
        >
          <PhFileText :size="15" weight="bold" aria-hidden="true" />
          <span class="truncate">长篇文档</span>
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center justify-between px-4 pb-2 pt-4">
        <div>
          <h2 class="m-0 text-xs font-semibold text-[var(--agent-text)]">{{ activeTab === 'presentation' ? '页面结构' : '文档结构' }}</h2>
          <p class="m-0 mt-0.5 text-[10px] text-[var(--agent-text-muted)]">
            {{ activeTab === 'presentation' ? `${spec.presentation.slides.length} 页 · PPTX` : `${spec.longform?.blocks?.length ?? 0} 个内容块 · ${longformFormat}` }}
          </p>
        </div>
      </div>

      <div class="app-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <ol v-if="activeTab === 'presentation'" class="m-0 grid list-none gap-0.5 p-0">
          <li v-for="(slide, index) in spec.presentation.slides" :key="slide.id">
            <button
              type="button"
              class="group grid w-full grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)]"
              :class="slide.id === currentSlideId
                ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)] shadow-[inset_2px_0_0_var(--agent-text)]'
                : 'text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]'"
              :aria-current="slide.id === currentSlideId ? 'page' : undefined"
              @click="emit('update:currentSlideId', slide.id)"
            >
              <span
                class="grid size-8 place-items-center rounded border font-mono text-[10px] font-bold"
                :class="slide.id === currentSlideId
                  ? 'border-[var(--agent-selected-border)] bg-[var(--agent-surface)]/70'
                  : 'border-[var(--agent-border)] bg-[var(--agent-surface)] text-[var(--agent-text-muted)]'"
              >{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="min-w-0">
                <span class="block truncate text-xs font-semibold">{{ slide.title || '未命名页面' }}</span>
                <span class="mt-0.5 block text-[10px] opacity-65">{{ { title: '标题页', content: '内容页', comparison: '对比页', closing: '结束页' }[slide.kind] }}</span>
              </span>
            </button>
          </li>
        </ol>

        <ol v-else-if="activeTab === 'longform'" class="m-0 grid list-none gap-0.5 p-0">
          <li v-for="(block, index) in spec.longform?.blocks ?? []" :key="block.id">
            <button
              type="button"
              class="group grid w-full grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)]"
              :class="block.id === selectedBlockId
                ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)] shadow-[inset_2px_0_0_var(--agent-text)]'
                : 'text-[var(--agent-text)] hover:bg-[var(--agent-surface-muted)]'"
              :aria-current="block.id === selectedBlockId ? 'true' : undefined"
              @click="emit('update:selectedBlockId', block.id)"
            >
              <span
                class="grid size-8 place-items-center rounded border"
                :class="block.id === selectedBlockId
                  ? 'border-[var(--agent-selected-border)] bg-[var(--agent-surface)]/70'
                  : 'border-[var(--agent-border)] bg-[var(--agent-surface)] text-[var(--agent-text-muted)]'"
              >
                <component :is="blockMeta[block.type].icon" :size="14" weight="bold" aria-hidden="true" />
              </span>
              <span class="min-w-0">
                <span class="block truncate text-xs font-semibold">{{ blockTitle(block) }}</span>
                <span class="mt-0.5 block text-[10px] opacity-65">{{ index + 1 }} · {{ blockMeta[block.type].label }}</span>
              </span>
            </button>
          </li>
        </ol>

        <div
          v-if="activeTab === 'longform' && !(spec.longform?.blocks?.length)"
          class="mx-2 mt-2 rounded-lg border border-dashed border-[var(--agent-border)] px-3 py-8 text-center text-xs leading-5 text-[var(--agent-text-muted)]"
        >
          文档还没有内容块
        </div>
      </div>
    </div>
  </nav>
</template>
