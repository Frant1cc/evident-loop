<script setup lang="ts">
import { PhPlus, PhCopy, PhTrash, PhCaretUp, PhCaretDown } from '@phosphor-icons/vue';
import { computed } from 'vue';
import type { ArtifactSlide } from '../../types/artifacts';
import { patchPresentationHtmlText } from '../../lib/presentationHtmlEditing';

const props = defineProps<{
  slides: ArtifactSlide[];
  currentSlideId?: string;
  editable?: boolean;
  minSlides?: number;
}>();

const emit = defineEmits<{
  'update:currentSlideId': [id: string];
  'add-slide': [];
  'copy-slide': [id: string];
  'delete-slide': [id: string];
  'move-up': [id: string];
  'move-down': [id: string];
  'update-slide': [id: string, slide: ArtifactSlide];
}>();

const MIN_SLIDES = props.minSlides ?? 8;
const MAX_BULLETS = 8;

const currentSlide = computed(() => {
  return props.slides.find(s => s.id === props.currentSlideId) ?? props.slides[0];
});

const currentIndex = computed(() => {
  if (!currentSlide.value) return -1;
  return props.slides.findIndex(s => s.id === currentSlide.value.id);
});

const canDelete = computed(() => {
  return props.slides.length > MIN_SLIDES;
});

const canMoveUp = computed(() => {
  return currentIndex.value > 0;
});

const canMoveDown = computed(() => {
  return currentIndex.value >= 0 && currentIndex.value < props.slides.length - 1;
});

function selectSlide(id: string) {
  emit('update:currentSlideId', id);
}

function updateCurrentSlide(updates: Partial<ArtifactSlide>, resetLayout = false) {
  if (!currentSlide.value) return;
  emit('update-slide', currentSlide.value.id, {
    ...currentSlide.value,
    ...updates,
    ...(resetLayout ? { html: undefined } : {})
  });
}

function updateTitle(value: string) {
  if (!currentSlide.value) return;
  const patched = currentSlide.value.html
    ? patchPresentationHtmlText(currentSlide.value.html, currentSlide.value.title, value, { type: 'title' })
    : undefined;
  updateCurrentSlide({
    title: value,
    ...(patched?.replaced ? { html: patched.html } : {})
  });
}

function commitTitle(input: HTMLInputElement) {
  if (!currentSlide.value) return;
  const value = input.value.trim();
  if (!value) {
    input.value = currentSlide.value.title;
    return;
  }
  input.value = value;
  updateTitle(value);
}

function updateBullet(index: number, value: string) {
  if (!currentSlide.value) return;
  const bullets = [...currentSlide.value.bullets];
  const previousValue = bullets[index] ?? '';
  const duplicateOccurrence = bullets.slice(0, index).filter(item => item === previousValue).length;
  bullets[index] = value;
  const patched = currentSlide.value.html
    ? patchPresentationHtmlText(currentSlide.value.html, previousValue, value, {
        type: 'bullet',
        index,
        duplicateOccurrence
      })
    : undefined;
  updateCurrentSlide({
    bullets,
    ...(patched?.replaced ? { html: patched.html } : {})
  });
}

function commitBullet(index: number, input: HTMLInputElement) {
  if (!currentSlide.value) return;
  const value = input.value.trim();
  if (!value) {
    input.value = currentSlide.value.bullets[index] ?? '';
    return;
  }
  input.value = value;
  updateBullet(index, value);
}

function addBullet() {
  if (!currentSlide.value || currentSlide.value.bullets.length >= MAX_BULLETS) return;
  const bullets = [...currentSlide.value.bullets, ''];
  updateCurrentSlide({ bullets }, true);
}

function removeBullet(index: number) {
  if (!currentSlide.value) return;
  const bullets = currentSlide.value.bullets.filter((_, i) => i !== index);
  updateCurrentSlide({ bullets: bullets.length ? bullets : [''] }, true);
}
</script>

<template>
  <div class="presentation-editor grid h-full grid-rows-[auto_minmax(0,1fr)] gap-3">
    <div class="grid gap-2.5 border-b border-[var(--agent-border)] pb-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <strong class="block text-xs font-semibold text-[var(--agent-text)]">页面内容</strong>
          <span class="mt-0.5 block text-[10px] text-[var(--agent-text-muted)]">第 {{ currentIndex + 1 }} 页，共 {{ slides.length }} 页</span>
        </div>
        <button
          v-if="editable"
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2.5 text-xs font-semibold text-[var(--agent-text)] transition-[background-color,transform] hover:bg-[var(--agent-surface-muted)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--agent-focus-ring)]"
          @click="emit('add-slide')"
        >
          <PhPlus :size="14" weight="bold" aria-hidden="true" />
          新建页面
        </button>
      </div>

      <div v-if="editable && currentSlide" class="flex items-center gap-1">
        <button
          type="button"
          class="editor-icon-button"
          :disabled="!canMoveUp"
          :aria-label="`上移幻灯片 ${currentIndex + 1}`"
          title="上移"
          @click="emit('move-up', currentSlide.id)"
        ><PhCaretUp :size="14" weight="bold" aria-hidden="true" /></button>
        <button
          type="button"
          class="editor-icon-button"
          :disabled="!canMoveDown"
          :aria-label="`下移幻灯片 ${currentIndex + 1}`"
          title="下移"
          @click="emit('move-down', currentSlide.id)"
        ><PhCaretDown :size="14" weight="bold" aria-hidden="true" /></button>
        <button
          type="button"
          class="editor-icon-button"
          aria-label="复制当前幻灯片"
          title="复制"
          @click="emit('copy-slide', currentSlide.id)"
        ><PhCopy :size="14" weight="bold" aria-hidden="true" /></button>
        <span class="mx-1 h-4 w-px bg-[var(--agent-border)]" aria-hidden="true" />
        <button
          type="button"
          class="editor-icon-button text-destructive hover:bg-destructive/5"
          :disabled="!canDelete"
          :aria-label="`删除幻灯片 ${currentIndex + 1}`"
          :title="canDelete ? '删除' : `至少需要 ${MIN_SLIDES} 页幻灯片`"
          @click="emit('delete-slide', currentSlide.id)"
        ><PhTrash :size="14" weight="bold" aria-hidden="true" /></button>
      </div>
    </div>

    <div v-if="currentSlide" class="app-scrollbar min-h-0 space-y-4 overflow-y-auto px-0.5 pb-5 pr-1.5">
      <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
        标题
        <input
          v-if="editable"
          :value="currentSlide.title"
          type="text"
          class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
          @change="commitTitle($event.target as HTMLInputElement)"
        />
        <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
          {{ currentSlide.title }}
        </div>
      </label>

      <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
        页面结构
        <select
          v-if="editable"
          :value="currentSlide.kind"
          class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
          @change="updateCurrentSlide({ kind: ($event.target as HTMLSelectElement).value as ArtifactSlide['kind'] }, true)"
        >
          <option value="title">标题页</option>
          <option value="content">内容页</option>
          <option value="comparison">对比页</option>
          <option value="closing">结束页</option>
        </select>
        <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
          {{ { title: '标题页', content: '内容页', comparison: '对比页', closing: '结束页' }[currentSlide.kind] }}
        </div>
        <span v-if="editable && currentSlide.html" class="text-[10px] font-normal leading-4 text-[var(--agent-text-muted)]">
          修改标题和要点会保留当前版式；切换页面结构或增删要点会重新排版。
        </span>
      </label>

      <div class="grid gap-1">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-[var(--agent-text-muted)]">要点（最多 {{ MAX_BULLETS }} 条）</span>
          <button
            v-if="editable && currentSlide.bullets.length < MAX_BULLETS"
            type="button"
            class="inline-flex h-6 items-center gap-1 rounded border border-[var(--agent-border)] px-2 text-[10px] font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]"
            @click="addBullet"
          >
            <PhPlus :size="12" weight="bold" aria-hidden="true" />
            添加要点
          </button>
        </div>
        <div class="space-y-2">
          <div v-for="(bullet, index) in currentSlide.bullets" :key="index" class="flex items-start gap-2">
            <span class="mt-2 text-xs text-[var(--agent-text-muted)]">{{ index + 1 }}.</span>
            <input
              v-if="editable"
              :value="bullet"
              type="text"
              class="flex-1 rounded border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
              @change="commitBullet(index, $event.target as HTMLInputElement)"
            />
            <div v-else class="flex-1 rounded border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
              {{ bullet }}
            </div>
            <button
              v-if="editable"
              type="button"
              class="mt-1 text-[var(--agent-text-muted)] transition-colors hover:text-destructive"
              :aria-label="`删除要点 ${index + 1}`"
              @click="removeBullet(index)"
            >
              <PhTrash :size="14" weight="bold" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
        演讲者备注
        <textarea
          v-if="editable"
          :value="currentSlide.speakerNotes || ''"
          rows="3"
          class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
          @input="updateCurrentSlide({ speakerNotes: ($event.target as HTMLTextAreaElement).value })"
        />
        <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
          {{ currentSlide.speakerNotes || '无' }}
        </div>
      </label>

      <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
        引用（每行一个引用键）
        <textarea
          v-if="editable"
          :value="currentSlide.citations.join('\n')"
          rows="2"
          class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-xs text-[var(--agent-text)]"
          placeholder="例如：source_1"
          @input="updateCurrentSlide({ citations: ($event.target as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean) })"
        />
        <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-xs text-[var(--agent-text)]">
          {{ currentSlide.citations.join(', ') || '无' }}
        </div>
      </label>
    </div>
  </div>
</template>

<style scoped>
.editor-icon-button {
  display: grid;
  width: 1.875rem;
  height: 1.875rem;
  place-items: center;
  border-radius: 0.375rem;
  color: var(--agent-text-muted);
  transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
}

.editor-icon-button:hover:not(:disabled) {
  background: var(--agent-surface-muted);
  color: var(--agent-text);
}

.editor-icon-button:active:not(:disabled) {
  transform: scale(0.96);
}

.editor-icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.editor-icon-button:focus-visible,
.presentation-editor :is(input, select, textarea):focus-visible {
  outline: 2px solid var(--agent-focus-ring);
  outline-offset: 1px;
}

.presentation-editor :is(input, select, textarea) {
  min-height: 2.25rem;
  background: var(--agent-bg);
  line-height: 1.5;
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}

.presentation-editor textarea {
  resize: vertical;
}

.presentation-editor :is(input, select, textarea):hover {
  border-color: color-mix(in oklch, var(--agent-text-muted), transparent 40%);
}

.presentation-editor :is(input, select, textarea):focus {
  border-color: var(--agent-text-muted);
  box-shadow: 0 0 0 3px var(--agent-focus-ring);
}
</style>
