<script setup lang="ts">
import { computed } from 'vue';
import AgentMessage from '../agent/AgentMessage.vue';
import { useMessageAutoScroll } from '../../composables/useMessageAutoScroll';
import type { ChatMessage } from '../../types/chat';

const props = defineProps<{
  conversationId?: string;
  messages: ChatMessage[];
}>();

const messageSignature = computed(() => {
  const lastMessage = props.messages[props.messages.length - 1];
  return lastMessage
    ? `${props.messages.length}:${lastMessage.id}:${lastMessage.content.length}:${lastMessage.status}`
    : 'empty';
});
const { handleScroll, scrollContainer } = useMessageAutoScroll(
  () => props.conversationId,
  () => messageSignature.value
);
</script>

<template>
  <div ref="scrollContainer" class="grid min-h-0 content-start gap-6 overflow-auto px-5 py-6" aria-live="polite" @scroll="handleScroll">
    <AgentMessage v-for="message in messages" :key="message.id" :message="message" />
  </div>
</template>
