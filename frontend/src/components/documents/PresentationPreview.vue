<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ArtifactSlide } from '../../types/artifacts';

const props = defineProps<{
  slides: ArtifactSlide[];
  currentSlideId?: string;
  themeCss?: string;
}>();

const currentSlide = computed(() => {
  return props.slides.find(s => s.id === props.currentSlideId) ?? props.slides[0];
});

const previewCanvas = ref<HTMLElement>();
const previewScale = ref(0.4);
let previewResizeObserver: ResizeObserver | undefined;

onMounted(() => {
  const updateScale = () => {
    const width = previewCanvas.value?.getBoundingClientRect().width;
    if (width) previewScale.value = width / 1_600;
  };
  updateScale();
  previewResizeObserver = new ResizeObserver(updateScale);
  if (previewCanvas.value) previewResizeObserver.observe(previewCanvas.value);
});

onBeforeUnmount(() => previewResizeObserver?.disconnect());

const previewSrcdoc = computed(() => {
  const slide = currentSlide.value;
  if (!slide?.html) return '';
  const css = (props.themeCss ?? '')
    .replace(/@import[\s\S]*?;/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none';"><style>*{box-sizing:border-box}html,body{width:1600px;height:900px;margin:0;overflow:hidden}body{font-family:Aptos,'PingFang SC','Microsoft YaHei',Arial,sans-serif;background:#f7f5f0;color:#172126}${css}html,body{width:1600px!important;height:900px!important;margin:0!important;overflow:hidden!important}body>:first-child{width:100%!important;height:100%!important;max-height:100%!important;overflow:hidden!important}</style></head><body>${slide.html}</body></html>`;
});
</script>

<template>
  <div class="presentation-preview flex h-full flex-col gap-3">
    <p class="m-0 text-center text-[10px] text-[var(--agent-text-muted)]">
      {{ currentSlide?.html ? 'HTML 视觉预览，生成时将按 16:9 精确渲染' : '兼容布局预览，最终版式以生成结果为准' }}
    </p>

    <div class="mx-auto w-full" style="max-width: 640px;">
      <!-- 16:9 canvas -->
      <div
        ref="previewCanvas"
        class="relative w-full overflow-hidden rounded-lg border border-[var(--agent-border)] bg-[#1a1a2e] shadow-lg"
        style="aspect-ratio: 16/9;"
        role="img"
        :aria-label="`幻灯片预览：${currentSlide?.title ?? '无内容'}`"
      >
        <iframe
          v-if="currentSlide?.html"
          :srcdoc="previewSrcdoc"
          sandbox=""
          title="HTML 幻灯片视觉预览"
          class="absolute left-0 top-0 origin-top-left border-0 bg-white"
          :style="{
            width: '1600px',
            height: '900px',
            transform: `scale(${previewScale})`
          }"
        />
        <div v-else-if="currentSlide" class="absolute inset-0 flex flex-col justify-center p-8">
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
