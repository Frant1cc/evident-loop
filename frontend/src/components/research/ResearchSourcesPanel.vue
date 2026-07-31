<script setup lang="ts">
import { nextTick, watch } from 'vue';

import type { ResearchSource } from '../../types/research';

const props = defineProps<{
  sources: ResearchSource[];
  selectedSourceId?: string;
}>();

function isWebSource(source: ResearchSource) {
  return source.file.startsWith('http://') || source.file.startsWith('https://');
}

watch(
  () => props.selectedSourceId,
  async (sourceId) => {
    if (!sourceId) return;
    await nextTick();
    document.getElementById(`research-source-${sourceId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
);
</script>

<template>
  <section class="min-h-0 overflow-auto">
    <div class="grid content-start gap-3 p-4">
      <article
        v-for="source in sources"
        :id="`research-source-${source.id}`"
        :key="source.id"
        class="rounded-md border p-3.5 transition-colors"
        :class="source.id === selectedSourceId ? 'border-[var(--agent-selected-border)] bg-[var(--agent-selected-bg)]' : 'border-[var(--agent-border)] bg-[var(--agent-surface)]'"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="m-0 text-sm font-bold leading-5 text-[var(--agent-text)]">{{ source.heading || source.title }}</p>
            <a
              v-if="isWebSource(source)"
              :href="source.file"
              target="_blank"
              rel="noopener noreferrer"
              class="m-0 mt-1 block truncate font-mono text-[10px] leading-4 text-[var(--agent-selected-text)] hover:underline"
            >{{ source.file }}</a>
            <p v-else class="m-0 mt-1 truncate font-mono text-[10px] leading-4 text-[var(--agent-text-muted)]">{{ source.file }}</p>
          </div>
          <span class="shrink-0 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--agent-text)]">[{{ source.citationKey }}]</span>
        </div>
        <div class="mt-2.5 flex items-center gap-3 text-[11px] text-[var(--agent-text-muted)]"><span v-if="source.score > 0">相关度 {{ source.score.toFixed(3) }}</span><span v-if="isWebSource(source)">网页来源</span><span v-else>第 {{ source.startLine }}–{{ source.endLine }} 行</span></div>
        <p class="m-0 mt-3 line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--agent-text-muted)]">{{ source.content }}</p>
        <details class="mt-3 border-t border-[var(--agent-border)] pt-2.5"><summary class="cursor-pointer text-xs font-semibold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">阅读全文片段</summary><p class="m-0 mt-2 whitespace-pre-wrap break-words rounded-md bg-[var(--agent-surface-muted)] p-3 text-[13px] leading-6 text-[var(--agent-text)]">{{ source.content }}</p></details>
      </article>
      <p v-if="!sources.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm leading-6 text-[var(--agent-text-muted)]">暂无检索来源。</p>
    </div>
  </section>
</template>
