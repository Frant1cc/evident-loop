<script setup lang="ts">
import DOMPurify from 'dompurify';
import { computed, nextTick, onBeforeUnmount, ref, toRef, watch } from 'vue';

import StreamingCodeBlock from '../markdown/StreamingCodeBlock.vue';
import StreamingTableBlock from '../markdown/StreamingTableBlock.vue';
import { useStreamingMarkdownDisplay } from '../../composables/useStreamingMarkdownDisplay';
import { renderMarkdown } from '../../markdown/renderer';

const props = withDefaults(defineProps<{
  content: string;
  streaming?: boolean;
}>(), {
  streaming: false
});

const emit = defineEmits<{
  citation: [key: string];
}>();

const root = ref<HTMLElement>();
const finalHtml = ref('');
const copyTimers = new Set<number>();

const { segments } = useStreamingMarkdownDisplay(toRef(props, 'content'), toRef(props, 'streaming'));

const renderedSegments = computed(() =>
  segments.value.map((segment) =>
    segment.kind === 'markdown'
      ? { ...segment, html: renderMarkdown(segment.raw, true) }
      : segment
  )
);

watch(
  () => [props.content, props.streaming] as const,
  ([content, streaming]) => {
    if (streaming) {
      finalHtml.value = '';
      return;
    }
    finalHtml.value = renderMarkdown(content);
    void enhanceCodeBlocks();
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  for (const timer of copyTimers) window.clearTimeout(timer);
  copyTimers.clear();
});

async function enhanceCodeBlocks() {
  await nextTick();
  const container = root.value;
  if (!container) return;
  const blocks = [...container.querySelectorAll<HTMLElement>('[data-code-block][data-code-state="complete"]:not([data-highlighted])')];
  if (!blocks.length) return;

  const { highlightCode } = await import('../../markdown/codeHighlighter');
  for (const block of blocks) {
    if (!block.isConnected || block.dataset.highlighted) continue;
    const code = block.querySelector<HTMLElement>('code');
    if (!code) continue;
    const highlighted = highlightCode(code.textContent ?? '', block.dataset.language ?? '');
    if (highlighted) {
      code.innerHTML = DOMPurify.sanitize(highlighted, {
        ALLOWED_TAGS: ['span'],
        ALLOWED_ATTR: ['class']
      });
    }
    block.dataset.highlighted = 'true';
  }
}

async function handleClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  const copyButton = target?.closest<HTMLButtonElement>('[data-copy-code]');
  if (copyButton) {
    event.preventDefault();
    await copyCode(copyButton);
    return;
  }

  const citation = target?.closest<HTMLElement>('[data-citation-key]');
  if (!citation) return;
  event.preventDefault();
  emit('citation', citation.dataset.citationKey ?? '');
}

async function copyCode(button: HTMLButtonElement) {
  const code = button.closest('[data-code-block]')?.querySelector('code')?.textContent ?? '';
  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  try {
    await navigator.clipboard.writeText(code);
    button.dataset.copyState = 'success';
    if (label) label.textContent = '已复制';
  } catch {
    button.dataset.copyState = 'error';
    if (label) label.textContent = '复制失败';
  }

  const timer = window.setTimeout(() => {
    copyTimers.delete(timer);
    if (!button.isConnected) return;
    delete button.dataset.copyState;
    if (label) label.textContent = '复制';
  }, 1_600);
  copyTimers.add(timer);
}
</script>

<template>
  <div ref="root" class="markdown-message" @click="handleClick">
    <template v-if="streaming">
      <template v-for="segment in renderedSegments" :key="segment.id">
        <div v-if="segment.kind === 'markdown'" class="markdown-segment" v-html="segment.html" />
        <StreamingCodeBlock
          v-else-if="segment.kind === 'code'"
          :language="segment.language"
          :lines="segment.lines"
          :current-line="segment.currentLine"
          :status="segment.status"
        />
        <StreamingTableBlock
          v-else
          :header-cells="segment.headerCells"
          :alignments="segment.alignments"
          :completed-rows="segment.completedRows"
          :current-row="segment.currentRow"
          :status="segment.status"
        />
      </template>
    </template>
    <div v-else-if="finalHtml" class="markdown-segment markdown-tail" v-html="finalHtml" />
  </div>
</template>

<style scoped>
.markdown-message {
  overflow-wrap: anywhere;
  color: inherit;
  font-size: 15px;
  line-height: 1.65;
}

.markdown-segment + .markdown-segment {
  margin-top: 0.75rem;
}

.markdown-message :deep(*) {
  margin: 0;
}

.markdown-message :deep(p + p),
.markdown-message :deep(p + ul),
.markdown-message :deep(p + ol),
.markdown-message :deep(ul + p),
.markdown-message :deep(ol + p),
.markdown-message :deep(blockquote + p),
.markdown-message :deep(.markdown-code-block + p) {
  margin-top: 0.75rem;
}

.markdown-message :deep(h1),
.markdown-message :deep(h2),
.markdown-message :deep(h3) {
  margin: 0.15rem 0 0.55rem;
  color: inherit;
  font-weight: 750;
  letter-spacing: 0;
  line-height: 1.25;
}

.markdown-message :deep(h1) {
  font-size: 1.25rem;
}

.markdown-message :deep(h2) {
  font-size: 1.12rem;
}

.markdown-message :deep(h3) {
  font-size: 1rem;
}

.markdown-message :deep(strong) {
  font-weight: 750;
}

.markdown-message :deep(a) {
  color: inherit;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.markdown-message :deep(.markdown-citation) {
  margin: 0 0.15rem;
  border: 1px solid var(--agent-selected-border);
  border-radius: 4px;
  background: var(--agent-selected-bg);
  color: var(--agent-selected-text);
  padding: 0.03rem 0.3rem;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.markdown-message :deep(.markdown-citation:hover),
.markdown-message :deep(.markdown-citation:focus-visible) {
  border-color: var(--agent-text-muted);
  background: var(--agent-surface);
  outline: none;
}

.markdown-message :deep(ul),
.markdown-message :deep(ol) {
  display: grid;
  gap: 0.35rem;
  padding-left: 1.15rem;
}

.markdown-message :deep(li::marker) {
  color: var(--agent-text-muted);
}

.markdown-message :deep(blockquote) {
  border-left: 3px solid var(--agent-selected-border);
  color: var(--agent-text-muted);
  padding-left: 0.85rem;
}

.markdown-message :deep(hr) {
  margin: 1.25rem 0;
  border: 0;
  border-top: 1px solid var(--agent-border);
}

.markdown-message :deep(code) {
  border: 1px solid var(--agent-border);
  border-radius: 5px;
  background: var(--agent-surface-muted);
  padding: 0.1rem 0.32rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
}

.markdown-message :deep(.markdown-code-block) {
  margin-top: 0.8rem;
  overflow: hidden;
  border: 1px solid var(--code-border);
  border-radius: 8px;
  background: var(--code-background);
  box-shadow: 0 1px 2px color-mix(in oklch, var(--foreground), transparent 96%);
}

.markdown-message :deep(.markdown-code-toolbar) {
  display: flex;
  min-height: 2.2rem;
  align-items: center;
  gap: 0.55rem;
  border-bottom: 1px solid var(--code-border);
  background: var(--code-toolbar);
  padding: 0 0.55rem 0 0.8rem;
}

.markdown-message :deep(.markdown-code-language) {
  color: var(--code-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.markdown-message :deep(.markdown-code-state) {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: #8a5a14;
  font-size: 0.68rem;
  font-weight: 650;
}

.markdown-message :deep(.markdown-code-state::before) {
  width: 0.34rem;
  height: 0.34rem;
  border-radius: 999px;
  background: #b7791f;
  content: '';
  animation: markdown-code-pulse 1.2s ease-in-out infinite;
}

.markdown-message :deep(.markdown-code-copy) {
  margin-left: auto;
  border-radius: 4px;
  background: transparent;
  color: var(--code-muted);
  padding: 0.28rem 0.48rem;
  font-size: 0.7rem;
  font-weight: 700;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
}

.markdown-message :deep(.markdown-code-copy:hover:not(:disabled)),
.markdown-message :deep(.markdown-code-copy:focus-visible) {
  background: var(--code-border);
  color: var(--code-foreground);
  outline: none;
}

.markdown-message :deep(.markdown-code-copy:disabled) {
  cursor: wait;
  opacity: 0.45;
}

.markdown-message :deep(.markdown-code-copy[data-copy-state='success']) {
  color: #287a4b;
}

.markdown-message :deep(.markdown-code-copy[data-copy-state='error']) {
  color: #a13c3c;
}

.markdown-message :deep(.markdown-code-block pre) {
  overflow-x: auto;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 1rem;
}

.markdown-message :deep(.markdown-code-block pre code) {
  display: block;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--code-foreground);
  padding: 0;
  font-size: 0.88rem;
  line-height: 1.65;
  white-space: pre;
}

.markdown-message :deep(.hljs-comment),
.markdown-message :deep(.hljs-quote) {
  color: var(--code-muted);
  font-style: italic;
}

.markdown-message :deep(.hljs-keyword),
.markdown-message :deep(.hljs-selector-tag),
.markdown-message :deep(.hljs-subst) {
  color: #9b2c4e;
}

.markdown-message :deep(.hljs-string),
.markdown-message :deep(.hljs-doctag),
.markdown-message :deep(.hljs-regexp) {
  color: #1f6f5c;
}

.markdown-message :deep(.hljs-number),
.markdown-message :deep(.hljs-literal),
.markdown-message :deep(.hljs-variable),
.markdown-message :deep(.hljs-template-variable) {
  color: #8a4b08;
}

.markdown-message :deep(.hljs-title),
.markdown-message :deep(.hljs-title.function_),
.markdown-message :deep(.hljs-section) {
  color: #5b4aa3;
}

.markdown-message :deep(.hljs-type),
.markdown-message :deep(.hljs-built_in),
.markdown-message :deep(.hljs-attribute),
.markdown-message :deep(.hljs-attr) {
  color: #8a5a14;
}

.markdown-message :deep(.hljs-tag),
.markdown-message :deep(.hljs-name),
.markdown-message :deep(.hljs-selector-class),
.markdown-message :deep(.hljs-selector-id) {
  color: #25635b;
}

.markdown-message :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin-top: 0.8rem;
}

.markdown-message :deep(th),
.markdown-message :deep(td) {
  border: 1px solid var(--agent-border);
  padding: 0.45rem 0.65rem;
  text-align: left;
}

.markdown-message :deep(th) {
  background: var(--agent-surface-muted);
  font-weight: 750;
}

@keyframes markdown-code-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.82); }
  50% { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .markdown-message :deep(.markdown-code-state::before) {
    animation: none;
  }
}
</style>
