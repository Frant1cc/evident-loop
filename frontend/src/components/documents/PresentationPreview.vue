<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ArtifactSlide } from '../../types/artifacts';

const props = defineProps<{
  slides: ArtifactSlide[];
  currentSlideId?: string;
  themeCss?: string;
  theme?: 'research' | 'technical' | 'business';
  branding?: { primaryColor?: string; titleFont?: string; bodyFont?: string };
  deckTitle?: string;
  audience?: string;
  executiveSummary?: string;
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
  if (!slide) return '';
  const css = (props.themeCss ?? '')
    .replace(/@import[\s\S]*?;/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/<\/style/gi, '<\\/style');
  const index = Math.max(0, props.slides.findIndex((candidate) => candidate.id === slide.id));
  const content = slide.html || createFallbackSlideMarkup(slide);
  const colors = previewThemeColors();
  const fontFamily = cssFont(props.branding?.bodyFont ?? 'Aptos');
  const titleFontFamily = cssFont(props.branding?.titleFont ?? props.branding?.bodyFont ?? 'Aptos Display');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none';"><style>
:root{--slide-primary:#${colors.primary};--slide-accent:#${colors.accent};--slide-background:#F7F5F0;--slide-panel:#E8ECE8;--slide-text:#172126;--slide-muted:#667178;--slide-rule:#CDD4D1;--slide-font:${fontFamily};--slide-title-font:${titleFontFamily}}
*{box-sizing:border-box}html,body{width:1600px;height:900px;margin:0;overflow:hidden}body{background:var(--slide-background);color:var(--slide-text);font-family:var(--slide-font)}
#slide-stage{position:relative;width:100%;height:100%;overflow:hidden;isolation:isolate}#slide-content{position:absolute;inset:0;overflow:hidden}#slide-content>:first-child{min-height:100%}
.evident-footer{position:absolute;z-index:20;left:54px;right:54px;bottom:24px;display:flex;align-items:flex-end;gap:20px;color:var(--slide-muted);font-size:15px;line-height:1.25}.evident-citations{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.evident-page{margin-left:auto;font-weight:700;letter-spacing:.08em}
${fallbackCss}${css}
#slide-content>:first-child{width:100%!important;height:100%!important;max-height:100%!important;overflow:hidden!important}.evident-footer{position:absolute!important;display:flex!important;visibility:visible!important;left:54px!important;right:54px!important;bottom:24px!important}
</style></head><body><main id="slide-stage"><section id="slide-content">${content}</section><footer class="evident-footer"><div class="evident-citations">${slide.citations.length ? `来源：${slide.citations.map(escapeHtml).join(' · ')}` : ''}</div><div class="evident-page">${index + 1} / ${props.slides.length}</div></footer></main></body></html>`;
});

const fallbackCss = `
.fallback-slide{position:relative;display:flex;flex-direction:column;width:100%;height:100%;padding:68px 76px 82px;overflow:hidden}.fallback-kicker{color:var(--slide-primary);font-size:24px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.fallback-title{max-width:1320px;margin:14px 0 0;color:var(--slide-text);font-family:var(--slide-title-font);font-size:54px;line-height:1.08;letter-spacing:-.025em}.fallback-title-slide{justify-content:center;padding-right:440px;background:var(--slide-background)}.fallback-title-slide:after{content:'';position:absolute;z-index:-1;top:0;right:0;width:28%;height:100%;background:var(--slide-primary)}.fallback-title-slide .fallback-title{margin:0;font-size:72px}.fallback-summary{max-width:1050px;margin:34px 0 0;color:var(--slide-muted);font-size:28px;line-height:1.45}.fallback-audience{margin-top:42px;color:var(--slide-primary);font-size:24px;font-weight:750}.fallback-points{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:34px 54px;margin-top:54px}.fallback-point{position:relative;min-height:128px;padding:6px 0 24px 74px;border-bottom:2px solid var(--slide-rule)}.fallback-index{position:absolute;left:0;top:0;color:var(--slide-primary);font-family:var(--slide-title-font);font-size:44px;font-weight:800;line-height:1}.fallback-point-text{font-size:25px;line-height:1.38}.fallback-compare{display:grid;grid-template-columns:1fr 1fr;gap:70px;margin-top:58px}.fallback-compare-column{padding-top:22px;border-top:8px solid var(--slide-primary)}.fallback-compare-column:last-child{border-color:var(--slide-accent)}.fallback-compare-column p{margin:0 0 28px;font-size:25px;line-height:1.4}.fallback-roadmap{display:flex;align-items:stretch;gap:0;margin-top:76px}.fallback-step{position:relative;flex:1;padding:74px 30px 28px;border-top:6px solid var(--slide-primary)}.fallback-step+.fallback-step{border-left:2px solid var(--slide-rule)}.fallback-step-number{position:absolute;top:18px;left:30px;color:var(--slide-primary);font-size:24px;font-weight:850}.fallback-step-text{font-size:24px;line-height:1.4}`;

function createFallbackSlideMarkup(slide: ArtifactSlide) {
  if (slide.kind === 'title') {
    return `<article class="fallback-slide fallback-title-slide"><h1 class="fallback-title">${escapeHtml(slide.title || props.deckTitle || '')}</h1><p class="fallback-summary">${escapeHtml(props.executiveSummary ?? '')}</p><div class="fallback-audience">${escapeHtml(props.audience ?? '')}</div></article>`;
  }
  const label = slide.kind === 'comparison' ? '对比' : slide.kind === 'closing' ? '结论与行动' : '关键发现';
  const heading = `<div class="fallback-kicker">${label}</div><h1 class="fallback-title">${escapeHtml(slide.title)}</h1>`;
  if (slide.kind === 'comparison') {
    const midpoint = Math.max(1, Math.ceil(slide.bullets.length / 2));
    return `<article class="fallback-slide">${heading}<div class="fallback-compare"><section class="fallback-compare-column">${slide.bullets.slice(0, midpoint).map((item) => `<p>${escapeHtml(item)}</p>`).join('')}</section><section class="fallback-compare-column">${slide.bullets.slice(midpoint).map((item) => `<p>${escapeHtml(item)}</p>`).join('')}</section></div></article>`;
  }
  if (slide.kind === 'closing') {
    return `<article class="fallback-slide">${heading}<div class="fallback-roadmap">${slide.bullets.map((item, index) => `<section class="fallback-step"><div class="fallback-step-number">${String(index + 1).padStart(2, '0')}</div><div class="fallback-step-text">${escapeHtml(item)}</div></section>`).join('')}</div></article>`;
  }
  return `<article class="fallback-slide">${heading}<div class="fallback-points">${slide.bullets.map((item, index) => `<section class="fallback-point"><div class="fallback-index">${String(index + 1).padStart(2, '0')}</div><div class="fallback-point-text">${escapeHtml(item)}</div></section>`).join('')}</div></article>`;
}

function previewThemeColors() {
  const primary = props.branding?.primaryColor?.replace(/^#/, '').toUpperCase()
    ?? ({ research: '174A67', technical: '0F5D62', business: '315C4C' }[props.theme ?? 'research']);
  const accent = ({ research: 'D97757', technical: 'D49A45', business: 'C9855B' }[props.theme ?? 'research']);
  return { primary, accent };
}

function cssFont(value: string) {
  const safe = value.replace(/[^A-Za-z0-9\u3400-\u9FFF ,._-]/g, '').trim() || 'Arial';
  return `'${safe}', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character] ?? character));
}
</script>

<template>
  <div class="presentation-preview flex h-full flex-col gap-3">
    <p class="m-0 text-center text-[10px] text-[var(--agent-text-muted)]">
      {{ currentSlide?.html ? '16:9 同源样式预览' : '统一兼容布局预览' }}
    </p>

    <div class="mx-auto w-full" style="max-width: 640px;">
      <!-- 16:9 canvas -->
      <div
        ref="previewCanvas"
        class="relative w-full overflow-hidden rounded-lg border border-[var(--agent-border)] bg-[#f7f5f0] shadow-lg"
        style="aspect-ratio: 16/9;"
        role="img"
        :aria-label="`幻灯片预览：${currentSlide?.title ?? '无内容'}`"
      >
        <iframe
          v-if="currentSlide"
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
        <div v-else class="absolute inset-0 flex items-center justify-center text-[#667178] text-sm">
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
