<script setup lang="ts">
import { ref } from 'vue';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import type { ResearchNote, ResearchPromptPreview, ResearchStep } from '../../types/research';

type DetailsTab = 'notes' | 'memory' | 'tool' | 'prompt';

const props = defineProps<{
  notes: ResearchNote[];
  promptPreview: ResearchPromptPreview;
  selectedStep?: ResearchStep;
}>();

const activeTab = defineModel<DetailsTab>('activeTab', { required: true });

const emit = defineEmits<{
  createNote: [content: string];
  deleteNote: [note: ResearchNote];
}>();

const noteContent = ref('');

function saveNote() {
  const content = noteContent.value.trim();
  if (!content) return;
  emit('createNote', content);
  noteContent.value = '';
}

function statusLabel(status: ResearchStep['status']) {
  return status === 'complete' ? '已完成' : status === 'running' ? '执行中' : '失败';
}

function statusVariant(status: ResearchStep['status']) {
  return status === 'error' ? 'destructive' as const : 'secondary' as const;
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

function claimCoverage(value: unknown) {
  const record = toRecord(value);
  if (!record || typeof record.totalClaimCount !== 'number') return undefined;
  return {
    covered: typeof record.coveredClaimCount === 'number' ? record.coveredClaimCount : 0,
    total: record.totalClaimCount,
    score: typeof record.coverageScore === 'number' ? record.coverageScore : 0,
    uncovered: Array.isArray(record.uncoveredClaims)
      ? record.uncoveredClaims.filter((item): item is string => typeof item === 'string')
      : []
  };
}

function compressionStats(step: ResearchStep) {
  if (step.type !== 'context') return undefined;
  const output = toRecord(step.output);
  const input = toRecord(step.input);
  const before = output?.beforeTokens ?? input?.estimatedTokens;
  const after = output?.afterTokens;
  const saved = output?.savedTokens;
  const threshold = output?.thresholdTokens ?? input?.thresholdTokens;
  if (typeof before !== 'number') return undefined;
  return {
    before,
    after: typeof after === 'number' ? after : undefined,
    saved: typeof saved === 'number' ? saved : undefined,
    threshold: typeof threshold === 'number' ? threshold : undefined
  };
}

function formatTokens(value: number) {
  return Math.round(value).toLocaleString('zh-CN');
}

function toRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
</script>

<template>
  <Tabs v-model="activeTab" class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0 bg-card">
    <div class="border-b border-border px-3 py-2.5">
      <TabsList class="w-full">
        <TabsTrigger value="notes">笔记</TabsTrigger>
        <TabsTrigger value="memory">记忆</TabsTrigger>
        <TabsTrigger value="tool">详情</TabsTrigger>
        <TabsTrigger value="prompt">问题</TabsTrigger>
      </TabsList>
    </div>

    <div class="app-scrollbar min-h-0 overflow-auto p-3">
      <TabsContent value="notes" class="m-0 grid gap-3">
        <Textarea v-model="noteContent" rows="4" class="resize-y" placeholder="记录研究结论或待办" />
        <Button variant="secondary" size="sm" class="justify-self-start" @click="saveNote">添加笔记</Button>
        <article v-for="note in notes" :key="note.id" class="rounded-lg border border-border bg-background p-3">
          <p class="m-0 whitespace-pre-wrap text-sm leading-6 text-foreground">{{ note.content }}</p>
          <div class="mt-2.5 flex items-center justify-between gap-3">
            <span class="text-[11px] text-muted-foreground">{{ formatTime(note.updatedAt) }}</span>
            <Button variant="ghost" size="xs" class="text-destructive" :aria-label="`删除笔记`" @click="emit('deleteNote', note)">删除</Button>
          </div>
        </article>
        <p v-if="!notes.length" class="m-0 rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">还没有研究笔记。</p>
      </TabsContent>

      <TabsContent value="memory" class="m-0 grid gap-3">
        <section class="rounded-lg border border-border bg-background p-3">
          <p class="m-0 text-xs font-semibold text-muted-foreground">研究主题</p>
          <p class="m-0 mt-1.5 text-sm font-medium leading-6 text-foreground">{{ promptPreview.topic || '将在首次提问后生成' }}</p>
        </section>
        <section class="rounded-lg border border-border bg-background p-3">
          <p class="m-0 text-xs font-semibold text-muted-foreground">摘要记忆</p>
          <p class="m-0 mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-foreground">{{ promptPreview.summary || '当前使用最近对话作为上下文。' }}</p>
        </section>
        <section class="flex items-center justify-between rounded-lg border border-border bg-background p-3">
          <span class="text-xs font-semibold text-muted-foreground">进入上下文的历史消息</span>
          <strong class="font-mono text-xl tabular-nums text-foreground">{{ promptPreview.historyMessageCount }}</strong>
        </section>
      </TabsContent>

      <TabsContent value="tool" class="m-0 grid gap-3">
        <p v-if="!selectedStep" class="m-0 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm leading-6 text-muted-foreground">请先从“过程”中选择一个步骤。</p>
        <template v-else>
          <section class="rounded-lg border border-border bg-background p-3">
            <div class="flex items-start justify-between gap-3">
              <p class="m-0 text-sm font-medium leading-5 text-foreground">{{ selectedStep.title }}</p>
              <Badge :variant="statusVariant(selectedStep.status)" class="shrink-0">{{ statusLabel(selectedStep.status) }}</Badge>
            </div>
            <p class="m-0 mt-2 text-[11px] text-muted-foreground">{{ formatTime(selectedStep.startedAt) }}</p>
          </section>
          <section v-if="compressionStats(selectedStep)" class="rounded-lg border border-border bg-background p-3">
            <p class="m-0 text-xs font-semibold text-muted-foreground">Token 压缩</p>
            <div class="mt-2 grid grid-cols-2 gap-2">
              <div class="rounded-md bg-muted px-3 py-2">
                <p class="m-0 text-[10px] text-muted-foreground">压缩前</p>
                <strong class="font-mono text-sm tabular-nums text-foreground">{{ formatTokens(compressionStats(selectedStep)!.before) }}</strong>
              </div>
              <div class="rounded-md bg-muted px-3 py-2">
                <p class="m-0 text-[10px] text-muted-foreground">压缩后</p>
                <strong class="font-mono text-sm tabular-nums text-foreground">{{ compressionStats(selectedStep)!.after === undefined ? '处理中' : formatTokens(compressionStats(selectedStep)!.after!) }}</strong>
              </div>
            </div>
            <p v-if="compressionStats(selectedStep)!.saved !== undefined" class="m-0 mt-2 text-xs text-muted-foreground">已节省 <strong class="font-mono tabular-nums text-foreground">{{ formatTokens(compressionStats(selectedStep)!.saved!) }}</strong> Tokens</p>
            <p v-if="compressionStats(selectedStep)!.threshold !== undefined" class="m-0 mt-1 text-[11px] text-muted-foreground">触发阈值：{{ formatTokens(compressionStats(selectedStep)!.threshold!) }} Tokens</p>
          </section>
          <section v-if="inputSummary(selectedStep.input)" class="rounded-lg border border-border bg-background p-3">
            <p class="m-0 text-xs font-semibold text-muted-foreground">调用内容</p>
            <p class="m-0 mt-1.5 break-words text-[13px] font-medium leading-6 text-foreground">{{ inputSummary(selectedStep.input) }}</p>
          </section>
          <section v-if="claimCoverage(selectedStep.output)" class="rounded-lg border border-border bg-background p-3">
            <div class="flex items-center justify-between gap-3">
              <p class="m-0 text-xs font-semibold text-foreground">问题覆盖</p>
              <span class="font-mono text-xs font-semibold tabular-nums text-foreground">{{ claimCoverage(selectedStep.output)?.covered }}/{{ claimCoverage(selectedStep.output)?.total }} · {{ (claimCoverage(selectedStep.output)?.score ?? 0).toFixed(2) }}</span>
            </div>
            <ul v-if="claimCoverage(selectedStep.output)?.uncovered.length" class="m-0 mt-2 list-disc pl-4 text-xs leading-5 text-destructive">
              <li v-for="claim in claimCoverage(selectedStep.output)?.uncovered" :key="claim">未覆盖：{{ claim }}</li>
            </ul>
          </section>
          <section v-if="resultItems(selectedStep.output).length" class="rounded-lg border border-border bg-background p-3">
            <p class="m-0 mb-2.5 text-xs font-semibold text-foreground">命中来源 · {{ resultItems(selectedStep.output).length }}</p>
            <ol class="m-0 grid list-none gap-2 p-0">
              <li v-for="(item, index) in resultItems(selectedStep.output)" :key="`${item.title}-${item.heading}-${index}`" class="rounded-md bg-muted px-3 py-2">
                <div class="flex items-start justify-between gap-2">
                  <strong class="text-xs leading-5 text-foreground">{{ item.title }}</strong>
                  <span v-if="item.score !== undefined" class="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{{ item.score.toFixed(3) }}</span>
                </div>
                <p v-if="item.heading" class="m-0 mt-0.5 text-[11px] leading-4 text-muted-foreground">{{ item.heading }}</p>
              </li>
            </ol>
          </section>
          <section v-if="selectedStep.error" class="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            <p class="m-0 text-xs font-semibold text-destructive">错误信息</p>
            <p class="m-0 mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-destructive">{{ selectedStep.error }}</p>
          </section>
          <Collapsible class="rounded-lg border border-border bg-background p-3">
            <CollapsibleTrigger class="cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">查看调用参数</CollapsibleTrigger>
            <CollapsibleContent>
              <pre class="m-0 mt-2.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[11px] leading-5 text-foreground">{{ formatJson(selectedStep.input) }}</pre>
            </CollapsibleContent>
          </Collapsible>
          <Collapsible v-if="selectedStep.output !== undefined" class="rounded-lg border border-border bg-background p-3">
            <CollapsibleTrigger class="cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">查看原始结果</CollapsibleTrigger>
            <CollapsibleContent>
              <pre class="m-0 mt-2.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[11px] leading-5 text-foreground">{{ formatJson(selectedStep.output) }}</pre>
            </CollapsibleContent>
          </Collapsible>
        </template>
      </TabsContent>

      <TabsContent value="prompt" class="m-0 grid gap-3">
        <section class="rounded-lg border border-border bg-background p-3">
          <p class="m-0 text-xs font-semibold text-muted-foreground">当前研究问题</p>
          <p class="m-0 mt-2 whitespace-pre-wrap text-sm font-medium leading-7 text-foreground">{{ promptPreview.currentMessage || '发送问题后显示。' }}</p>
        </section>
        <section class="flex items-center justify-between rounded-lg border border-border bg-background p-3">
          <span class="text-xs font-semibold text-muted-foreground">上下文消息数</span>
          <strong class="font-mono text-xl tabular-nums text-foreground">{{ promptPreview.historyMessageCount }}</strong>
        </section>
      </TabsContent>
    </div>
  </Tabs>
</template>
