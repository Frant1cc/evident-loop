<script setup lang="ts">
import { computed } from 'vue';

import MarkdownMessage from '../chat/MarkdownMessage.vue';

const props = withDefaults(defineProps<{
  message: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    status: 'streaming' | 'complete' | 'error';
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
</script>

<template>
  <article
    class="max-w-3xl py-1"
    :class="message.role === 'user' ? 'justify-self-end rounded-md bg-[var(--agent-selected-bg)] px-4 py-3' : ''"
  >
    <span class="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">
      {{ message.role === 'user' ? 'You' : 'EvidentLoop' }}
    </span>
    <MarkdownMessage
      :content="renderedContent"
      :streaming="message.status === 'streaming' && Boolean(message.content)"
      @citation="emit('citation', $event)"
    />
    <slot />
  </article>
</template>
