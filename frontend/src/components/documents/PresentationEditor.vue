<script setup lang="ts">
import { PhPlus, PhCopy, PhTrash, PhCaretUp, PhCaretDown } from '@phosphor-icons/vue';
import { computed } from 'vue';
import type { ArtifactSlide } from '../../types/artifacts';

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

function updateCurrentSlide(updates: Partial<ArtifactSlide>) {
  if (!currentSlide.value) return;
  emit('update-slide', currentSlide.value.id, { ...currentSlide.value, ...updates });
}

function updateBullet(index: number, value: string) {
  if (!currentSlide.value) return;
  const bullets = [...currentSlide.value.bullets];
  bullets[index] = value;
  updateCurrentSlide({ bullets });
}

function addBullet() {
  if (!currentSlide.value || currentSlide.value.bullets.length >= MAX_BULLETS) return;
  const bullets = [...currentSlide.value.bullets, ''];
  updateCurrentSlide({ bullets });
}

function removeBullet(index: number) {
  if (!currentSlide.value) return;
  const bullets = currentSlide.value.bullets.filter((_, i) => i !== index);
  updateCurrentSlide({ bullets: bullets.length ? bullets : [''] });
}
</script>

<template>
  <div class="presentation-editor grid h-full grid-rows-[auto_minmax(0,1fr)] gap-3">
    <div class="flex items-center gap-2 border-b border-[var(--agent-border)] pb-3">
      <span class="text-sm font-semibold text-[var(--agent-text-muted)]">幻灯片 {{ currentIndex + 1 }} / {{ slides.length }}</span>
      <button
        v-if="editable"
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)] disabled:opacity-50"
        :disabled="!canMoveUp"
        :aria-label="`上移幻灯片 ${currentIndex + 1}`"
        @click="emit('move-up', currentSlide.id)"
      >
        <PhCaretUp :size="14" weight="bold" aria-hidden="true" />
      </button>
      <button
        v-if="editable"
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)] disabled:opacity-50"
        :disabled="!canMoveDown"
        :aria-label="`下移幻灯片 ${currentIndex + 1}`"
        @click="emit('move-down', currentSlide.id)"
      >
        <PhCaretDown :size="14" weight="bold" aria-hidden="true" />
      </button>
      <button
        v-if="editable"
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded border border-[var(--agent-border)] bg-[var(--agent-surface)] px-2 text-xs font-bold text-[var(--agent-text)] transition-colors hover:bg-[var(--agent-surface-muted)]"
        aria-label="复制当前幻灯片"
        @click="emit('copy-slide', currentSlide.id)"
      >
        <PhCopy :size="14" weight="bold" aria-hidden="true" />
      </button>
      <button
        v-if="editable"
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded border border-destructive/30 bg-[var(--agent-surface)] px-2 text-xs font-bold text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-50"
        :disabled="!canDelete"
        :aria-label="`删除幻灯片 ${currentIndex + 1}`"
        :title="canDelete ? undefined : `至少需要 ${MIN_SLIDES} 页幻灯片`"
        @click="emit('delete-slide', currentSlide.id)"
      >
        <PhTrash :size="14" weight="bold" aria-hidden="true" />
      </button>
      <button
        v-if="editable"
        type="button"
        class="ml-auto inline-flex h-7 items-center gap-1 rounded bg-[var(--agent-selected-bg)] px-2 text-xs font-bold text-[var(--agent-selected-text)] transition-opacity hover:opacity-80"
        aria-label="添加幻灯片"
        @click="emit('add-slide')"
      >
        <PhPlus :size="14" weight="bold" aria-hidden="true" />
        添加幻灯片
      </button>
    </div>

    <div v-if="currentSlide" class="min-h-0 space-y-3 overflow-y-auto px-1">
      <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
        标题
        <input
          v-if="editable"
          :value="currentSlide.title"
          type="text"
          class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
          @input="updateCurrentSlide({ title: ($event.target as HTMLInputElement).value })"
        />
        <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
          {{ currentSlide.title }}
        </div>
      </label>

      <label class="grid gap-1 text-xs font-semibold text-[var(--agent-text-muted)]">
        类型
        <select
          v-if="editable"
          :value="currentSlide.kind"
          class="rounded-md border border-[var(--agent-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--agent-text)]"
          @change="updateCurrentSlide({ kind: ($event.target as HTMLSelectElement).value as ArtifactSlide['kind'] })"
        >
          <option value="title">标题页</option>
          <option value="content">内容页</option>
          <option value="comparison">对比页</option>
          <option value="closing">结束页</option>
        </select>
        <div v-else class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1.5 text-sm text-[var(--agent-text)]">
          {{ { title: '标题页', content: '内容页', comparison: '对比页', closing: '结束页' }[currentSlide.kind] }}
        </div>
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
              @input="updateBullet(index, ($event.target as HTMLInputElement).value)"
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
