<script setup lang="ts">
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { computed } from 'vue';

const props = defineProps<{
  content: string;
}>();

const emit = defineEmits<{
  citation: [key: string];
}>();

const markdown = new Marked({
  gfm: true,
  breaks: true
});

const html = computed(() => {
  const rendered = markdown.parse(props.content) as string;
  const citations = rendered.replace(
    /\[(S\d+)\]/g,
    '<button type="button" class="markdown-citation" data-citation-key="$1">[$1]</button>'
  );

  return DOMPurify.sanitize(citations, {
    ADD_ATTR: ['data-citation-key'],
    ADD_TAGS: ['button']
  });
});

function handleClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  const citation = target?.closest<HTMLElement>('[data-citation-key]');
  if (!citation) return;
  event.preventDefault();
  emit('citation', citation.dataset.citationKey ?? '');
}
</script>

<template>
  <div class="markdown-message" v-html="html" @click="handleClick" />
</template>

<style scoped>
.markdown-message {
  overflow-wrap: anywhere;
  color: var(--agent-text);
  font-size: 15px;
  line-height: 1.65;
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
.markdown-message :deep(pre + p) {
  margin-top: 0.75rem;
}

.markdown-message :deep(h1),
.markdown-message :deep(h2),
.markdown-message :deep(h3) {
  margin: 0.15rem 0 0.55rem;
  color: var(--agent-text);
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
  color: var(--agent-text);
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.markdown-message :deep(.markdown-citation) {
  margin: 0 0.15rem;
  border: 0;
  border-radius: 4px;
  background: var(--agent-selected-bg);
  color: var(--agent-selected-text);
  padding: 0.08rem 0.3rem;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
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

.markdown-message :deep(pre) {
  margin-top: 0.8rem;
  overflow-x: auto;
  border: 1px solid var(--agent-border);
  border-radius: 8px;
  background: #151515;
  padding: 1rem;
}

.markdown-message :deep(pre code) {
  display: block;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #f4f4f0;
  padding: 0;
  font-size: 0.88rem;
  line-height: 1.65;
  white-space: pre;
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
</style>
