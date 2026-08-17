<script setup lang="ts">
import { PhCaretDown, PhPaperclip } from '@phosphor-icons/vue';
import { computed } from 'vue';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup
} from '@/components/ui/message';
import MarkdownMessage from '../conversation/MarkdownMessage.vue';

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
  auxiliaryCount?: number;
}>(), {
  streamingPlaceholder: '',
  auxiliaryLabel: '附件',
  auxiliaryCount: 0
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

const hasAuxiliary = computed(() => props.auxiliaryCount > 0);
const auxiliaryCountLabel = computed(() => {
  const count = props.auxiliaryCount;
  return count > 99 ? '99+' : String(count);
});
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
          class="agent-auxiliary group/auxiliary mt-3 rounded-lg border border-dashed border-border/70 bg-muted/30 transition-colors hover:border-border data-[state=open]:border-border data-[state=open]:bg-muted/40"
        >
          <CollapsibleTrigger
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            :aria-label="`${auxiliaryLabel}（${auxiliaryCount} 项，默认折叠，点击展开）`"
          >
            <PhPaperclip :size="14" weight="bold" aria-hidden="true" />
            <span class="font-medium">{{ auxiliaryLabel }}</span>
            <span
              class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-background px-1.5 font-mono text-[10px] font-semibold tabular-nums text-muted-foreground ring-1 ring-inset ring-border"
            >
              {{ auxiliaryCountLabel }}
            </span>
            <PhCaretDown
              :size="12"
              weight="bold"
              class="ml-auto transition-transform duration-200 group-data-[state=open]/auxiliary:rotate-180"
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
</style>
