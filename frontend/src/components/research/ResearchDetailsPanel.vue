<script setup lang="ts">
import { ref } from 'vue';

import type { ResearchNote, ResearchPromptPreview, ResearchStep } from '../../types/research';

type DetailsTab = 'notes' | 'memory' | 'tool' | 'prompt';

const props = defineProps<{
  activeTab: DetailsTab;
  notes: ResearchNote[];
  promptPreview: ResearchPromptPreview;
  selectedStep?: ResearchStep;
}>();

const emit = defineEmits<{
  changeTab: [tab: DetailsTab];
  createNote: [content: string];
  updateNote: [note: ResearchNote, content: string];
  deleteNote: [note: ResearchNote];
}>();
const noteContent = ref('');

function saveNote() {
  const content = noteContent.value.trim();
  if (!content) return;
  emit('createNote', content);
  noteContent.value = '';
}

function formatJson(value: unknown) {
  return value === undefined ? '暂无数据' : JSON.stringify(value, null, 2);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function inputSummary(value: unknown) {
  const input = toRecord(value);
  const summary = input?.query ?? input?.path ?? input?.file ?? input?.expression;
  return typeof summary === 'string' ? summary : undefined;
}

function resultItems(value: unknown) {
  const results = toRecord(value)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    const record = toRecord(item);
    if (!record) return [];
    return [{
      title: String(record.title ?? record.file ?? '未命名结果'),
      heading: typeof record.heading === 'string' ? record.heading : undefined,
      score: typeof record.score === 'number' ? record.score : undefined
    }];
  });
}

function toRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
</script>

<template>
  <section class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-[var(--agent-surface-muted)]">
    <header class="grid grid-cols-4 gap-1 border-b border-[var(--agent-border)] px-4 py-3">
      <button v-for="tab in [{ key: 'notes', label: '笔记' }, { key: 'memory', label: '记忆' }, { key: 'tool', label: '工具' }, { key: 'prompt', label: '问题' }]" :key="tab.key" type="button" class="h-8 rounded-md px-2 text-xs font-bold" :class="props.activeTab === tab.key ? 'bg-[var(--agent-selected-bg)] text-[var(--agent-selected-text)]' : 'text-[var(--agent-text-muted)] hover:bg-[var(--agent-surface)]'" @click="emit('changeTab', tab.key as DetailsTab)">
        {{ tab.label }}
      </button>
    </header>
    <div class="min-h-0 overflow-auto p-4">
      <div v-if="props.activeTab === 'notes'" class="grid gap-3.5">
        <textarea v-model="noteContent" rows="4" class="w-full resize-y rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3 text-sm leading-6 text-[var(--agent-text)] outline-none focus:border-[var(--agent-selected-border)] focus:ring-4 focus:ring-[var(--agent-focus-ring)]" placeholder="记录研究结论或待办" />
        <button type="button" class="justify-self-start rounded-md bg-[var(--agent-selected-bg)] px-3.5 py-2 text-xs font-bold text-[var(--agent-selected-text)]" @click="saveNote">添加笔记</button>
        <article v-for="note in props.notes" :key="note.id" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5">
          <p class="m-0 whitespace-pre-wrap text-sm leading-6 text-[var(--agent-text)]">{{ note.content }}</p>
          <div class="mt-3 flex items-center justify-between gap-3"><span class="text-[11px] text-[var(--agent-text-muted)]">{{ formatTime(note.updatedAt) }}</span><button type="button" class="text-xs font-bold text-[var(--agent-error-text)]" @click="emit('deleteNote', note)">删除</button></div>
        </article>
        <p v-if="!props.notes.length" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-8 text-center text-sm text-[var(--agent-text-muted)]">还没有研究笔记。</p>
      </div>
      <div v-else-if="props.activeTab === 'memory'" class="grid gap-3">
        <section class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><p class="m-0 text-xs font-bold text-[var(--agent-text-muted)]">研究主题</p><p class="m-0 mt-1.5 text-sm font-semibold leading-6 text-[var(--agent-text)]">{{ props.promptPreview.topic || '将在首次提问后生成' }}</p></section>
        <section class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><p class="m-0 text-xs font-bold text-[var(--agent-text-muted)]">摘要记忆</p><p class="m-0 mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-[var(--agent-text)]">{{ props.promptPreview.summary || '当前使用最近对话作为上下文。' }}</p></section>
        <section class="flex items-center justify-between rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><span class="text-xs font-bold text-[var(--agent-text-muted)]">进入上下文的历史消息</span><strong class="font-mono text-xl text-[var(--agent-text)]">{{ props.promptPreview.historyMessageCount }}</strong></section>
      </div>
      <div v-else-if="props.activeTab === 'tool'" class="grid gap-3">
        <p v-if="!props.selectedStep" class="m-0 rounded-md border border-dashed border-[var(--agent-border)] bg-[var(--agent-surface)] px-4 py-10 text-center text-sm leading-6 text-[var(--agent-text-muted)]">请先从“过程”中选择一个工具步骤。</p>
        <template v-else>
          <section class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><div class="flex items-start justify-between gap-3"><p class="m-0 text-sm font-bold leading-5 text-[var(--agent-text)]">{{ props.selectedStep.title }}</p><span class="shrink-0 rounded bg-[var(--agent-selected-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--agent-selected-text)]">{{ props.selectedStep.status === 'complete' ? '已完成' : props.selectedStep.status === 'running' ? '执行中' : '失败' }}</span></div><p class="m-0 mt-2 text-[11px] text-[var(--agent-text-muted)]">{{ formatTime(props.selectedStep.startedAt) }}</p></section>
          <section v-if="inputSummary(props.selectedStep.input)" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><p class="m-0 text-xs font-bold text-[var(--agent-text-muted)]">调用内容</p><p class="m-0 mt-1.5 break-words text-[13px] font-semibold leading-6 text-[var(--agent-text)]">{{ inputSummary(props.selectedStep.input) }}</p></section>
          <section v-if="resultItems(props.selectedStep.output).length" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><p class="m-0 mb-2.5 text-xs font-bold text-[var(--agent-text)]">命中来源 · {{ resultItems(props.selectedStep.output).length }}</p><ol class="m-0 grid list-none gap-2 p-0"><li v-for="(item, index) in resultItems(props.selectedStep.output)" :key="`${item.title}-${item.heading}-${index}`" class="rounded-md bg-[var(--agent-surface-muted)] px-3 py-2"><div class="flex items-start justify-between gap-2"><strong class="text-xs leading-5 text-[var(--agent-text)]">{{ item.title }}</strong><span v-if="item.score !== undefined" class="shrink-0 font-mono text-[10px] text-[var(--agent-text-muted)]">{{ item.score.toFixed(3) }}</span></div><p v-if="item.heading" class="m-0 mt-0.5 text-[11px] leading-4 text-[var(--agent-text-muted)]">{{ item.heading }}</p></li></ol></section>
          <section v-if="props.selectedStep.error" class="rounded-md bg-[var(--agent-error-bg)] p-3.5"><p class="m-0 text-xs font-bold text-[var(--agent-error-text)]">错误信息</p><p class="m-0 mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-[var(--agent-error-text)]">{{ props.selectedStep.error }}</p></section>
          <details class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><summary class="cursor-pointer text-xs font-bold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">查看调用参数</summary><pre class="m-0 mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--agent-surface-muted)] p-3 font-mono text-[11px] leading-5 text-[var(--agent-text)]">{{ formatJson(props.selectedStep.input) }}</pre></details>
          <details v-if="props.selectedStep.output !== undefined" class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><summary class="cursor-pointer text-xs font-bold text-[var(--agent-text-muted)] hover:text-[var(--agent-text)]">查看原始结果</summary><pre class="m-0 mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--agent-surface-muted)] p-3 font-mono text-[11px] leading-5 text-[var(--agent-text)]">{{ formatJson(props.selectedStep.output) }}</pre></details>
        </template>
      </div>
      <div v-else class="grid gap-3">
        <section class="rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-4"><p class="m-0 text-xs font-bold text-[var(--agent-text-muted)]">当前研究问题</p><p class="m-0 mt-2 whitespace-pre-wrap text-sm font-medium leading-7 text-[var(--agent-text)]">{{ props.promptPreview.currentMessage || '发送问题后显示。' }}</p></section>
        <section class="flex items-center justify-between rounded-md border border-[var(--agent-border)] bg-[var(--agent-surface)] p-3.5"><span class="text-xs font-bold text-[var(--agent-text-muted)]">上下文消息数</span><strong class="font-mono text-xl text-[var(--agent-text)]">{{ props.promptPreview.historyMessageCount }}</strong></section>
      </div>
    </div>
  </section>
</template>
