<script setup lang="ts">
import { ref } from 'vue';
import { formatSourceLocator } from '../../lib/sourceLocator';
import type { AgentTraceStep, RagSource, ToolCallTrace } from '../../types/chat';

const activeInspectorTab = ref<'trace' | 'sources'>('trace');

defineProps<{
  content: string;
  loading: boolean;
  toolCalls: ToolCallTrace[];
  trace: AgentTraceStep[];
  sources: RagSource[];
}>();

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function getStatusLabel(step: AgentTraceStep) {
  if (step.type !== 'tool_result') return 'done';
  return step.toolCall.error ? 'failed' : 'done';
}

function isWebSource(source: RagSource) {
  return source.file.startsWith('http://') || source.file.startsWith('https://');
}

function sourceLocation(source: RagSource) {
  return formatSourceLocator(source.locator, { startLine: source.startLine, endLine: source.endLine });
}
</script>

<template>
  <aside class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l border-[var(--agent-border)] bg-[var(--agent-surface-muted)]" aria-label="智能体检查面板">
    <header class="border-b border-[var(--agent-border)] px-4 py-3.5">
      <p class="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--agent-text-muted)]">Agent Inspector</p>
      <div class="mt-2 grid grid-cols-2 rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-0.5">
        <button
          type="button"
          class="h-8 cursor-pointer rounded-[5px] px-2 text-xs font-bold transition-colors"
          :class="activeInspectorTab === 'trace' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]'"
          @click="activeInspectorTab = 'trace'"
        >
          调用过程
        </button>
        <button
          type="button"
          class="h-8 cursor-pointer rounded-[5px] px-2 text-xs font-bold transition-colors"
          :class="activeInspectorTab === 'sources' ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface-muted)] hover:text-[var(--agent-text)]'"
          @click="activeInspectorTab = 'sources'"
        >
          引用来源
        </button>
      </div>
    </header>

    <div class="grid min-h-0 content-start gap-3 overflow-auto px-4 py-3.5">
      <template v-if="activeInspectorTab === 'trace'">
        <section v-if="trace.length" class="grid gap-3">
          <article
            v-for="(step, index) in trace"
            :key="`${step.type}-${index}`"
            class="rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"
          >
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">Step {{ index + 1 }}</p>
                <h3 class="m-0 mt-1 text-sm font-bold leading-5 text-[var(--agent-text)]">{{ step.label }}</h3>
              </div>
              <span
                class="rounded-md px-2 py-1 font-mono text-[10px] font-bold uppercase"
                :class="step.type === 'tool_result' && step.toolCall.error ? 'bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]' : 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]'"
              >
                {{ getStatusLabel(step) }}
              </span>
            </div>

            <div v-if="step.type === 'llm_call'" class="mt-3 grid gap-2 text-xs leading-5 text-[var(--agent-text-muted)]">
              <p class="m-0"><span class="font-mono font-bold uppercase tracking-[0.08em]">Model</span> {{ step.model }}</p>
              <p v-if="step.tools?.length" class="m-0"><span class="font-mono font-bold uppercase tracking-[0.08em]">Tools</span> {{ step.tools.join(', ') }}</p>
            </div>

            <div v-else-if="step.type === 'tool_decision'" class="mt-3 grid gap-2">
              <div v-for="toolCall in step.toolCalls" :key="toolCall.id" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-2">
                <p class="m-0 font-mono text-xs font-bold text-[var(--agent-text)]">{{ toolCall.name }}</p>
                <pre class="m-0 mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[var(--agent-text-muted)]">{{ formatJson(toolCall.arguments) }}</pre>
              </div>
            </div>

            <div v-else-if="step.type === 'tool_result'" class="mt-3 grid gap-2">
              <p class="m-0 font-mono text-xs font-bold text-[var(--agent-text)]">{{ step.toolCall.name }}</p>
              <pre class="m-0 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-2 font-mono text-[11px] leading-5 text-[var(--agent-text-muted)]">{{ formatJson(step.toolCall.error ? { error: step.toolCall.error } : step.toolCall.result) }}</pre>
            </div>
          </article>
        </section>

        <section v-else-if="toolCalls.length" class="grid gap-3">
          <article
            v-for="toolCall in toolCalls"
            :key="toolCall.id"
            class="rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"
          >
            <div class="flex items-center justify-between gap-3">
              <p class="m-0 font-mono text-xs font-bold text-[var(--agent-text)]">{{ toolCall.name }}</p>
              <span
                class="rounded-md px-2 py-1 font-mono text-[10px] font-bold uppercase"
                :class="toolCall.error ? 'bg-[var(--agent-error-bg)] text-[var(--agent-error-text)]' : 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]'"
              >
                {{ toolCall.error ? 'failed' : 'done' }}
              </span>
            </div>

            <div class="mt-3 grid gap-2">
              <div>
                <p class="m-0 mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">Arguments</p>
                <pre class="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-2 font-mono text-[11px] leading-5 text-[var(--agent-text-muted)]">{{ formatJson(toolCall.arguments) }}</pre>
              </div>

              <div>
                <p class="m-0 mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">Result</p>
                <pre class="m-0 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface-muted)] p-2 font-mono text-[11px] leading-5 text-[var(--agent-text-muted)]">{{ formatJson(toolCall.error ? { error: toolCall.error } : toolCall.result) }}</pre>
              </div>
            </div>
          </article>
        </section>

        <section v-if="content" class="rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3">
          <p class="m-0 mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">Reasoning</p>
          <pre class="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-6 text-[var(--agent-text-muted)]">{{ content }}</pre>
        </section>

        <p v-if="!trace.length && !toolCalls.length && !content" class="m-0 text-sm font-semibold leading-6 text-[var(--agent-text-muted)]">
          {{ loading ? '等待智能体调用工具...' : '暂无调用过程。' }}
        </p>
      </template>

      <template v-else>
        <section v-if="sources.length" class="grid gap-3">
          <article
            v-for="source in sources"
            :key="source.id"
            class="rounded-lg border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <a
                  v-if="isWebSource(source)"
                  :href="source.file"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="m-0 block truncate font-mono text-xs font-bold text-[var(--agent-selected-text)] hover:underline"
                >{{ source.file }}</a>
                <p v-else class="m-0 truncate font-mono text-xs font-bold text-[var(--agent-text)]">{{ source.file }}</p>
                <h3 class="m-0 mt-1 text-sm font-bold leading-5 text-[var(--agent-text)]">
                  {{ source.headingPath?.join(' › ') || source.heading || source.title }}
                </h3>
              </div>
              <span class="rounded-md bg-[var(--agent-selected-bg)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--agent-selected-text)]">
                {{ source.score.toFixed(2) }}
              </span>
            </div>

            <p class="m-0 mt-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">
              <template v-if="isWebSource(source)">Web page</template>
              <template v-else>{{ sourceLocation(source) }}</template>
            </p>

            <p class="m-0 mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-[var(--agent-text-muted)]">
              {{ source.content }}
            </p>
          </article>
        </section>

        <p v-else class="m-0 text-sm font-semibold leading-6 text-[var(--agent-text-muted)]">
          {{ loading ? '等待检索引用来源...' : '暂无引用来源。' }}
        </p>
      </template>
    </div>
  </aside>
</template>
