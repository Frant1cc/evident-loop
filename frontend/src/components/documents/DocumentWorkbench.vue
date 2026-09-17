<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  ArtifactOutput,
  ArtifactSlide,
  ArtifactSpec,
  LongformBlock,
  ResearchArtifactGeneration
} from '../../types/artifacts';
import {
  createDefaultLongformBlock,
  generateBlockId,
  moveArrayItem,
  type DraftSaveState
} from './documentEditor';
import DocumentWorkbenchHeader from './DocumentWorkbenchHeader.vue';
import DocumentDeliverableNavigation from './DocumentDeliverableNavigation.vue';
import PresentationEditor from './PresentationEditor.vue';
import PresentationPreview from './PresentationPreview.vue';
import LongformEditor from './LongformEditor.vue';
import LongformPreview from './LongformPreview.vue';
import DocumentSettingsDialog from './DocumentSettingsDialog.vue';
import DocumentVersionDialog from './DocumentVersionDialog.vue';
import DocumentOutputCard from './DocumentOutputCard.vue';

type DeliverableTab = 'presentation' | 'longform';
type MobileTab = 'structure' | 'preview' | 'edit';

const props = defineProps<{
  generation: ResearchArtifactGeneration;
  generations?: ResearchArtifactGeneration[];
  saveState: DraftSaveState;
  busy?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'update-spec': [spec: ArtifactSpec];
  generate: [];
  cancel: [];
  'retry-output': [outputId: string];
  'preview-output': [output: ArtifactOutput];
  'select-generation': [id: string];
  'delete-generation': [id: string];
}>();

const activeDeliverableTab = ref<DeliverableTab>('presentation');
const mobileTab = ref<MobileTab>('edit');
const currentSlideId = ref<string>();
const selectedBlockId = ref<string>();
const showSettings = ref(false);
const showVersions = ref(false);
let previousBodyOverflow = '';

const spec = computed(() => props.generation.spec);
const editable = computed(() => props.generation.status === 'awaiting_confirmation' && !props.generation.stale);
const isReadOnly = computed(() => !editable.value);

const hasPresentation = computed(() => spec.value.formats.includes('pptx'));
const hasLongform = computed(() => spec.value.formats.includes('docx') || spec.value.formats.includes('pdf'));
const currentSelectionLabel = computed(() => {
  if (activeDeliverableTab.value === 'presentation') {
    const index = spec.value.presentation.slides.findIndex(slide => slide.id === currentSlideId.value);
    return index >= 0 ? `第 ${index + 1} 页` : '幻灯片预览';
  }
  const blocks = spec.value.longform?.blocks ?? [];
  const index = blocks.findIndex(block => block.id === selectedBlockId.value);
  return index >= 0 ? `内容块 ${index + 1}` : '文档预览';
});

watch(() => spec.value.presentation.slides, (slides) => {
  if (slides.length && !slides.find(s => s.id === currentSlideId.value)) {
    currentSlideId.value = slides[0]?.id;
  }
}, { immediate: true });

watch(() => spec.value.longform?.blocks, (blocks) => {
  if (blocks?.length && !blocks.find(b => b.id === selectedBlockId.value)) {
    selectedBlockId.value = blocks[0]?.id;
  }
}, { immediate: true });

watch(() => hasPresentation.value, (hasPptx) => {
  if (!hasPptx && activeDeliverableTab.value === 'presentation') {
    if (hasLongform.value) activeDeliverableTab.value = 'longform';
  }
}, { immediate: true });

onMounted(() => {
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  window.addEventListener('keydown', handleKeydown);
  // Focus the workbench
  nextTick(() => {
    (document.querySelector('.document-workbench') as HTMLElement)?.focus();
  });
});

onBeforeUnmount(() => {
  document.body.style.overflow = previousBodyOverflow;
  window.removeEventListener('keydown', handleKeydown);
});

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const editingText = target?.matches('input, textarea, select, [contenteditable="true"]');

  if (event.key === 'Escape' && !editingText && !showSettings.value && !showVersions.value) {
    handleClose();
  }

  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && editable.value && !props.busy && !showSettings.value && !showVersions.value) {
    event.preventDefault();
    handleGenerate();
  }
}

function handleClose() {
  emit('close');
}

function updateSpec(spec: ArtifactSpec) {
  emit('update-spec', spec);
}

// Slide operations
function updateSlide(id: string, slide: ArtifactSlide) {
  if (!editable.value) return;
  const slides = spec.value.presentation.slides.map(s => s.id === id ? slide : s);
  emit('update-spec', { ...spec.value, presentation: { ...spec.value.presentation, slides } });
}

function addSlide() {
  if (!editable.value) return;
  const newSlide: ArtifactSlide = {
    id: generateBlockId(),
    title: '新幻灯片',
    kind: 'content',
    bullets: [''],
    citations: []
  };
  const currentIndex = spec.value.presentation.slides.findIndex(s => s.id === currentSlideId.value);
  const insertAt = currentIndex >= 0 ? currentIndex + 1 : spec.value.presentation.slides.length;
  const slides = [...spec.value.presentation.slides];
  slides.splice(insertAt, 0, newSlide);
  currentSlideId.value = newSlide.id;
  emit('update-spec', { ...spec.value, presentation: { ...spec.value.presentation, slides } });
}

function copySlide(id: string) {
  if (!editable.value) return;
  const source = spec.value.presentation.slides.find(s => s.id === id);
  if (!source) return;
  const copied: ArtifactSlide = { ...source, id: generateBlockId() };
  const sourceIndex = spec.value.presentation.slides.findIndex(s => s.id === id);
  const slides = [...spec.value.presentation.slides];
  slides.splice(sourceIndex + 1, 0, copied);
  currentSlideId.value = copied.id;
  emit('update-spec', { ...spec.value, presentation: { ...spec.value.presentation, slides } });
}

function deleteSlide(id: string) {
  if (!editable.value || spec.value.presentation.slides.length <= 8) return;
  const slides = spec.value.presentation.slides.filter(s => s.id !== id);
  if (currentSlideId.value === id) {
    const deletedIndex = spec.value.presentation.slides.findIndex(s => s.id === id);
    currentSlideId.value = slides[Math.min(deletedIndex, slides.length - 1)]?.id;
  }
  emit('update-spec', { ...spec.value, presentation: { ...spec.value.presentation, slides } });
}

function moveSlideUp(id: string) {
  if (!editable.value) return;
  const index = spec.value.presentation.slides.findIndex(s => s.id === id);
  if (index <= 0) return;
  const slides = moveArrayItem(spec.value.presentation.slides, index, index - 1);
  emit('update-spec', { ...spec.value, presentation: { ...spec.value.presentation, slides } });
}

function moveSlideDown(id: string) {
  if (!editable.value) return;
  const index = spec.value.presentation.slides.findIndex(s => s.id === id);
  if (index < 0 || index >= spec.value.presentation.slides.length - 1) return;
  const slides = moveArrayItem(spec.value.presentation.slides, index, index + 1);
  emit('update-spec', { ...spec.value, presentation: { ...spec.value.presentation, slides } });
}

// Longform block operations
function updateBlock(id: string, block: LongformBlock) {
  if (!editable.value) return;
  const blocks = (spec.value.longform?.blocks ?? []).map(b => b.id === id ? block : b);
  emit('update-spec', { ...spec.value, longform: { ...spec.value.longform, blocks } });
}

function addBlock(type: LongformBlock['type'], afterId?: string) {
  if (!editable.value) return;
  const newBlock = createDefaultLongformBlock(type);
  const blocks = [...(spec.value.longform?.blocks ?? [])];
  if (afterId) {
    const afterIndex = blocks.findIndex(b => b.id === afterId);
    if (afterIndex >= 0) {
      blocks.splice(afterIndex + 1, 0, newBlock);
    } else {
      blocks.push(newBlock);
    }
  } else {
    blocks.push(newBlock);
  }
  selectedBlockId.value = newBlock.id;
  emit('update-spec', { ...spec.value, longform: { ...spec.value.longform, blocks } });
}

function deleteBlock(id: string) {
  if (!editable.value) return;
  const blocks = (spec.value.longform?.blocks ?? []).filter(b => b.id !== id);
  if (selectedBlockId.value === id) {
    const deletedIndex = (spec.value.longform?.blocks ?? []).findIndex(b => b.id === id);
    selectedBlockId.value = blocks[Math.min(deletedIndex, blocks.length - 1)]?.id;
  }
  emit('update-spec', { ...spec.value, longform: { ...spec.value.longform, blocks } });
}

function moveBlockUp(id: string) {
  if (!editable.value) return;
  const blocks = spec.value.longform?.blocks ?? [];
  const index = blocks.findIndex(b => b.id === id);
  if (index <= 0) return;
  emit('update-spec', { ...spec.value, longform: { ...spec.value.longform, blocks: moveArrayItem(blocks, index, index - 1) } });
}

function moveBlockDown(id: string) {
  if (!editable.value) return;
  const blocks = spec.value.longform?.blocks ?? [];
  const index = blocks.findIndex(b => b.id === id);
  if (index < 0 || index >= blocks.length - 1) return;
  emit('update-spec', { ...spec.value, longform: { ...spec.value.longform, blocks: moveArrayItem(blocks, index, index + 1) } });
}

function handleGenerate() {
  emit('generate');
}
</script>

<template>
  <Teleport to="body">
    <div
      class="document-workbench fixed inset-0 z-50 flex flex-col bg-[var(--agent-bg)] outline-none"
      style="height: 100dvh;"
      role="dialog"
      aria-modal="true"
      :aria-label="`文稿工作台：${spec.title}`"
      tabindex="-1"
      @mousedown.self="handleClose"
    >
      <DocumentWorkbenchHeader
        :title="spec.title"
        :version="generation.version"
        :save-state="saveState"
        :editable="editable"
        :busy="busy"
        @close="handleClose"
        @open-settings="showSettings = true"
        @open-versions="showVersions = true"
        @generate="handleGenerate"
      />

      <!-- Desktop editor layout (>=1024px) -->
      <div class="hidden flex-1 overflow-hidden lg:grid" style="grid-template-columns: minmax(232px, 272px) minmax(360px, 1fr) minmax(340px, 400px);">
        <!-- Left: Navigation -->
        <aside class="flex min-h-0 flex-col overflow-hidden border-r border-[var(--agent-border)] bg-[var(--agent-surface)]">
          <DocumentDeliverableNavigation
            class="min-h-0 flex-1"
            :spec="spec"
            :active-tab="activeDeliverableTab"
            :generation="generation"
            :current-slide-id="currentSlideId"
            :selected-block-id="selectedBlockId"
            @update:active-tab="activeDeliverableTab = $event"
            @update:current-slide-id="currentSlideId = $event"
            @update:selected-block-id="selectedBlockId = $event"
          />

          <!-- Output cards in sidebar for completed outputs -->
          <div v-if="generation.outputs.length" class="border-t border-[var(--agent-border)] p-3">
            <details>
              <summary class="cursor-pointer list-none text-xs font-semibold text-[var(--agent-text)]">
                已生成文件 <span class="ml-1 font-normal text-[var(--agent-text-muted)]">{{ generation.outputs.length }}</span>
              </summary>
              <div class="mt-2 space-y-2">
                <DocumentOutputCard
                  v-for="output in generation.outputs"
                  :key="output.id"
                  :output="output"
                  :busy="busy"
                  @retry="emit('retry-output', $event)"
                  @preview="emit('preview-output', $event)"
                />
              </div>
            </details>
          </div>
        </aside>

        <!-- Center: Preview -->
        <main class="flex min-w-0 flex-col overflow-hidden border-r border-[var(--agent-border)] bg-[color-mix(in_oklch,var(--agent-surface-muted),var(--agent-bg)_42%)]">
          <div class="flex h-11 shrink-0 items-center justify-between border-b border-[var(--agent-border)] bg-[var(--agent-surface)] px-4">
            <div class="flex items-baseline gap-2">
              <h2 class="m-0 text-xs font-semibold text-[var(--agent-text)]">预览</h2>
              <span class="text-[10px] text-[var(--agent-text-muted)]">{{ currentSelectionLabel }}</span>
            </div>
            <span class="text-[10px] text-[var(--agent-text-muted)]">{{ activeDeliverableTab === 'presentation' ? '从左侧选择页面' : '点击正文定位内容' }}</span>
          </div>
          <div class="app-scrollbar flex-1 overflow-auto p-5 lg:p-7">
            <PresentationPreview
              v-if="activeDeliverableTab === 'presentation'"
              :slides="spec.presentation.slides"
              :theme-css="spec.presentation.themeCss"
              :theme="spec.theme"
              :branding="spec.branding"
              :deck-title="spec.title"
              :audience="spec.audience"
              :executive-summary="spec.brief.executiveSummary"
              :current-slide-id="currentSlideId"
              @update:current-slide-id="currentSlideId = $event"
            />
            <LongformPreview
              v-else-if="activeDeliverableTab === 'longform' && spec.longform?.blocks"
              :blocks="spec.longform.blocks"
              :selected-block-id="selectedBlockId"
              @update:selected-block-id="selectedBlockId = $event"
            />
          </div>
        </main>

        <!-- Right: Editor -->
        <aside class="flex min-w-0 flex-col overflow-hidden bg-[var(--agent-surface)]">
          <div class="flex h-11 shrink-0 items-center justify-between border-b border-[var(--agent-border)] px-4">
            <div>
              <h2 class="m-0 text-xs font-semibold text-[var(--agent-text)]">内容编辑</h2>
            </div>
            <span v-if="!editable" class="rounded bg-[var(--agent-surface-muted)] px-2 py-1 text-[10px] font-semibold text-[var(--agent-text-muted)]">只读</span>
          </div>
          <div class="flex-1 overflow-hidden p-4">
            <PresentationEditor
              v-if="activeDeliverableTab === 'presentation'"
              :slides="spec.presentation.slides"
              :current-slide-id="currentSlideId"
              :editable="editable"
              @update:current-slide-id="currentSlideId = $event"
              @update-slide="updateSlide"
              @add-slide="addSlide"
              @copy-slide="copySlide"
              @delete-slide="deleteSlide"
              @move-up="moveSlideUp"
              @move-down="moveSlideDown"
            />
            <LongformEditor
              v-else-if="activeDeliverableTab === 'longform'"
              :blocks="spec.longform?.blocks ?? []"
              :selected-block-id="selectedBlockId"
              :editable="editable"
              @update:selected-block-id="selectedBlockId = $event"
              @update-block="updateBlock"
              @add-block="addBlock"
              @delete-block="deleteBlock"
              @move-up="moveBlockUp"
              @move-down="moveBlockDown"
            />
          </div>
        </aside>
      </div>

      <!-- Compact tab layout (<1024px) -->
      <div class="flex flex-1 flex-col overflow-hidden lg:hidden">
        <!-- Deliverable tabs -->
        <div class="flex border-b border-[var(--agent-border)]">
          <button
            v-if="hasPresentation"
            type="button"
            class="flex-1 py-2 text-xs font-semibold transition-colors"
            :class="activeDeliverableTab === 'presentation' ? 'border-b-2 border-[var(--agent-selected-border)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)]'"
            @click="activeDeliverableTab = 'presentation'"
          >
            演示文稿
          </button>
          <button
            v-if="hasLongform"
            type="button"
            class="flex-1 py-2 text-xs font-semibold transition-colors"
            :class="activeDeliverableTab === 'longform' ? 'border-b-2 border-[var(--agent-selected-border)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)]'"
            @click="activeDeliverableTab = 'longform'"
          >
            长篇文档
          </button>
        </div>

        <!-- Mobile view tabs -->
        <div class="flex border-b border-[var(--agent-border)] bg-[var(--agent-surface)]">
          <button
            v-for="tab in [{ id: 'structure', label: '目录' }, { id: 'preview', label: '预览' }, { id: 'edit', label: '编辑' }]"
            :key="tab.id"
            type="button"
            class="flex-1 py-2 text-xs font-semibold transition-colors"
            :class="mobileTab === tab.id ? 'border-b-2 border-[var(--agent-selected-border)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)]'"
            @click="mobileTab = tab.id as MobileTab"
          >
            {{ tab.label }}
          </button>
        </div>

        <!-- Mobile content area -->
        <div class="flex-1 overflow-auto p-4">
          <!-- Structure tab -->
          <div v-if="mobileTab === 'structure'">
            <DocumentDeliverableNavigation
              compact
              class="h-full min-h-0"
              :spec="spec"
              :active-tab="activeDeliverableTab"
              :generation="generation"
              :current-slide-id="currentSlideId"
              :selected-block-id="selectedBlockId"
              @update:active-tab="activeDeliverableTab = $event"
              @update:current-slide-id="currentSlideId = $event; mobileTab = 'edit'"
              @update:selected-block-id="selectedBlockId = $event; mobileTab = 'edit'"
            />
          </div>

          <!-- Preview tab -->
          <div v-else-if="mobileTab === 'preview'">
            <PresentationPreview
              v-if="activeDeliverableTab === 'presentation'"
              :slides="spec.presentation.slides"
              :theme-css="spec.presentation.themeCss"
              :theme="spec.theme"
              :branding="spec.branding"
              :deck-title="spec.title"
              :audience="spec.audience"
              :executive-summary="spec.brief.executiveSummary"
              :current-slide-id="currentSlideId"
              @update:current-slide-id="currentSlideId = $event; mobileTab = 'edit'"
            />
            <LongformPreview
              v-else-if="activeDeliverableTab === 'longform' && spec.longform?.blocks"
              :blocks="spec.longform.blocks"
              :selected-block-id="selectedBlockId"
              @update:selected-block-id="selectedBlockId = $event; mobileTab = 'edit'"
            />
          </div>

          <!-- Edit tab -->
          <div v-else-if="mobileTab === 'edit'" class="h-full">
            <PresentationEditor
              v-if="activeDeliverableTab === 'presentation'"
              :slides="spec.presentation.slides"
              :current-slide-id="currentSlideId"
              :editable="editable"
              @update:current-slide-id="currentSlideId = $event"
              @update-slide="updateSlide"
              @add-slide="addSlide"
              @copy-slide="copySlide"
              @delete-slide="deleteSlide"
              @move-up="moveSlideUp"
              @move-down="moveSlideDown"
            />
            <LongformEditor
              v-else-if="activeDeliverableTab === 'longform'"
              :blocks="spec.longform?.blocks ?? []"
              :selected-block-id="selectedBlockId"
              :editable="editable"
              @update:selected-block-id="selectedBlockId = $event"
              @update-block="updateBlock"
              @add-block="addBlock"
              @delete-block="deleteBlock"
              @move-up="moveBlockUp"
              @move-down="moveBlockDown"
            />
          </div>
        </div>
      </div>

      <!-- Read-only banner -->
      <div v-if="isReadOnly" class="border-t border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200" role="status">
        此版本为只读模式。{{ generation.stale ? '草稿已失效，请重新生成。' : '历史版本不可编辑。' }}
      </div>
    </div>

    <DocumentSettingsDialog
      :open="showSettings"
      :spec="spec"
      :editable="editable"
      :save-state="saveState"
      @update:open="showSettings = $event"
      @update-spec="updateSpec"
    />

    <DocumentVersionDialog
      :open="showVersions"
      :generations="generations"
      :current-generation-id="generation.id"
      :busy="busy"
      @update:open="showVersions = $event"
      @select="emit('select-generation', $event)"
      @delete="emit('delete-generation', $event)"
      @preview-output="emit('preview-output', $event)"
    />
  </Teleport>
</template>
