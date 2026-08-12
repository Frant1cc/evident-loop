<script setup lang="ts">
import DOMPurify from 'dompurify';
import { computed, ref, watch } from 'vue';

import { HIGHLIGHT_MAX_CHARS } from '../../markdown/highlightLimits';
import { getLanguageLabel, normalizeLanguage } from '../../markdown/renderer';
import type { BlockStatus } from '../../markdown/structuredBlockDetector';
import StructuredBlockStatus from './StructuredBlockStatus.vue';

const props = defineProps<{
  language: string;
  lines: string[];
  currentLine: string;
  status: BlockStatus;
}>();

/** Rows beyond this count collapse behind a "展开全部" toggle (plan §3.4). */
const FOLD_THRESHOLD = 24;

const expanded = ref(false);
const copyState = ref<'idle' | 'success' | 'error'>('idle');
let copyTimer: number | undefined;

const normalizedLanguage = computed(() => normalizeLanguage(props.language));
const label = computed(() => getLanguageLabel(normalizedLanguage.value));

const allLines = computed(() => {
  const rows = props.lines.slice();
  if (props.status === 'generating' && props.currentLine.length > 0) rows.push(props.currentLine);
  return rows;
});

const plainText = computed(() => allLines.value.join('\n'));

const isComplete = computed(() => props.status !== 'generating');
const tooLongToHighlight = computed(() => plainText.value.length > HIGHLIGHT_MAX_CHARS);

const foldable = computed(() => allLines.value.length > FOLD_THRESHOLD);
const visibleLines = computed(() =>
  foldable.value && !expanded.value ? allLines.value.slice(0, FOLD_THRESHOLD) : allLines.value
);
const hiddenCount = computed(() => allLines.value.length - visibleLines.value.length);

const highlightedHtml = ref<string | null>(null);

watch(
  [isComplete, plainText, normalizedLanguage, tooLongToHighlight],
  async ([complete, code, language, tooLong]) => {
    if (!complete || tooLong || !code) {
      highlightedHtml.value = null;
      return;
    }
    const { highlightCode } = await import('../../markdown/codeHighlighter');
    const highlighted = highlightCode(code, language);
    highlightedHtml.value = highlighted
      ? DOMPurify.sanitize(highlighted, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] })
      : null;
  },
  { immediate: true }
);

async function copy() {
  try {
    await navigator.clipboard.writeText(plainText.value);
    copyState.value = 'success';
  } catch {
    copyState.value = 'error';
  }
  if (copyTimer) window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    copyState.value = 'idle';
  }, 1_600);
}

const copyLabel = computed(() =>
  copyState.value === 'success' ? '已复制' : copyState.value === 'error' ? '复制失败' : '复制'
);
</script>

<template>
  <div class="stream-code-block" :data-code-state="status">
    <div class="stream-code-toolbar">
      <span class="stream-code-language">{{ label }}</span>
      <StructuredBlockStatus :status="status" />
      <button
        type="button"
        class="stream-code-copy"
        :data-copy-state="copyState === 'idle' ? undefined : copyState"
        :disabled="status === 'generating'"
        :aria-label="`复制 ${label} 代码`"
        @click="copy"
      >
        {{ copyLabel }}
      </button>
    </div>
    <pre><code
      v-if="highlightedHtml !== null"
      class="stream-code-content"
      v-html="highlightedHtml"
    /><code v-else class="stream-code-content">{{ visibleLines.join('\n') }}</code></pre>
    <button v-if="foldable && !expanded" type="button" class="stream-code-expand" @click="expanded = true">
      展开全部（还有 {{ hiddenCount }} 行）
    </button>
  </div>
</template>

<style scoped>
.stream-code-block {
  margin-top: 0.8rem;
  overflow: hidden;
  border: 1px solid #ddd8cd;
  border-radius: 8px;
  background: #f8f6f1;
  box-shadow: 0 1px 2px rgb(42 37 29 / 4%);
}

.stream-code-toolbar {
  display: flex;
  min-height: 2.2rem;
  align-items: center;
  gap: 0.55rem;
  border-bottom: 1px solid #ddd8cd;
  background: #f0ede6;
  padding: 0 0.55rem 0 0.8rem;
}

.stream-code-language {
  color: #6f695f;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.stream-code-block :deep(.markdown-code-state) {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: #8a5a14;
  font-size: 0.68rem;
  font-weight: 650;
}

.stream-code-block :deep(.markdown-code-state::before) {
  width: 0.34rem;
  height: 0.34rem;
  border-radius: 999px;
  background: #b7791f;
  content: '';
  animation: stream-code-pulse 1.2s ease-in-out infinite;
}

.stream-code-copy {
  margin-left: auto;
  border-radius: 4px;
  background: transparent;
  color: #6f695f;
  padding: 0.28rem 0.48rem;
  font-size: 0.7rem;
  font-weight: 700;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
}

.stream-code-copy:hover:not(:disabled),
.stream-code-copy:focus-visible {
  background: #e4dfd4;
  color: #24211d;
  outline: none;
}

.stream-code-copy:disabled {
  cursor: wait;
  opacity: 0.45;
}

.stream-code-copy[data-copy-state='success'] {
  color: #287a4b;
}

.stream-code-copy[data-copy-state='error'] {
  color: #a13c3c;
}

.stream-code-block pre {
  margin: 0;
  overflow-x: auto;
  padding: 1rem;
}

.stream-code-content {
  display: block;
  border: 0;
  background: transparent;
  color: #2d2a26;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.88rem;
  line-height: 1.65;
  white-space: pre;
}

.stream-code-expand {
  display: block;
  width: 100%;
  border: 0;
  border-top: 1px solid #ddd8cd;
  background: #f0ede6;
  color: #6f695f;
  padding: 0.4rem;
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
}

.stream-code-expand:hover,
.stream-code-expand:focus-visible {
  background: #e4dfd4;
  color: #24211d;
  outline: none;
}

.stream-code-content :deep(.hljs-comment),
.stream-code-content :deep(.hljs-quote) {
  color: #7b756d;
  font-style: italic;
}

.stream-code-content :deep(.hljs-keyword),
.stream-code-content :deep(.hljs-selector-tag),
.stream-code-content :deep(.hljs-subst) {
  color: #9b2c4e;
}

.stream-code-content :deep(.hljs-string),
.stream-code-content :deep(.hljs-doctag),
.stream-code-content :deep(.hljs-regexp) {
  color: #1f6f5c;
}

.stream-code-content :deep(.hljs-number),
.stream-code-content :deep(.hljs-literal),
.stream-code-content :deep(.hljs-variable),
.stream-code-content :deep(.hljs-template-variable) {
  color: #8a4b08;
}

.stream-code-content :deep(.hljs-title),
.stream-code-content :deep(.hljs-title.function_),
.stream-code-content :deep(.hljs-section) {
  color: #5b4aa3;
}

.stream-code-content :deep(.hljs-type),
.stream-code-content :deep(.hljs-built_in),
.stream-code-content :deep(.hljs-attribute),
.stream-code-content :deep(.hljs-attr) {
  color: #8a5a14;
}

.stream-code-content :deep(.hljs-tag),
.stream-code-content :deep(.hljs-name),
.stream-code-content :deep(.hljs-selector-class),
.stream-code-content :deep(.hljs-selector-id) {
  color: #25635b;
}

@keyframes stream-code-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.82); }
  50% { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .stream-code-block :deep(.markdown-code-state::before) {
    animation: none;
  }
}
</style>
