<script setup lang="ts">
import ChatInputArea from './ChatInputArea.vue';
import ChatMessages from './ChatMessages.vue';
import type { ChatMessage } from '../../types/chat';

const model = defineModel<string>({ required: true });

defineProps<{
  messages: ChatMessage[];
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  send: [];
}>();
</script>

<template>
  <section class="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] bg-[var(--agent-surface)]">
    <ChatMessages :messages="messages" />
    <ChatInputArea v-model="model" :loading="loading" :error="error" @send="emit('send')" />
  </section>
</template>
