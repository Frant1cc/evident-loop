<script setup lang="ts">
import { PhCaretDown, PhCircleNotch, PhPaperclip, PhWarning } from '@phosphor-icons/vue';
import { computed } from 'vue';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup
} from '@/components/ui/message';
import MarkdownMessage from '../conversation/MarkdownMessage.vue';

type AuxiliaryStatus = 'idle' | 'running' | 'complete' | 'error';

const props = withDefaults(defineProps<{
  message: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    status: 'streaming' | 'complete' | 'error';
    createdAt?: string;
  };
  streamingPlaceholder?: string;
  auxiliaryLabel?: string;
  auxiliaryActivity?: string;
  auxiliaryCount?: number;
  auxiliaryStatus?: AuxiliaryStatus;
}>(), {
  streamingPlaceholder: '',
  auxiliaryLabel: '附件',
  auxiliaryActivity: '',
  auxiliaryCount: 0,
  auxiliaryStatus: 'idle'
});

const emit = defineEmits<{
  citation: [key: string];
}>();

const renderedContent = computed(() =>
  props.message.content || (props.message.status === 'streaming' ? props.streamingPlaceholder : '')
);

const time = computed(() => {
  if (!props.message.createdAt) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(props.message.createdAt));
});

const effectiveAuxiliaryStatus = computed<AuxiliaryStatus>(() => props.auxiliaryStatus);

const hasAuxiliary = computed(() => {
  if (props.auxiliaryCount > 0) return true;
  const status = effectiveAuxiliaryStatus.value;
  return status === 'running' || status === 'error';
});

const isAuxiliaryRunning = computed(() => effectiveAuxiliaryStatus.value === 'running');
const isAuxiliaryError = computed(() => effectiveAuxiliaryStatus.value === 'error');

const auxiliaryPrimaryText = computed(() => {
  if (isAuxiliaryRunning.value && props.auxiliaryActivity) return props.auxiliaryActivity;
  return props.auxiliaryLabel;
});

const auxiliaryCountLabel = computed(() => {
  const count = props.auxiliaryCount;
  return count > 99 ? '99+' : String(count);
});

const auxiliaryAriaLabel = computed(() => {
  const text = auxiliaryPrimaryText.value;
  const count = props.auxiliaryCount;
  const status = effectiveAuxiliaryStatus.value;
  const stateLabel =
    status === 'running' ? '处理中' :
    status === 'error' ? '出错' :
    '已折叠';
  const countSuffix = count > 0 ? `（${count} 项）` : '';
  return `${text} ${countSuffix}，${stateLabel}，点击展开`;
});

const triggerClass = computed(() => [
  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
  isAuxiliaryRunning.value
    ? 'text-foreground'
    : isAuxiliaryError.value
      ? 'text-destructive'
      : 'text-muted-foreground hover:text-foreground'
]);
</script>

<template>
  <Message :align="message.role === 'user' ? 'end' : 'start'" tabindex="0" class="outline-none">
    <MessageGroup class="relative pb-5" :class="message.role === 'user' ? 'max-w-[82%] items-end' : 'max-w-[min(100%,48rem)]'">
      <time
        v-if="time"
        class="pointer-events-none absolute bottom-0 z-10 whitespace-nowrap px-0.5 text-[11px] leading-[18px] text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-visible/message:opacity-100"
        :class="message.role === 'user' ? 'right-0' : 'left-0'"
        aria-hidden="true"
      >
        {{ time }}
      </time>

      <MessageContent
        class="rounded-2xl"
        :class="message.role === 'user'
          ? 'w-fit rounded-br-md bg-muted px-4 py-3 text-foreground dark:bg-muted/80'
          : 'rounded-tl-md border border-border bg-card px-4 py-3.5 text-card-foreground shadow-xs dark:border-white/[0.06] dark:bg-card/75 dark:shadow-none'"
      >
        <MarkdownMessage
          :content="renderedContent"
          :streaming="message.status === 'streaming' && Boolean(message.content)"
          @citation="emit('citation', $event)"
        />

        <Collapsible
          v-if="hasAuxiliary"
          :default-open="false"
          class="agent-auxiliary group/auxiliary mt-3 rounded-lg border border-dashed bg-muted/30 transition-colors"
          :class="isAuxiliaryRunning
            ? 'border-primary/30 data-[state=open]:border-primary/40 data-[state=open]:bg-primary/[0.04]'
            : isAuxiliaryError
              ? 'border-destructive/40 data-[state=open]:border-destructive/50 data-[state=open]:bg-destructive/[0.04]'
              : 'border-border/70 hover:border-border data-[state=open]:border-border data-[state=open]:bg-muted/40'"
        >
          <CollapsibleTrigger
            :class="triggerClass"
            :aria-label="auxiliaryAriaLabel"
          >
            <span class="grid size-[14px] shrink-0 place-items-center" aria-hidden="true">
              <PhCircleNotch
                v-if="isAuxiliaryRunning"
                :size="14"
                weight="bold"
                class="animate-spin"
              />
              <PhWarning
                v-else-if="isAuxiliaryError"
                :size="14"
                weight="fill"
              />
              <PhPaperclip
                v-else
                :size="14"
                weight="bold"
              />
            </span>
            <span class="truncate font-medium" :title="auxiliaryPrimaryText">{{ auxiliaryPrimaryText }}</span>
            <span
              v-if="auxiliaryCount > 0"
              class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-background px-1.5 font-mono text-[10px] font-semibold tabular-nums ring-1 ring-inset"
              :class="isAuxiliaryError ? 'text-destructive ring-destructive/30' : 'text-muted-foreground ring-border'"
            >
              {{ auxiliaryCountLabel }}
            </span>
            <PhCaretDown
              :size="12"
              weight="bold"
              class="ml-auto shrink-0 transition-transform duration-200 group-data-[state=open]/auxiliary:rotate-180"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent class="agent-auxiliary__content px-2 pb-2 pt-1">
            <slot name="auxiliary" />
          </CollapsibleContent>
        </Collapsible>
      </MessageContent>

      <MessageFooter v-if="message.status !== 'complete'" class="gap-1.5 px-0" :class="message.status === 'error' ? 'text-destructive' : ''">
        <span v-if="message.status === 'streaming'" class="inline-flex items-center gap-1.5">
          <span class="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
          正在生成
        </span>
        <span v-else>回复未完成</span>
      </MessageFooter>
    </MessageGroup>
  </Message>
</template>

<style scoped>
.agent-auxiliary :deep(.word-artifact-card) {
  margin-top: 0.5rem;
}

.agent-auxiliary :deep(.word-artifact-card:first-child) {
  margin-top: 0;
}

@media (prefers-reduced-motion: reduce) {
  .agent-auxiliary :deep(.animate-spin) {
    animation: none;
  }
}
</style>
