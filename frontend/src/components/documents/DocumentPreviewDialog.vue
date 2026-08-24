<script setup lang="ts">
import {
  PhDownloadSimple,
  PhFileDoc,
  PhFilePdf,
  PhFilePpt,
  PhSpinnerGap,
  PhWarningCircle,
  PhX
} from '@phosphor-icons/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { ArtifactOutput } from '../../types/artifacts';
import PresentationPreview from './PresentationPreview.vue';

const maxPreviewBytes = 25 * 1024 * 1024;

const props = defineProps<{
  output?: ArtifactOutput;
}>();

const emit = defineEmits<{
  close: [];
}>();

const previewHost = ref<HTMLElement>();
const closeButton = ref<HTMLButtonElement>();
const currentSlideId = ref<string>();
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const errorMessage = ref('');
let requestController: AbortController | undefined;
let renderSequence = 0;
let previousBodyOverflow = '';
let bodyLocked = false;

const formatLabel = computed(() => props.output?.format.toUpperCase() ?? 'FILE');
const fileName = computed(() => props.output?.fileName ?? `document.${props.output?.format ?? 'file'}`);
const previewUrl = computed(() => props.output?.previewUrl ?? props.output?.downloadUrl);
const slides = computed(() => props.output?.renderedSpec?.presentation.slides ?? []);
const formatIcon = computed(() => {
  if (props.output?.format === 'pdf') return PhFilePdf;
  if (props.output?.format === 'pptx') return PhFilePpt;
  return PhFileDoc;
});
const accentClass = computed(() => {
  if (props.output?.format === 'pdf') return 'bg-[#c53b32]';
  if (props.output?.format === 'pptx') return 'bg-[#c44a26]';
  return 'bg-[#185abd]';
});

watch(
  () => props.output,
  async (output) => {
    requestController?.abort();
    const sequence = ++renderSequence;
    previewHost.value?.replaceChildren();
    errorMessage.value = '';

    if (!output) {
      status.value = 'idle';
      unlockBodyScroll();
      return;
    }

    lockBodyScroll();
    await nextTick();
    closeButton.value?.focus();

    if (output.format === 'pptx') {
      currentSlideId.value = slides.value[0]?.id;
      status.value = slides.value.length ? 'ready' : 'error';
      if (!slides.value.length) errorMessage.value = '此演示文稿没有可用的逐页预览数据，请下载后查看。';
      return;
    }

    if (output.format === 'pdf') {
      status.value = previewUrl.value ? 'loading' : 'error';
      if (!previewUrl.value) errorMessage.value = 'PDF 文件地址不可用，请重新生成。';
      return;
    }

    if (!previewUrl.value) {
      status.value = 'error';
      errorMessage.value = 'Word 文件地址不可用，请重新生成。';
      return;
    }

    status.value = 'loading';
    const controller = new AbortController();
    requestController = controller;
    try {
      const response = await fetch(previewUrl.value, { signal: controller.signal });
      if (!response.ok) throw new Error(`预览加载失败（${response.status}）`);
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > maxPreviewBytes) {
        throw new Error('文档超过 25 MB，请下载后使用 Word 打开。');
      }
      const documentData = await response.arrayBuffer();
      if (documentData.byteLength > maxPreviewBytes) {
        throw new Error('文档超过 25 MB，请下载后使用 Word 打开。');
      }
      const host = previewHost.value;
      if (!host || controller.signal.aborted || sequence !== renderSequence) return;
      const { renderAsync } = await import('docx-preview');
      await renderAsync(documentData, host, host, {
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: false,
        renderAltChunks: false,
        experimental: false,
        useBase64URL: true
      });
      if (!controller.signal.aborted && sequence === renderSequence) status.value = 'ready';
    } catch (error) {
      if (controller.signal.aborted || sequence !== renderSequence) return;
      status.value = 'error';
      errorMessage.value = error instanceof Error ? error.message : '文档预览失败';
    }
  },
  { immediate: true, flush: 'post' }
);

onMounted(() => window.addEventListener('keydown', handleKeydown));
onBeforeUnmount(() => {
  requestController?.abort();
  window.removeEventListener('keydown', handleKeydown);
  unlockBodyScroll();
});

function handleKeydown(event: KeyboardEvent) {
  if (props.output && event.key === 'Escape') emit('close');
}

function lockBodyScroll() {
  if (bodyLocked) return;
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  bodyLocked = true;
}

function unlockBodyScroll() {
  if (!bodyLocked) return;
  document.body.style.overflow = previousBodyOverflow;
  bodyLocked = false;
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="output"
      class="fixed inset-0 z-[70] grid bg-black/55 p-3 backdrop-blur-[3px] md:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-preview-title"
      @mousedown.self="emit('close')"
    >
      <section class="grid min-h-0 w-full max-w-[1220px] grid-rows-[auto_minmax(0,1fr)] justify-self-center overflow-hidden rounded-xl border border-black/15 bg-[#e8e6e0] shadow-2xl">
        <header class="flex min-w-0 items-center gap-3 border-b border-black/10 bg-[#f8f7f3] px-3 py-2.5 md:px-4">
          <span class="grid size-9 shrink-0 place-items-center rounded-md text-white" :class="accentClass">
            <component :is="formatIcon" :size="20" weight="fill" aria-hidden="true" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="m-0 font-mono text-[9px] font-bold uppercase tracking-[0.13em] text-[#77736b]">{{ formatLabel }} preview</p>
            <h2 id="document-preview-title" class="m-0 truncate text-sm font-bold text-[#24211d]" :title="fileName">{{ fileName }}</h2>
          </div>
          <a
            v-if="output.downloadUrl"
            class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[#24211d] px-3 text-xs font-bold text-white no-underline transition-opacity hover:opacity-80"
            :href="output.downloadUrl"
            :download="output.fileName"
          >
            <PhDownloadSimple :size="15" weight="bold" aria-hidden="true" />
            <span class="max-sm:hidden">下载 {{ formatLabel }}</span>
          </a>
          <button
            ref="closeButton"
            type="button"
            class="grid size-9 shrink-0 place-items-center rounded-md text-[#625e57] transition-colors hover:bg-black/5 hover:text-[#24211d] focus:outline-none focus:ring-2 focus:ring-[#24211d]"
            aria-label="关闭文档预览"
            @click="emit('close')"
          >
            <PhX :size="18" weight="bold" aria-hidden="true" />
          </button>
        </header>

        <div class="relative min-h-0 overflow-auto bg-[#b8b5ae]">
          <div v-if="status === 'loading'" class="absolute inset-0 z-10 grid place-items-center bg-[#b8b5ae]">
            <div class="grid justify-items-center gap-3 rounded-lg bg-[#f8f7f3] px-6 py-5 text-[#3d3933] shadow-lg">
              <PhSpinnerGap class="animate-spin" :size="25" weight="bold" aria-hidden="true" />
              <p class="m-0 text-sm font-bold">正在加载预览…</p>
            </div>
          </div>

          <div v-if="status === 'error'" class="absolute inset-0 z-10 grid place-items-center p-6">
            <div class="grid max-w-sm justify-items-center gap-3 rounded-lg border border-[#d8d3ca] bg-[#f8f7f3] px-7 py-6 text-center shadow-lg">
              <span class="grid size-11 place-items-center rounded-full bg-[#f7e3de] text-[#9c3e2f]">
                <PhWarningCircle :size="24" weight="fill" aria-hidden="true" />
              </span>
              <div>
                <p class="m-0 text-sm font-bold text-[#24211d]">无法预览文档</p>
                <p class="m-0 mt-1 text-xs leading-5 text-[#6d6860]">{{ errorMessage }}</p>
              </div>
            </div>
          </div>

          <iframe
            v-if="output.format === 'pdf' && previewUrl"
            :src="previewUrl"
            title="PDF 文件预览"
            class="h-full min-h-[70vh] w-full border-0 bg-white"
            @load="status = 'ready'"
          />

          <div v-else-if="output.format === 'pptx' && status === 'ready'" class="mx-auto h-full min-h-[70vh] max-w-5xl p-5 md:p-8">
            <div class="mb-3 rounded-md bg-[#f8f7f3] px-3 py-2 text-center text-xs text-[#6d6860] shadow-sm">
              逐页内容预览 · 最终字体与版式以下载文件为准
            </div>
            <PresentationPreview
              :slides="slides"
              :current-slide-id="currentSlideId"
              @update:current-slide-id="currentSlideId = $event"
            />
          </div>

          <div
            v-else-if="output.format === 'docx'"
            ref="previewHost"
            class="document-preview-word min-h-full"
            :class="{ invisible: status !== 'ready' }"
          />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.document-preview-word :deep(.docx-wrapper) {
  min-height: 100%;
  padding: 30px !important;
  background: transparent !important;
}

.document-preview-word :deep(section.docx) {
  margin: 0 auto 24px !important;
  box-shadow: 0 1px 2px rgb(25 22 18 / 18%), 0 16px 34px rgb(25 22 18 / 16%) !important;
}

@media (max-width: 640px) {
  .document-preview-word :deep(.docx-wrapper) { padding: 14px !important; }
}
</style>
