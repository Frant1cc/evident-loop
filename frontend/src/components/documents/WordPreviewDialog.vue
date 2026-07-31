<script setup lang="ts">
import {
  PhDownloadSimple,
  PhFileDoc,
  PhSpinnerGap,
  PhWarningCircle,
  PhX
} from '@phosphor-icons/vue';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { WordArtifact } from '../../types/artifacts';

const maxPreviewBytes = 25 * 1024 * 1024;

const props = defineProps<{
  artifact?: WordArtifact;
}>();

const emit = defineEmits<{
  close: [];
}>();

const previewHost = ref<HTMLElement>();
const closeButton = ref<HTMLButtonElement>();
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const errorMessage = ref('');
let requestController: AbortController | undefined;
let renderSequence = 0;
let previousBodyOverflow = '';
let bodyLocked = false;

watch(
  () => props.artifact,
  async (artifact) => {
    requestController?.abort();
    const sequence = ++renderSequence;

    if (!artifact) {
      status.value = 'idle';
      errorMessage.value = '';
      if (previewHost.value) previewHost.value.replaceChildren();
      unlockBodyScroll();
      return;
    }

    lockBodyScroll();
    status.value = 'loading';
    errorMessage.value = '';
    await nextTick();
    closeButton.value?.focus();
    previewHost.value?.replaceChildren();

    const controller = new AbortController();
    requestController = controller;

    try {
      const response = await fetch(artifact.previewUrl, { signal: controller.signal });
      if (response.status === 404) {
        throw new Error('文档已过期或不存在，请重新生成。');
      }
      if (!response.ok) {
        throw new Error(`预览加载失败（${response.status}）`);
      }

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
  if (props.artifact && event.key === 'Escape') emit('close');
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
      v-if="artifact"
      class="fixed inset-0 z-50 grid bg-black/45 p-3 backdrop-blur-[2px] md:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="word-preview-title"
      @mousedown.self="emit('close')"
    >
      <section class="grid min-h-0 w-full max-w-[1180px] justify-self-center overflow-hidden rounded-xl border border-black/15 bg-[#e8e6e0] shadow-2xl grid-rows-[auto_minmax(0,1fr)]">
        <header class="flex min-w-0 items-center gap-3 border-b border-black/10 bg-[#f8f7f3] px-3 py-2.5 md:px-4">
          <span class="grid size-9 shrink-0 place-items-center rounded-md bg-[#185ABD] text-white">
            <PhFileDoc :size="20" weight="fill" aria-hidden="true" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="m-0 font-mono text-[9px] font-bold uppercase tracking-[0.13em] text-[#77736b]">Word preview</p>
            <h2 id="word-preview-title" class="m-0 truncate text-sm font-bold text-[#24211d]" :title="artifact.fileName">{{ artifact.fileName }}</h2>
          </div>
          <a
            class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[#24211d] px-3 text-xs font-bold text-white no-underline transition-opacity hover:opacity-80"
            :href="artifact.downloadUrl"
            :download="artifact.fileName"
          >
            <PhDownloadSimple :size="15" weight="bold" aria-hidden="true" />
            <span class="max-sm:hidden">下载 Word</span>
          </a>
          <button
            ref="closeButton"
            type="button"
            class="grid size-9 shrink-0 place-items-center rounded-md text-[#625e57] transition-colors hover:bg-black/5 hover:text-[#24211d] focus:outline-none focus:ring-2 focus:ring-[#185ABD]"
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
              <p class="m-0 text-sm font-bold">正在排版文档…</p>
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
              <a class="text-xs font-bold text-[#185ABD] underline underline-offset-4" :href="artifact.downloadUrl" :download="artifact.fileName">尝试直接下载</a>
            </div>
          </div>

          <div ref="previewHost" class="word-preview-host min-h-full" :class="{ invisible: status !== 'ready' }" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.word-preview-host :deep(.docx-wrapper) {
  min-height: 100%;
  padding: 30px !important;
  background: transparent !important;
}

.word-preview-host :deep(section.docx) {
  margin: 0 auto 24px !important;
  box-shadow:
    0 1px 2px rgb(25 22 18 / 18%),
    0 16px 34px rgb(25 22 18 / 16%) !important;
}

@media (max-width: 640px) {
  .word-preview-host :deep(.docx-wrapper) {
    padding: 14px !important;
  }

  .word-preview-host :deep(section.docx) {
    transform-origin: top left;
  }
}
</style>
