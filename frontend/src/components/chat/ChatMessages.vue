<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import MarkdownMessage from './MarkdownMessage.vue';
import type { ChatMessage } from '../../types/chat';

const props = defineProps<{
  messages: ChatMessage[];
}>();

const scrollContainer = ref<HTMLElement | null>(null);
const shouldAutoScroll = ref(true);
const bottomThreshold = 20;
const messageSignature = computed(() => {
  return props.messages.map((message) => `${message.role}:${message.content}`).join('\n');
});

watch(messageSignature, async () => {
  if (!shouldAutoScroll.value) return;

  await nextTick();
  scrollContainer.value?.scrollTo({
    top: scrollContainer.value.scrollHeight,
    behavior: 'smooth'
  });
});

function handleScroll() {
  const container = scrollContainer.value;

  if (!container) return;

  const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  shouldAutoScroll.value = distanceToBottom <= bottomThreshold;
}
</script>

<template>
  <div ref="scrollContainer" class="grid min-h-0 content-start gap-6 overflow-auto px-5 py-6" aria-live="polite" @scroll="handleScroll">
    <article
      v-for="(message, index) in messages"
      :key="index"
      class="max-w-3xl py-1"
      :class="message.role === 'user' ? 'justify-self-end rounded-md bg-[var(--agent-selected-bg)] px-4 py-3' : ''"
    >
      <span
        v-if="message.role === 'assistant'"
        class="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]"
      >
        EvidentLoop
      </span>
      <span v-else class="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--agent-text-muted)]">You</span>
      <MarkdownMessage :content="message.content" />
    </article>
  </div>
</template>
