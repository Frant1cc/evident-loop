<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';

import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatSourceLocator } from '../../lib/sourceLocator';
import type { ResearchSource } from '../../types/research';

const props = defineProps<{
  sources: ResearchSource[];
  selectedSourceId?: string;
  /**
   * When true, render the entire conversation evidence cache grouped by the message that
   * retrieved each source. Defaults to false (flat single-turn list, current behavior).
   */
  showEvidenceCache?: boolean;
}>();

interface SourceGroup {
  messageId: string;
  sources: ResearchSource[];
}

const groupedSources = computed<SourceGroup[]>(() => {
  if (!props.showEvidenceCache) return [];
  const groups = new Map<string, ResearchSource[]>();
  for (const source of props.sources) {
    const bucket = groups.get(source.messageId) ?? [];
    bucket.push(source);
    groups.set(source.messageId, bucket);
  }
  // Preserve insertion order from `sources` (the DB returns them by created_at ASC).
  return Array.from(groups.entries()).map(([messageId, sources]) => ({ messageId, sources }));
});

function isWebSource(source: ResearchSource) {
  return source.file.startsWith('http://') || source.file.startsWith('https://');
}

function sourceLocation(source: ResearchSource) {
  return formatSourceLocator(source.locator, { startLine: source.startLine, endLine: source.endLine });
}

watch(
  () => props.selectedSourceId,
  async (sourceId) => {
    if (!sourceId) return;
    await nextTick();
    document.getElementById(`research-source-${sourceId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  { immediate: true }
);
</script>

<template>
  <section class="app-scrollbar min-h-0 overflow-auto">
    <div class="grid content-start gap-2 p-3">
      <div
        v-if="showEvidenceCache && sources.length"
        class="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2"
      >
        <div class="min-w-0">
          <p class="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">证据缓存</p>
          <p class="m-0 mt-0.5 text-[11px] leading-5 text-muted-foreground">
            压缩后仍可被 LLM 通过 <span class="font-mono">read_evidence</span> 引用。共 {{ sources.length }} 条，分布在 {{ groupedSources.length }} 轮回复中。
          </p>
        </div>
        <Badge variant="outline" class="shrink-0 font-mono">{{ sources.length }}</Badge>
      </div>

      <template v-if="showEvidenceCache">
        <div v-for="group in groupedSources" :key="group.messageId" class="grid content-start gap-2">
          <p class="m-0 mt-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            检索回合 · {{ group.sources.length }} 条
          </p>
          <article
            v-for="source in group.sources"
            :id="`research-source-${source.id}`"
            :key="source.id"
            class="rounded-lg border px-3 py-2.5 transition-colors"
            :class="source.id === selectedSourceId ? 'border-ring bg-muted' : 'border-border bg-background'"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="m-0 text-sm font-medium leading-5 text-foreground">{{ source.heading || source.title }}</p>
                <a
                  v-if="isWebSource(source)"
                  :href="source.file"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="m-0 mt-1 block truncate font-mono text-[10px] leading-4 text-primary hover:underline"
                >{{ source.file }}</a>
                <p v-else class="m-0 mt-1 truncate font-mono text-[10px] leading-4 text-muted-foreground">{{ source.file }}</p>
              </div>
              <Badge variant="outline" class="shrink-0 font-mono">[{{ source.citationKey }}]</Badge>
            </div>
            <div class="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
              <span v-if="source.score > 0" class="tabular-nums">相关度 {{ source.score.toFixed(3) }}</span>
              <span v-if="isWebSource(source)">网页来源</span>
              <span v-else class="tabular-nums">{{ sourceLocation(source) }}</span>
            </div>
            <p class="m-0 mt-2 line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-6 text-muted-foreground">{{ source.content }}</p>
            <Collapsible class="mt-2 border-t border-border pt-2">
              <CollapsibleTrigger class="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
                阅读全文片段
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p class="m-0 mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-[13px] leading-6 text-foreground">{{ source.content }}</p>
              </CollapsibleContent>
            </Collapsible>
          </article>
        </div>
      </template>

      <template v-else>
        <article
          v-for="source in sources"
          :id="`research-source-${source.id}`"
          :key="source.id"
          class="rounded-lg border px-3 py-2.5 transition-colors"
          :class="source.id === selectedSourceId ? 'border-ring bg-muted' : 'border-border bg-background'"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="m-0 text-sm font-medium leading-5 text-foreground">{{ source.heading || source.title }}</p>
              <a
                v-if="isWebSource(source)"
                :href="source.file"
                target="_blank"
                rel="noopener noreferrer"
                class="m-0 mt-1 block truncate font-mono text-[10px] leading-4 text-primary hover:underline"
              >{{ source.file }}</a>
              <p v-else class="m-0 mt-1 truncate font-mono text-[10px] leading-4 text-muted-foreground">{{ source.file }}</p>
            </div>
            <Badge variant="outline" class="shrink-0 font-mono">[{{ source.citationKey }}]</Badge>
          </div>
          <div class="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span v-if="source.score > 0" class="tabular-nums">相关度 {{ source.score.toFixed(3) }}</span>
            <span v-if="isWebSource(source)">网页来源</span>
            <span v-else class="tabular-nums">{{ sourceLocation(source) }}</span>
          </div>
          <p class="m-0 mt-2 line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-6 text-muted-foreground">{{ source.content }}</p>
          <Collapsible class="mt-2 border-t border-border pt-2">
            <CollapsibleTrigger class="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
              阅读全文片段
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p class="m-0 mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-[13px] leading-6 text-foreground">{{ source.content }}</p>
            </CollapsibleContent>
          </Collapsible>
        </article>
      </template>

      <p v-if="!sources.length" class="m-0 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm leading-6 text-muted-foreground">
        暂无检索来源。
      </p>
    </div>
  </section>
</template>
