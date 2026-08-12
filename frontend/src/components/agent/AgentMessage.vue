<script setup lang="ts">
import { computed } from 'vue';

import {
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup
} from '@/components/ui/message';
import MarkdownMessage from '../chat/MarkdownMessage.vue';

const props = withDefaults(defineProps<{
  message: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    status: 'streaming' | 'complete' | 'error';
    createdAt?: string;
  };
  streamingPlaceholder?: string;
}>(), {
  streamingPlaceholder: ''
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
        <slot />
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
