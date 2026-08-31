<script setup lang="ts">
import { computed } from 'vue';
import type { ArtifactSlide } from '../../types/artifacts';

const props = defineProps<{
  slides: ArtifactSlide[];
  currentSlideId?: string;
}>();

const currentSlide = computed(() => {
  return props.slides.find(s => s.id === props.currentSlideId) ?? props.slides[0];
});
</script>

<template>
  <div class="presentation-preview flex h-full flex-col gap-3">
    <p class="m-0 text-center text-[10px] text-[var(--agent-text-muted)]">结构预览，最终版式以生成结果为准</p>

    <div class="mx-auto w-full" style="max-width: 640px;">
      <!-- 16:9 canvas -->
      <div
        class="relative w-full overflow-hidden rounded-lg border border-[var(--agent-border)] bg-[#1a1a2e] shadow-lg"
        style="aspect-ratio: 16/9;"
        role="img"
        :aria-label="`幻灯片预览：${currentSlide?.title ?? '无内容'}`"
      >
        <div v-if="currentSlide" class="absolute inset-0 flex flex-col justify-center p-8">
          <div class="mb-3 text-right text-[10px] text-white/40">
            {{ { title: '标题页', content: '内容页', comparison: '对比页', closing: '结束页' }[currentSlide.kind] }}
          </div>
          <h2 class="mb-4 text-lg font-bold leading-tight text-white">{{ currentSlide.title || '（无标题）' }}</h2>
          <ul v-if="currentSlide.bullets.length" class="m-0 list-none space-y-1.5 p-0">
            <li
              v-for="(bullet, i) in currentSlide.bullets"
              :key="i"
              class="flex items-start gap-2 text-sm text-white/80"
            >
              <span class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-white/60" aria-hidden="true" />
              {{ bullet }}
            </li>
          </ul>

          <div v-if="currentSlide.visual" class="mt-4 rounded-md bg-white/10 px-3 py-2 text-xs text-white/60">
            <span v-if="currentSlide.visual.type === 'table'">表格：{{ currentSlide.visual.headers.join(' | ') }}</span>
            <span v-else-if="currentSlide.visual.type === 'bar'">柱状图：{{ currentSlide.visual.labels.join(', ') }}</span>
          </div>
        </div>
        <div v-else class="absolute inset-0 flex items-center justify-center text-white/30 text-sm">
          无幻灯片
        </div>
      </div>
    </div>

    <div class="flex flex-wrap justify-center gap-1.5 overflow-y-auto">
      <button
        v-for="(slide, index) in slides"
        :key="slide.id"
        type="button"
        class="flex h-12 w-20 items-center justify-center rounded border text-center text-[9px] transition-all"
        :class="slide.id === currentSlideId
          ? 'border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)] font-bold'
          : 'border-[var(--agent-border)] bg-[var(--agent-surface)] text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)]'"
        :aria-current="slide.id === currentSlideId ? 'true' : undefined"
        @click="$emit('update:currentSlideId', slide.id)"
      >
        <div class="truncate px-1">{{ index + 1 }}. {{ slide.title || '…' }}</div>
      </button>
    </div>
  </div>
</template>
